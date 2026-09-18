#!/usr/bin/env node
/**
 * Drain the upload portal's queue: copy a submitted folder into the NSDS Drive, one file at a time.
 *
 *   node tools/nsds_ingest.mjs                 # every pending submission
 *   node tools/nsds_ingest.mjs --dry-run       # say what would move, touch nothing
 *   node tools/nsds_ingest.mjs --only <key>    # one submission
 *
 * The portal (videoreview/upload.html) writes one immutable `submission.json` per submission into
 * `NSDS/Media/_uploads/<submissionKey>/`. This reads those, moves the bytes, and writes
 * `status.json` beside each one. Zero dependencies; rclone and python3 do the work.
 *
 * Three decisions worth keeping:
 *
 * 1. ONE FILE AT A TIME, deleted after each. tools/nsds_transfer.sh fetches an entire show before
 *    uploading anything, which means peak disk equals the whole show — 108 GiB for the three 2026
 *    shows. Per-file keeps it at one tape (~10 GB) plus change, which is what makes this runnable
 *    on a small disk, and later on a small VPS.
 *
 * 2. RESUME IS DERIVED, NEVER READ FROM status.json. On every pass the destination folders are
 *    listed and the remaining set is `manifest - {dest already there at the manifest's size}`.
 *    status.json is a progress cache for humans; deleting it loses nothing but the log. That is
 *    the same shape as youtube.csv versus Drive, and it means a killed run, a rebuilt machine and
 *    a file copied in by hand all converge.
 *
 * 3. A DRIVE SOURCE MOVES NO BYTES. It is a server-side copy, the trick
 *    tools/nsds_transfer.sh's upload_junesf() already uses, so a Drive-sourced show costs nothing
 *    and finishes in minutes.
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rclone, inFolder, REMOTE, listTree } from './lib/tapes.mjs'
// One definition of where Media lives; SECURITY.md is explicit that ids are credentials, so
// there is no reason to write a second copy of one into another tracked file.
import { MEDIA_ROOT_ID } from '../videoreview/shows.js'

const HERE = dirname(fileURLToPath(import.meta.url))
// Env-overridable for the same reason the rclone/ffmpeg paths in lib/tapes.mjs are: a launchd
// agent needs an absolute path, and a CI runner has python3 on PATH and nothing at this one.
const PYTHON = process.env.NSDS_PYTHON || '/usr/bin/python3'
const FETCH = join(HERE, 'nsds_fetch.py')
const STAGING = process.env.NSDS_STAGING || join(homedir(), 'NSDS-transfer-staging', 'ingest')

const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const onlyKey = (() => {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--only')
  return i === -1 ? null : argv[i + 1]
})()

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
const log = (...a) => console.log(`[${ts()}]`, ...a)
const human = n => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(0)} MB`)

/** `_uploads` is a sibling of the year folders, so show discovery can never see it. */
async function uploadsRootId() {
  if (process.env.NSDS_UPLOADS_FOLDER_ID) return process.env.NSDS_UPLOADS_FOLDER_ID
  const raw = await rclone(['lsjson', ...inFolder(MEDIA_ROOT_ID), '--dirs-only', `${REMOTE}:`], { quiet: true })
  const hit = JSON.parse(raw).find(e => e.Name === '_uploads')
  if (!hit) throw new Error('no _uploads folder under NSDS/Media — nothing has been submitted yet')
  return String(hit.ID).split('\t')[0]
}

async function readJson(rootId, path) {
  try { return JSON.parse(await rclone(['cat', ...inFolder(rootId), `${REMOTE}:${path}`], { quiet: true })) }
  catch { return null }
}

async function writeJson(rootId, path, value) {
  if (dryRun) return
  const tmp = join(tmpdir(), `nsds-ingest-${process.pid}.json`)
  await writeFile(tmp, JSON.stringify(value, null, 2))
  await rclone(['copyto', tmp, `${REMOTE},root_folder_id=${rootId}:${path}`], { quiet: true })
  await rm(tmp, { force: true })
}

/** What is already at the destination, keyed `bucket/name` -> size. Two-pass stabilised. */
async function destIndex(show) {
  const index = new Map()
  for (const [bucket, id] of [['tapes', show.tapesFolderId], ['photos', show.photosFolderId], ['extras', show.extrasFolderId]]) {
    if (!id) continue
    for (const e of await listTree(id, 3)) {
      if (!e.IsDir) index.set(`${bucket}/${e.Path}`, e.Size)
    }
  }
  return index
}

function remaining(manifest, index) {
  return (manifest || []).filter(row => {
    const have = index.get(row.dest)
    // Size is the only cheap check, and it is the same one rclone's --size-only verify uses.
    return have === undefined || (row.bytes && have !== row.bytes)
  })
}

