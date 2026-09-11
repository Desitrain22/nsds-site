#!/usr/bin/env node
/**
 * Keep every set tape mirrored on YouTube (unlisted) and write a youtube.csv into each show's
 * Drive folder so the site can embed them. Idempotent; meant to run daily from launchd.
 *
 *   node tools/youtube-sync.mjs --auth          # one-time browser consent as hello@notsodailystandup.com
 *   node tools/youtube-sync.mjs                 # sync: upload what's missing, up to the daily quota
 *   node tools/youtube-sync.mjs --dry-run       # inventory + what would upload, no changes
 *   node tools/youtube-sync.mjs --install-cron  # launchd job, daily 03:30
 *   node tools/youtube-sync.mjs --stage-all     # transcode everything missing, NO upload, into
 *                                                 ~/NSDS-youtube-upload/DRAG-ME/ named by title
 *   node tools/youtube-sync.mjs --adopt         # match the channel's uploads to tapes by title
 *   node tools/youtube-sync.mjs --retitle       # fix titles after tapes were renamed in Drive
 *                                                 and write youtube.csv -- for tapes you dragged
 *                                                 into youtube.com/upload by hand (no quota)
 *
 * WHY A QUOTA CAP
 * YouTube Data API: videos.insert costs 1,600 of a project's default 10,000 daily units, so at
 * most 6 uploads/day. The sync stops at MAX_PER_RUN or the first quotaExceeded and picks up
 * tomorrow. Everything it has done is recorded in the per-show youtube.csv, so re-runs are safe.
 *
 * AUTH
 * Needs a Google Cloud OAuth client (Desktop app) with the YouTube Data API enabled, saved at
 * ~/.config/nsds/youtube-client.json (the JSON the console gives you). Consent is stored at
 * ~/.config/nsds/youtube-token.json. Publish the consent screen (or make it Internal on the
 * Workspace) so the refresh token doesn't expire after 7 days -- a cron can't re-consent.
 *
 * WHAT IT WRITES TO DRIVE
 * <show folder>/youtube.csv with one row per tape:
 *   file_id,filename,performer,youtube_id,youtube_url,title,uploaded_at
 * Keyed on Drive file id, so it survives the folder reorganisation. Apps Script reads it.
 *
 * Zero dependencies. Nothing here touches the 4K masters except to read them.
 */

import { createServer } from 'node:http'
import { readFile, writeFile, mkdir, stat, unlink, open } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { rclone, inFolder, REMOTE, discoverShows, transcode } from './lib/tapes.mjs'

const CFG_DIR = join(homedir(), '.config', 'nsds')
const CLIENT_FILE = join(CFG_DIR, 'youtube-client.json')
const TOKEN_FILE = join(CFG_DIR, 'youtube-token.json')
const LOG_DIR = join(homedir(), 'Library', 'Logs', 'nsds')
const STAGE_DIR = join(homedir(), 'NSDS-youtube-upload')

// Where the show folders live. The tree is being reorganised into Media/<year>/<show>/...;
// add the new year roots here when they exist. Ids survive moves, names don't.
// Year folders under NSDS/Media, in upload priority order: the current year's shows first, then
// the 2025 and 2024 archives (the daily quota allows ~6 uploads, so order is what gets seen first).
const ROOTS = [
  '1TQeR5rmpyZEsvKAl-2w19qW03w-UeaL1',   // Media / 2026
  '1m7f8RKgsIeoVK70SeiWSuFx3Rptbjdep',   // Media / 2025
  '1_Pc1lqiT4A-7a_Omnqiqw7Y5_IGqhdNz',   // Media / 2024
]
const CHANNEL_HINT = 'Tech Comedy Show (hello@notsodailystandup.com)'
const MAX_PER_RUN = 6
const SCOPE = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly'
const CSV_NAME = 'youtube.csv'
const CSV_HEADER = 'file_id,filename,performer,youtube_id,youtube_url,title,uploaded_at'

const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const DRAG_DIR = join(STAGE_DIR, 'DRAG-ME')
const titleFor = (tape, show) => `${tape.performer} — ${show.label}`
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
const log = (...a) => console.log(`[${ts()}]`, ...a)

