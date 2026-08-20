#!/usr/bin/env node
/**
 * Prepare a show's set tapes for upload to YouTube as unlisted videos.
 *
 *   node tools/publish-tapes.mjs apr2026                 # every set tape
 *   node tools/publish-tapes.mjs apr2026 --only=DavidS   # just the matching ones
 *   node tools/publish-tapes.mjs apr2026 --height=720    # smaller, faster to upload
 *   node tools/publish-tapes.mjs --list                  # show ids
 *
 * WHY YOUTUBE
 * Drive cannot serve video to a web page: it returns 403 + HTML to any request carrying
 * `Sec-Fetch-Site: cross-site`, a browser-controlled header JS cannot remove. Apps Script
 * can't bridge it either (text-only MIME types, ~50 MB cap, no Range support). YouTube needs
 * no extra infrastructure, transcodes for you, and its IFrame API exposes exactly what clip
 * marking needs.
 *
 * WHY TRANSCODE FIRST INSTEAD OF UPLOADING THE MASTERS
 * The masters are 4-7 GB each (4K, ~76 Mbps) — about 40 GB for April. Downscaling to 1080p
 * first turns that into roughly 3 GB of browser upload while still giving YouTube enough to
 * build a real quality ladder, so a performer can sit at 360p on hotel wifi or bump to 1080p.
 * Duration is preserved exactly, so every timestamp still lines up with the master.
 *
 * WHY THE UPLOAD IS MANUAL
 * The YouTube Data API needs a Google Cloud project and an OAuth client, which is the whole
 * thing we're avoiding. Dragging files into youtube.com/upload needs no credentials, and this
 * is a once-per-show job.
 *
 * Zero dependencies, in the style of Show Materials/2026/2026 accounting/refresh.mjs.
 */

import { spawn } from 'node:child_process'
import { createWriteStream, unlinkSync } from 'node:fs'
import { mkdir, stat, unlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { SHOWS, getShow, isExcluded, performerName } from '../videoreview/shows.js'

const REMOTE = 'nsdsdrive'
const OUT_ROOT = join(homedir(), 'NSDS-youtube-upload')

// Every temp file we might be holding, so Ctrl-C doesn't strand a few hundred MB in TMPDIR.
const tempFiles = new Set()
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const f of tempFiles) { try { unlinkSync(f) } catch {} }
    process.exit(130)
  })
}

const args = process.argv.slice(2)
const force = args.includes('--force')
const onlyArg = args.find(a => a.startsWith('--only='))
const only = onlyArg ? onlyArg.slice('--only='.length).toLowerCase() : null
const heightArg = args.find(a => a.startsWith('--height='))
const HEIGHT = heightArg ? Number(heightArg.slice('--height='.length)) : 1080
const BITRATE = HEIGHT >= 1080 ? '6M' : HEIGHT >= 720 ? '4M' : '1500k'
const showId = args.find(a => !a.startsWith('--'))

if (args.includes('--list') || !showId) {
  console.log('Shows:')
  for (const s of SHOWS) console.log(`  ${s.id.padEnd(20)} ${s.label}${s.city ? ` (${s.city})` : ''}`)
  process.exit(showId ? 0 : (args.includes('--list') ? 0 : 1))
}

const show = getShow(showId)
if (!show) {
  console.error(`Unknown show "${showId}". Try --list.`)
  process.exit(1)
}

// ------------------------------------------------------------------ helpers --

function run(cmd, argv, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: ['ignore', capture ? 'pipe' : 'inherit', 'pipe'] })
    let out = ''
    let err = ''
    if (capture) child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve(out)
      : reject(new Error(`${cmd} exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`)))
  })
}

const inFolder = folderId => ['--drive-root-folder-id', folderId]

async function listFolder(folderId) {
  const json = await run('rclone',
    ['lsjson', ...inFolder(folderId), '-R', '--max-depth', '2', '--fast-list', `${REMOTE}:`],
    { capture: true })
  return JSON.parse(json)
}

/**
 * Probe the master's duration from its first megabytes. These 4K mp4s are faststart, so the
 * moov atom at the front carries the exact whole-file duration.
 *
 * Returns null rather than throwing — the value only feeds a sanity check, and letting a probe
 * failure escape would abandon the tape before transcoding starts, blaming ffprobe for it.
 */