const run = (cmd, argv) => new Promise((resolve, reject) => {
  const child = spawn(cmd, argv, { stdio: ['ignore', 'inherit', 'inherit'] })
  child.on('error', reject)
  child.on('close', code => (code === 0 ? resolve() : reject(new Error(`${cmd.split('/').pop()} exited ${code}`))))
})

const bucketFolderId = (show, dest) => ({
  tapes: show.tapesFolderId, photos: show.photosFolderId, extras: show.extrasFolderId,
}[dest.split('/')[0]])

/** Dropbox: download to disk, upload, verify, delete. One file's worth of disk at a time. */
async function moveFromDropbox(sub, row) {
  const folderId = bucketFolderId(sub.show, row.dest)
  const name = row.dest.split('/').slice(1).join('/')
  const local = join(STAGING, sub.submissionKey, name)
  await mkdir(dirname(local), { recursive: true })

  await run(PYTHON, [FETCH, '--fetch-one', '--link', sub.source.link,
                     '--href', row.href, '--bytes', String(row.bytes), '--dest', local])
  const got = (await stat(local)).size
  if (row.bytes && got !== row.bytes) throw new Error(`${name}: got ${got} bytes, manifest says ${row.bytes}`)

  await rclone(['copyto', local, `${REMOTE},root_folder_id=${folderId}:${name}`,
                '--drive-chunk-size', '64M', '--drive-stop-on-upload-limit',
                '--retries', '5', '--low-level-retries', '20', '--timeout', '3m'])
  await rclone(['check', local, `${REMOTE},root_folder_id=${folderId}:${name}`, '--size-only'], { quiet: true })
  await rm(local, { force: true })
}

/** Drive: server-side, so no bytes touch this machine. */
async function moveFromDrive(sub, row) {
  const folderId = bucketFolderId(sub.show, row.dest)
  const name = row.dest.split('/').slice(1).join('/')
  const srcId = (/\/folders\/([A-Za-z0-9_-]+)/.exec(sub.source.link) || [])[1]
  if (!srcId) throw new Error('could not read a folder id out of the source link')
  await rclone(['copyto', `${REMOTE},root_folder_id=${srcId}:${row.src.replace(/^\//, '')}`,
                `${REMOTE},root_folder_id=${folderId}:${name}`,
                '--drive-server-side-across-configs', '--drive-stop-on-upload-limit'])
}

async function drain(rootId, key) {
  const sub = await readJson(rootId, `${key}/submission.json`)
  if (!sub) { log(`${key}: no submission.json — skipping`); return }
  if (!sub.show?.tapesFolderId) { log(`${key}: submission has no destination ids — skipping`); return }

  const index = await destIndex(sub.show)
  const todo = remaining(sub.manifest, index)
  const done = (sub.manifest || []).length - todo.length
  log(`${sub.show.folderName}: ${sub.manifest.length} files, ${done} already there, ${todo.length} to go`)

  if (dryRun) {
    for (const row of todo) console.log(`  would copy  ${row.src}  ->  ${row.dest}  (${human(row.bytes)})`)
    return
  }
  if (!todo.length) {
    await writeJson(rootId, `${key}/status.json`, { state: 'complete', filesDone: done, filesTotal: sub.manifest.length, heartbeatAt: new Date().toISOString() })
    return
  }

  const status = {
    state: 'copying', workerId: `${process.env.USER || 'worker'}@${process.pid}`,
    filesTotal: sub.manifest.length, filesDone: done, errors: [],
    startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
  }
  await writeJson(rootId, `${key}/status.json`, status)

  for (const row of todo) {
    log(`  ▶ ${row.dest}  (${human(row.bytes)})`)
    try {
      if (sub.source.kind === 'drive') await moveFromDrive(sub, row)
      else await moveFromDropbox(sub, row)
      status.filesDone++
    } catch (err) {
      log(`  ✗ ${row.dest}: ${err.message}`)
      status.errors.push({ dest: row.dest, error: err.message, at: new Date().toISOString() })
    }
    status.heartbeatAt = new Date().toISOString()
    await writeJson(rootId, `${key}/status.json`, status)
  }

  status.state = status.errors.length ? 'incomplete' : 'complete'
  await writeJson(rootId, `${key}/status.json`, status)
  log(`${sub.show.folderName}: ${status.filesDone}/${status.filesTotal} done${status.errors.length ? `, ${status.errors.length} failed` : ''}`)
}

async function main() {
  const rootId = await uploadsRootId()
  const dirs = JSON.parse(await rclone(['lsjson', ...inFolder(rootId), '--dirs-only', `${REMOTE}:`], { quiet: true }))
  const keys = dirs.map(d => d.Name).filter(n => !onlyKey || n === onlyKey).sort()
  if (!keys.length) { log('nothing submitted'); return }
  for (const key of keys) {
    try { await drain(rootId, key) }
    catch (err) { log(`${key}: FATAL ${err.message}`) }
  }
}

main().catch(err => { console.error(`[${ts()}] FATAL ${err.message}`); process.exit(1) })