// ----------------------------------------------------------------------------- oauth --

async function loadClient() {
  let raw
  try { raw = JSON.parse(await readFile(CLIENT_FILE, 'utf8')) }
  catch { throw new Error(`no OAuth client at ${CLIENT_FILE} — see the header of this file`) }
  const c = raw.installed || raw.web || raw
  if (!c.client_id || !c.client_secret) throw new Error(`${CLIENT_FILE} has no client_id/client_secret`)
  return { id: c.client_id, secret: c.client_secret }
}

async function authorize() {
  const client = await loadClient()
  const port = 8765 + Math.floor(Math.random() * 1000)
  const redirect = `http://127.0.0.1:${port}/`
  const state = randomBytes(12).toString('hex')

  const code = await new Promise((resolve, reject) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url, redirect)
      if (u.searchParams.get('state') !== state) { res.writeHead(400).end('bad state'); return }
      if (u.searchParams.get('error')) { res.writeHead(200).end('Denied. You can close this tab.'); srv.close(); return reject(new Error(u.searchParams.get('error'))) }
      res.writeHead(200, { 'content-type': 'text/html' }).end('<h2>Connected. You can close this tab.</h2>')
      srv.close(); resolve(u.searchParams.get('code'))
    })
    srv.listen(port, '127.0.0.1', () => {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      url.search = new URLSearchParams({
        client_id: client.id, redirect_uri: redirect, response_type: 'code', scope: SCOPE,
        access_type: 'offline', prompt: 'consent', state,
        login_hint: 'hello@notsodailystandup.com',
      })
      console.log(`\nOpen this and sign in as ${CHANNEL_HINT}:\n\n  ${url}\n`)
      spawn('open', [url.toString()], { stdio: 'ignore', detached: true }).unref()
    })
    setTimeout(() => { srv.close(); reject(new Error('timed out waiting for consent')) }, 10 * 60 * 1000)
  })

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: client.id, client_secret: client.secret, redirect_uri: redirect, grant_type: 'authorization_code' }),
  })
  const tok = await res.json()
  if (!tok.refresh_token) throw new Error(`no refresh_token in response: ${JSON.stringify(tok)}`)
  await mkdir(CFG_DIR, { recursive: true })
  await writeFile(TOKEN_FILE, JSON.stringify({ refresh_token: tok.refresh_token, obtained: ts() }, null, 2), { mode: 0o600 })
  log(`saved ${TOKEN_FILE}`)
}

async function accessToken() {
  const client = await loadClient()
  let saved
  try { saved = JSON.parse(await readFile(TOKEN_FILE, 'utf8')) }
  catch { throw new Error(`not authorised yet — run: node tools/youtube-sync.mjs --auth`) }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: saved.refresh_token, client_id: client.id, client_secret: client.secret, grant_type: 'refresh_token' }),
  })
  const tok = await res.json()
  if (!tok.access_token) {
    throw new Error(`token refresh failed (${tok.error || res.status}: ${tok.error_description || ''}). ` +
      `If it says invalid_grant the refresh token expired — the OAuth app is probably still in "Testing"; publish it, then --auth again.`)
  }
  return tok.access_token
}

// ----------------------------------------------------------------------------- csv --