async function masterDuration(folderId, path) {
  const tmp = join(tmpdir(), `nsds-head-${process.pid}-${Date.now()}.mp4`)
  tempFiles.add(tmp)
  try {
    await new Promise((resolve, reject) => {
      const cat = spawn('rclone',
        ['cat', ...inFolder(folderId), '--count', '12000000', `${REMOTE}:${path}`],
        { stdio: ['ignore', 'pipe', 'pipe'] })
      const sink = createWriteStream(tmp)
      let err = ''
      cat.stderr.on('data', d => { err += d })
      const timer = setTimeout(() => { cat.kill('SIGKILL'); reject(new Error('rclone timed out')) }, 120000)
      cat.stdout.pipe(sink)
      cat.on('error', e => { clearTimeout(timer); reject(e) })
      cat.on('close', code => {
        clearTimeout(timer)
        sink.end()
        if (code !== 0) return reject(new Error(`rclone exited ${code}: ${err.trim().split('\n').slice(-2).join(' | ')}`))
        sink.on('close', resolve)
      })
    })
    const raw = await run('ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', tmp], { capture: true })
    const v = Number(raw.trim())
    return Number.isFinite(v) && v > 0 ? v : null
  } catch (err) {
    console.log(`  (could not read master duration: ${err.message})`)
    return null
  } finally {
    await unlink(tmp).catch(() => {})
    tempFiles.delete(tmp)
  }
}