const csvEsc = s => /[",\n]/.test(String(s ?? '')) ? `"${String(s).replace(/"/g, '""')}"` : String(s ?? '')
function parseCsv(text) {
  const rows = []
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue
    const cells = []; let cur = ''; let q = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ } else if (ch === '"') q = false; else cur += ch }
      else if (ch === '"') q = true
      else if (ch === ',') { cells.push(cur); cur = '' }
      else cur += ch
    }
    cells.push(cur)
    const [file_id, filename, performer, youtube_id, youtube_url, title, uploaded_at] = cells
    rows.push({ file_id, filename, performer, youtube_id, youtube_url, title, uploaded_at })
  }
  return rows
}

async function readShowCsv(show) {
  try {
    const text = await rclone(['cat', ...inFolder(show.folderId), `${REMOTE}:${CSV_NAME}`], { quiet: true })
    return parseCsv(text)
  } catch { return [] }
}

async function writeShowCsv(show, rows) {
  const body = [CSV_HEADER, ...rows.map(r => [r.file_id, r.filename, r.performer, r.youtube_id, r.youtube_url, r.title, r.uploaded_at].map(csvEsc).join(','))].join('\n') + '\n'
  const tmp = join(tmpdir(), `nsds-${show.folderId}-${CSV_NAME}`)
  await writeFile(tmp, body)
  await rclone(['copyto', ...inFolder(show.folderId), tmp, `${REMOTE}:${CSV_NAME}`], { quiet: true })
  await unlink(tmp).catch(() => {})
}

// ----------------------------------------------------------------------------- youtube --

/** Resumable upload. Returns the video id. */
async function uploadVideo(token, filePath, { title, description }) {
  const size = (await stat(filePath)).size
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-length': String(size), 'x-upload-content-type': 'video/mp4',
    },
    body: JSON.stringify({
      snippet: { title: title.slice(0, 100), description, categoryId: '23' },   // 23 = Comedy
      status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false },
    }),
  })
  if (!init.ok) {
    const body = await init.text()
    const err = new Error(`upload init ${init.status}: ${body.slice(0, 300)}`)
    err.quota = /quotaExceeded|dailyLimitExceeded/.test(body)
    throw err
  }
  const session = init.headers.get('location')

  // Send in 64 MB chunks so a dropped connection resumes from the last acked byte.
  const CHUNK = 64 * 1024 * 1024
  const fh = await open(filePath, 'r')
  try {
    let offset = 0
    while (offset < size) {
      const end = Math.min(offset + CHUNK, size)
      const buf = Buffer.alloc(end - offset)
      await fh.read(buf, 0, end - offset, offset)
      const res = await fetch(session, {
        method: 'PUT',
        headers: { 'content-length': String(end - offset), 'content-range': `bytes ${offset}-${end - 1}/${size}` },
        body: buf,
      })
      if (res.status === 308) {
        const range = res.headers.get('range')                 // "bytes=0-N"
        offset = range ? Number(range.split('-')[1]) + 1 : end
        continue
      }
      if (res.ok) {
        const json = await res.json()
        return json.id
      }
      throw new Error(`upload chunk ${res.status}: ${(await res.text()).slice(0, 300)}`)
    }
  } finally { await fh.close() }
  throw new Error('upload ended without a video id')
}

// ----------------------------------------------------------------------------- main --

async function installCron() {
  const plist = join(homedir(), 'Library', 'LaunchAgents', 'com.nsds.youtube-sync.plist')
  await mkdir(LOG_DIR, { recursive: true })
  const node = process.execPath
  const script = new URL(import.meta.url).pathname
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.nsds.youtube-sync</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${script}</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>${LOG_DIR}/youtube-sync.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/youtube-sync.log</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string></dict>
</dict></plist>
`
  await writeFile(plist, xml)
  await new Promise(r => spawn('launchctl', ['unload', plist], { stdio: 'ignore' }).on('close', r))
  await new Promise((res, rej) => spawn('launchctl', ['load', plist], { stdio: 'inherit' }).on('close', c => c === 0 ? res() : rej(new Error(`launchctl load exited ${c}`))))
  log(`installed ${plist} — runs daily 03:30, logs to ${LOG_DIR}/youtube-sync.log`)
  log('launchd does not run while the Mac sleeps. If a run is missed it simply runs at the next 03:30 the Mac is awake.')
}

/**
 * Transcode every not-yet-uploaded tape and hardlink it into DRAG-ME/ under its YouTube title,
 * so dragging that folder into youtube.com/upload gives correctly titled videos with zero API
 * quota. Follow with --adopt once they're processed.
 */
async function stageAll() {
  const shows = await discoverShows(ROOTS)
  await mkdir(DRAG_DIR, { recursive: true })
  const { link } = await import('node:fs/promises')
  let made = 0, had = 0
  for (const show of shows) {
    const done = new Map((await readShowCsv(show)).filter(r => r.youtube_id).map(r => [r.file_id, r]))
    for (const tape of show.tapes) {
      if (done.has(tape.id)) continue
      const staged = join(STAGE_DIR, show.folderId, `${tape.id}.mp4`)
      const pretty = join(DRAG_DIR, `${titleFor(tape, show).replace(/[/\\:*?"<>|]/g, '-')}.mp4`)
      await mkdir(join(STAGE_DIR, show.folderId), { recursive: true })
      let have = false
      try { have = (await stat(staged)).size > 0 } catch {}
      if (!have) {
        log(`▶ ${titleFor(tape, show)}  (${(tape.size / 1e9).toFixed(1)} GB)`)
        const t0 = Date.now()
        try {
          await transcode(tape, show.rootId, staged, { log })
          log(`  staged in ${((Date.now() - t0) / 60000).toFixed(1)} min`)
          made++
        } catch (err) { log(`  ✗ ${err.message}`); continue }
      } else had++
      try { await link(staged, pretty) } catch (e) { if (e.code !== 'EEXIST') throw e }
    }
  }
  log(`ready: ${made} transcoded now, ${had} already staged → ${DRAG_DIR}`)
  log('drag that folder into https://youtube.com/upload, set Visibility = Unlisted for all, then run --adopt')
}

/** Uploads playlist of the channel, all pages. 1 unit per page. */
async function channelUploads(token) {
  const h = { authorization: `Bearer ${token}` }
  const ch = await (await fetch('https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true', { headers: h })).json()
  const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads
  if (!uploads) throw new Error('no channel on this identity')
  const out = []
  let pageToken = ''
  do {
    const u = new URL('https://www.googleapis.com/youtube/v3/playlistItems')
    u.search = new URLSearchParams({ part: 'snippet', playlistId: uploads, maxResults: '50', pageToken })
    const r = await (await fetch(u, { headers: h })).json()
    if (r.error) throw new Error(r.error.message)
    for (const it of r.items || []) out.push({ id: it.snippet.resourceId.videoId, title: it.snippet.title })
    pageToken = r.nextPageToken || ''
  } while (pageToken)
  return out
}

/**
 * Bring already-uploaded videos' titles in line with the current tape filenames — tapes were
 * renamed to "<Performer> Set.mp4" ("Albberta_4-23-26.mp4" -> "Alberta Set.mp4"), and the titles
 * on YouTube still say the old thing. videos.update costs ~50 quota units, so this is cheap.
 */
async function retitle() {
  const shows = await discoverShows(ROOTS)
  const token = dryRun ? null : await accessToken()
  let changed = 0
  for (const show of shows) {
    const rows = await readShowCsv(show)
    let dirty = false
    for (const r of rows) {
      const tape = show.tapes.find(t => t.id === r.file_id)
      if (!tape || !r.youtube_id) continue
      const want = titleFor(tape, show)
      if (r.title === want) continue
      log(`${r.title}  ->  ${want}`)
      if (!dryRun) {
        const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet`, {
          method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: r.youtube_id, snippet: { title: want.slice(0, 100), categoryId: '23', description: `Artificially Unintelligent — ${show.label}. Proof tape for clip requests.` } }),
        })
        if (!res.ok) { log(`  ✗ ${res.status} ${(await res.text()).slice(0, 200)}`); continue }
        r.title = want; r.performer = tape.performer; r.filename = tape.name; dirty = true
      }
      changed++
    }
    if (dirty) await writeShowCsv(show, rows)
  }
  log(`${dryRun ? 'would retitle' : 'retitled'} ${changed}`)
}

/** Match hand-uploaded videos to tapes by exact title and record them. Idempotent. */
async function adopt() {
  const token = await accessToken()
  const videos = await channelUploads(token)
  const byTitle = new Map(videos.map(v => [v.title.trim(), v]))
  log(`channel has ${videos.length} uploads`)
  const shows = await discoverShows(ROOTS)
  let adopted = 0, missing = []
  for (const show of shows) {
    const rows = await readShowCsv(show)
    const done = new Set(rows.filter(r => r.youtube_id).map(r => r.file_id))
    let changed = false
    for (const tape of show.tapes) {
      if (done.has(tape.id)) continue
      const title = titleFor(tape, show)
      const v = byTitle.get(title)
      if (!v) { missing.push(title); continue }
      rows.push({ file_id: tape.id, filename: tape.name, performer: tape.performer, youtube_id: v.id,
                  youtube_url: `https://youtu.be/${v.id}`, title, uploaded_at: ts() })
      log(`  ✓ ${title} → https://youtu.be/${v.id}`)
      changed = true; adopted++
      await unlink(join(STAGE_DIR, show.folderId, `${tape.id}.mp4`)).catch(() => {})
      await unlink(join(DRAG_DIR, `${title.replace(/[/\\:*?"<>|]/g, '-')}.mp4`)).catch(() => {})
    }
    if (changed) await writeShowCsv(show, rows)
  }
  log(`adopted ${adopted}; ${missing.length} tape(s) still have no matching upload`)
  for (const m of missing) log(`    not on channel yet: ${m}`)
}

async function main() {
  if (args.has('--auth')) return authorize()
  if (args.has('--install-cron')) return installCron()
  if (args.has('--stage-all')) return stageAll()
  if (args.has('--adopt')) return adopt()
  if (args.has('--retitle')) return retitle()

  const shows = await discoverShows(ROOTS)
  const pending = []
  for (const show of shows) {
    const rows = await readShowCsv(show)
    const done = new Map(rows.filter(r => r.youtube_id).map(r => [r.file_id, r]))
    const missing = show.tapes.filter(t => !done.has(t.id))
    log(`${show.label}: ${show.tapes.length} tapes, ${done.size} on YouTube, ${missing.length} to go`)
    for (const t of missing) pending.push({ show, tape: t, rows })
  }
  if (!pending.length) { log('nothing to do'); return }
  if (dryRun) { for (const p of pending) console.log(`  would upload  ${p.show.label} / ${p.tape.name}  (${(p.tape.size / 1e9).toFixed(1)} GB)`); return }

  const token = await accessToken()
  await mkdir(STAGE_DIR, { recursive: true })
  let uploaded = 0

  for (const { show, tape, rows } of pending) {
    if (uploaded >= MAX_PER_RUN) { log(`reached ${MAX_PER_RUN} uploads for today; ${pending.length - uploaded} remain`); break }
    const title = `${tape.performer} — ${show.label}`
    const staged = join(STAGE_DIR, show.folderId, `${tape.id}.mp4`)
    await mkdir(join(STAGE_DIR, show.folderId), { recursive: true })
    log(`▶ ${title}  (${tape.name}, ${(tape.size / 1e9).toFixed(1)} GB)`)

    try {
      let have = false
      try { have = (await stat(staged)).size > 0 } catch {}
      if (!have) {
        const t0 = Date.now()
        const info = await transcode(tape, show.rootId, staged, { log })
        log(`  transcoded ${info.width}x${info.height} ${(await stat(staged)).size / 1e6 | 0} MB in ${((Date.now() - t0) / 60000).toFixed(1)} min`)
      } else log('  using staged file')

      const id = await uploadVideo(token, staged, {
        title,
        description: `Artificially Unintelligent — ${show.label}. Proof tape for clip requests.`,
      })
      const url = `https://youtu.be/${id}`
      log(`  ✓ ${url}`)
      rows.push({ file_id: tape.id, filename: tape.name, performer: tape.performer, youtube_id: id, youtube_url: url, title, uploaded_at: ts() })
      await writeShowCsv(show, rows)
      await unlink(staged).catch(() => {})
      uploaded++
    } catch (err) {
      log(`  ✗ ${err.message}`)
      if (err.quota) { log('  daily YouTube quota exhausted — stopping; the rest goes tomorrow'); break }
    }
  }
  log(`done: ${uploaded} uploaded this run`)
}

main().catch(err => { console.error(`[${ts()}] FATAL ${err.message}`); process.exit(1) })