/** rclone cat | ffmpeg -> local file. ffmpeg writes a real file because +faststart seeks back. */
function transcode(folderId, path, dest) {
  return new Promise((resolve, reject) => {
    const cat = spawn('rclone', ['cat', ...inFolder(folderId), `${REMOTE}:${path}`],
      { stdio: ['ignore', 'pipe', 'pipe'] })

    const ff = spawn('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error', '-stats', '-stats_period', '10',
      '-i', 'pipe:0',
      '-vf', `scale=-2:${HEIGHT}`,
      // VideoToolbox keeps this network-bound rather than CPU-bound on Apple Silicon.
      '-c:v', 'h264_videotoolbox', '-b:v', BITRATE,
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
      '-movflags', '+faststart',
      dest,
    ], { stdio: ['pipe', 'inherit', 'inherit'] })

    cat.stdout.pipe(ff.stdin)
    // rclone keeps writing after ffmpeg is satisfied; that EPIPE is expected, not an error.
    ff.stdin.on('error', () => {})

    let catErr = ''
    let catCode = null
    cat.stderr.on('data', d => {
      const t = String(d)
      catErr += t
      if (/error|failed/i.test(t) && !/shared Google Drive client_id/.test(t)) process.stderr.write(t)
    })
    cat.on('close', code => { catCode = code })

    let done = false
    ff.on('close', code => {
      if (done) return
      done = true
      const stillRunning = catCode === null
      try { cat.kill('SIGTERM') } catch {}
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}`))
      // Feed ffmpeg a truncated pipe and it exits 0 with a short file — measured. So a
      // mid-stream rclone failure would otherwise pass as a successful encode missing its tail.
      if (!stillRunning && catCode !== 0) {
        return reject(new Error(`rclone exited ${catCode} mid-stream, so the encode is truncated: ` +
          catErr.trim().split('\n').slice(-2).join(' | ')))
      }
      resolve()
    })
    ff.on('error', reject)
    cat.on('error', reject)
  })
}

async function probe(path) {
  const raw = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration,bit_rate',
    '-show_entries', 'stream=codec_name,width,height', '-of', 'json', path,
  ], { capture: true })
  const data = JSON.parse(raw)
  const v = (data.streams || []).find(s => s.width) || {}
  return {
    duration: Number(data.format?.duration) || null,
    bitrate: Number(data.format?.bit_rate) || null,
    width: v.width, height: v.height,
  }
}

const mb = n => `${(n / 1e6).toFixed(0)} MB`
const mins = s => `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`
const safe = s => s.replace(/[/\\:*?"<>|]/g, '-').trim()

// ------------------------------------------------------------------ main --

const label = `${show.label}${show.city ? ` (${show.city})` : ''}`
const outDir = join(OUT_ROOT, show.id)
await mkdir(outDir, { recursive: true })

console.log(`\n${label} — folder ${show.folderId}`)
console.log(`Staging in ${outDir.replace(homedir(), '~')}  (${HEIGHT}p @ ${BITRATE})\n`)

const entries = await listFolder(show.folderId)
let tapes = entries.filter(e =>
  !e.IsDir &&
  /^video\//.test(e.MimeType || '') &&
  !/^(Flicks|Photos?|Stills|Proxies)\//i.test(e.Path) &&
  !isExcluded(show, e.Name))

if (only) tapes = tapes.filter(t => t.Name.toLowerCase().includes(only))

// Two masters differing only by extension would collapse onto one output name.
const byBase = new Map()
for (const t of tapes) {
  const base = t.Name.replace(/\.[^.]+$/, '')
  byBase.set(base, [...(byBase.get(base) || []), t.Name])
}
for (const [base, names] of byBase) {
  if (names.length > 1) {
    console.log(`  ! ${names.join(' and ')} share the basename "${base}" — skipping both, rename one first.`)
    tapes = tapes.filter(t => !names.includes(t.Name))
  }
}

if (!tapes.length) {
  console.log('No set tapes found (after exclusions). Nothing to do.')
  process.exit(0)
}

console.log(`${tapes.length} set tape(s).\n`)
const done = []
let built = 0, skipped = 0, failed = 0
const startedAll = Date.now()

for (const [i, tape] of tapes.entries()) {
  const who = performerName(show, tape.Name)
  // The filename becomes YouTube's default title, so make it something you'd want there.
  const outName = `${safe(who)} — ${safe(label)}.mp4`
  const dest = join(outDir, outName)
  console.log(`[${i + 1}/${tapes.length}] ${who} — ${tape.Name} (${mb(tape.Size)})`)

  if (!force) {
    try {
      const existing = await stat(dest)
      if (existing.size > 0) {
        console.log(`  skip: already staged (${mb(existing.size)}) — --force to rebuild\n`)
        done.push({ tape: tape.Name, who, outName })
        skipped++
        continue
      }
    } catch { /* not staged yet */ }
  }

  tempFiles.add(dest)
  const t0 = Date.now()
  try {
    const srcDuration = await masterDuration(show.folderId, tape.Path)
    if (srcDuration) console.log(`  master ${mins(srcDuration)}`)

    await transcode(show.folderId, tape.Path, dest)
    const info = await probe(dest)
    const size = (await stat(dest)).size

    // Asymmetric on purpose: truncation makes the output SHORTER, which must never ship. An
    // output that is LONGER just means the 12 MB prefix under-reported, which is harmless.
    if (srcDuration && info.duration && info.duration < srcDuration - 0.5) {
      throw new Error(`output is ${(srcDuration - info.duration).toFixed(2)}s shorter than the ` +
        `master — truncated, discarding`)
    }
    if (!srcDuration) console.log('  ! master duration unknown, truncation check is off for this tape')

    console.log(`  ${info.width}x${info.height}  ${mb(size)}  ` +
      `${((info.bitrate || 0) / 1e6).toFixed(1)} Mbps  in ${mins((Date.now() - t0) / 1000)}`)
    console.log(`  -> ${outName}\n`)
    done.push({ tape: tape.Name, who, outName })
    tempFiles.delete(dest)
    built++
  } catch (err) {
    console.error(`  FAILED: ${err.message}\n`)
    await unlink(dest).catch(() => {})
    tempFiles.delete(dest)
    failed++
  }
}

console.log(`Done in ${mins((Date.now() - startedAll) / 1000)} — ${built} built, ${skipped} skipped, ${failed} failed.`)

if (done.length) {
  console.log(`
Next:
  1. open ${outDir.replace(homedir(), '~')}
  2. drag all of it into https://youtube.com/upload
  3. set Visibility to **Unlisted** (you can multi-select and bulk-edit)
  4. copy each video's id out of its URL — youtu.be/<ID> or watch?v=<ID>
  5. paste into YOUTUBE in videoreview/shows.js:

export const YOUTUBE = {
  ${show.id}: {`)
  for (const d of done) console.log(`    '${d.tape}': '',   // ${d.outName}`)
  console.log(`  },
}
`)
}
if (failed) process.exitCode = 1
