#!/usr/bin/env node
/**
 * Build 480p review proxies for a show's set tapes and put them back in Drive.
 *
 * WHY THIS IS REQUIRED, not an optimisation. Measured on this machine:
 *   - Drive's anonymous download endpoint (what the Worker uses):  1.08 MB/s
 *   - Authenticated rclone on the same byte range:                 7.41 MB/s
 *   - A 4K master needs ~9.5 MB/s just to play at 1x (76 Mbps).
 * So the masters can never stream: a seek stalls for tens of seconds waiting on a GOP.
 * A 480p proxy runs ~1.6 Mbps (0.2 MB/s), which has ~5x headroom even on the throttled
 * anonymous path, and seeks land immediately.
 *
 * Pulls through rclone (7x faster than anonymous), transcodes with VideoToolbox, and
 * uploads to a `Proxies` subfolder of the show folder. Duration is preserved, so clip
 * timestamps map 1:1 onto the master with no offset maths.
 *
 * Zero dependencies, in the style of Show Materials/2026/2026 accounting/refresh.mjs.
 *
 *   node tools/make-proxies.mjs apr2026              # every set tape in the show
 *   node tools/make-proxies.mjs apr2026 --only=DavidS # just the tapes matching a substring
 *   node tools/make-proxies.mjs apr2026 --force       # rebuild even if a proxy exists
 *   node tools/make-proxies.mjs --list                # show ids
 */

import { spawn } from 'node:child_process'
import { createWriteStream, unlinkSync } from 'node:fs'
import { mkdir, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SHOWS, getShow, isExcluded, performerName } from '../videoreview/shows.js'

const REMOTE = 'nsdsdrive'
const PROXY_DIR = 'Proxies'
const SUFFIX = '__480p.mp4'
const HEIGHT = 480
const VIDEO_BITRATE = '1500k'

// Every temp file we might be holding, so Ctrl-C doesn't strand a 93 MB proxy in TMPDIR.
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
const showId = args.find(a => !a.startsWith('--'))

if (args.includes('--list') || !showId) {
  console.log('Shows:')
  for (const s of SHOWS) {
    console.log(`  ${s.id.padEnd(20)} ${s.label}${s.city ? ` (${s.city})` : ''}`)
  }
  if (!showId) process.exit(args.includes('--list') ? 0 : 1)
  process.exit(0)
}

const show = getShow(showId)
if (!show) {
  console.error(`Unknown show "${showId}". Try --list.`)
  process.exit(1)
}

// ------------------------------------------------------------------ helpers --

function run(cmd, argv, { capture = false, stdout = 'inherit' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, {
      stdio: ['ignore', capture ? 'pipe' : stdout, 'pipe'],
    })
    let out = ''
    let err = ''
    if (capture) child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve(out)
      else reject(new Error(`${cmd} exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`))
    })
  })
}

/** rclone args that scope the remote to one Drive folder id. */
const inFolder = folderId => ['--drive-root-folder-id', folderId]

async function listFolder(folderId) {
  const json = await run('rclone', ['lsjson', ...inFolder(folderId), `${REMOTE}:`], { capture: true })
  return JSON.parse(json)
}

/**
 * Probe the master's duration from its first megabytes. These 4K mp4s are faststart, so the
 * moov atom at the front carries the exact whole-file duration (verified: a 12 MB prefix of a
 * 31 MB file reports the full duration to six decimals).
 *
 * Returns null rather than throwing. The value only feeds an optional sanity check, so letting
 * a probe failure escape would abandon the tape before transcoding even starts — and the error
 * would name ffprobe, pointing at entirely the wrong thing.
 */
async function masterDuration(folderId, name) {
  const tmp = join(tmpdir(), `nsds-head-${process.pid}-${Date.now()}.mp4`)
  tempFiles.add(tmp)
  try {
    await new Promise((resolve, reject) => {
      const cat = spawn('rclone', ['cat', ...inFolder(folderId), '--count', '12000000', `${REMOTE}:${name}`],
        { stdio: ['ignore', 'pipe', 'pipe'] })
      // Write it ourselves instead of shelling out to `sh -c "cat > file"`: that hop bought
      // nothing, hid rclone's exit status, and broke if TMPDIR contained a quote or a $.
      const sink = createWriteStream(tmp)
      let err = ''
      cat.stderr.on('data', d => { err += d })
      const timer = setTimeout(() => {
        cat.kill('SIGKILL')
        reject(new Error('rclone timed out reading the master header'))
      }, 120000)
      cat.stdout.pipe(sink)
      cat.on('error', e => { clearTimeout(timer); reject(e) })
      cat.on('close', code => {
        clearTimeout(timer)
        sink.end()
        if (code !== 0) return reject(new Error(`rclone exited ${code}: ${err.trim().split('\n').slice(-2).join(' | ')}`))
        sink.on('close', resolve)
      })
    })

    const raw = await run('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', tmp,
    ], { capture: true })
    const value = Number(raw.trim())
    return Number.isFinite(value) && value > 0 ? value : null
  } catch (err) {
    console.log(`  (could not read master duration: ${err.message})`)
    return null
  } finally {
    await unlink(tmp).catch(() => {})
    tempFiles.delete(tmp)
  }
}

/**
 * rclone cat | ffmpeg -> local file.
 * ffmpeg writes to a real file rather than a pipe because +faststart has to seek back
 * and rewrite the moov atom at the front, which a pipe cannot do.
 */
function transcode(folderId, name, dest) {
  return new Promise((resolve, reject) => {
    const cat = spawn('rclone', ['cat', ...inFolder(folderId), `${REMOTE}:${name}`],
      { stdio: ['ignore', 'pipe', 'pipe'] })

    const ff = spawn('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error', '-stats', '-stats_period', '5',
      '-i', 'pipe:0',
      '-vf', `scale=-2:${HEIGHT}`,
      // VideoToolbox keeps this network-bound rather than CPU-bound on Apple Silicon.
      '-c:v', 'h264_videotoolbox', '-b:v', VIDEO_BITRATE,
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
      '-movflags', '+faststart',
      dest,
    ], { stdio: ['pipe', 'inherit', 'inherit'] })

    cat.stdout.pipe(ff.stdin)
    // rclone keeps writing after ffmpeg is satisfied; that EPIPE is expected, not an error.
    ff.stdin.on('error', () => {})

    let catErr = ''
    let catCode = null
    cat.stderr.on('data', d => {
      const text = String(d)
      catErr += text
      if (/error|failed/i.test(text) && !/shared Google Drive client_id/.test(text)) {
        process.stderr.write(text)
      }
    })

    let ffDone = false
    cat.on('close', code => { catCode = code })

    ff.on('close', code => {
      if (ffDone) return
      ffDone = true
      const stillRunning = catCode === null
      try { cat.kill('SIGTERM') } catch {}

      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}`))

      // THE important check. Feed ffmpeg a truncated pipe and it exits 0 with a short file —
      // measured. So a mid-stream rclone failure (network blip, auth, quota) would otherwise
      // sail through as a "successful" encode missing its tail, and every clip a performer
      // marks past that point would reference video that isn't there.
      // `stillRunning` means rclone was alive when ffmpeg finished, i.e. ffmpeg had all it
      // needed — that's the normal path. A rclone that already exited non-zero is fatal.
      if (!stillRunning && catCode !== 0) {
        return reject(new Error(
          `rclone exited ${catCode} mid-stream, so the encode is truncated: ` +
          `${catErr.trim().split('\n').slice(-2).join(' | ')}`))
      }
      resolve()
    })
    ff.on('error', reject)
    cat.on('error', reject)
  })
}

async function probe(path) {
  const raw = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration,bit_rate',
    '-show_entries', 'stream=codec_name,width,height',
    '-of', 'json', path,
  ], { capture: true })
  const data = JSON.parse(raw)
  const v = (data.streams || []).find(s => s.width) || {}
  return {
    duration: Number(data.format?.duration) || null,
    bitrate: Number(data.format?.bit_rate) || null,
    width: v.width,
    height: v.height,
  }
}

const mb = n => `${(n / 1e6).toFixed(1)} MB`
const mins = s => `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`

// ------------------------------------------------------------------ main --

const label = `${show.label}${show.city ? ` (${show.city})` : ''}`
console.log(`\n${label} — folder ${show.folderId}\n`)

const entries = await listFolder(show.folderId)
let tapes = entries.filter(e =>
  !e.IsDir && /^video\//.test(e.MimeType || '') && !isExcluded(show, e.Name))
if (only) tapes = tapes.filter(t => t.Name.toLowerCase().includes(only))

// Two masters differing only by extension would collapse onto one proxy name and silently
// overwrite each other.
const byBase = new Map()
for (const t of tapes) {
  const base = t.Name.replace(/\.[^.]+$/, '')
  if (!byBase.has(base)) byBase.set(base, [])
  byBase.get(base).push(t.Name)
}
for (const [base, names] of byBase) {
  if (names.length > 1) {
    console.log(`  ! ${names.join(' and ')} share the basename "${base}" and map to one proxy ` +
      `— only the last would survive. Rename one, then re-run. Skipping both.`)
    tapes = tapes.filter(t => !names.includes(t.Name))
  }
}

if (!tapes.length) {
  console.log('No set tapes found (after exclusions). Nothing to do.')
  process.exit(0)
}

// Make sure the Proxies subfolder exists, then see what's already there.
await run('rclone', ['mkdir', ...inFolder(show.folderId), `${REMOTE}:${PROXY_DIR}`]).catch(() => {})
let existing = []
try {
  const raw = await run('rclone',
    ['lsjson', ...inFolder(show.folderId), `${REMOTE}:${PROXY_DIR}`], { capture: true })
  existing = JSON.parse(raw)
} catch {
  existing = []   // folder may not exist yet on a first run
}
const haveProxy = new Set(existing.map(e => e.Name))

console.log(`${tapes.length} set tape(s); ${haveProxy.size} proxy/proxies already present.\n`)

const work = join(tmpdir(), 'nsds-proxies')
await mkdir(work, { recursive: true })

let built = 0, skipped = 0, failed = 0
const startedAll = Date.now()

for (const [i, tape] of tapes.entries()) {
  const base = tape.Name.replace(/\.[^.]+$/, '')
  const proxyName = base + SUFFIX
  const who = performerName(show, tape.Name)
  const head = `[${i + 1}/${tapes.length}] ${who} — ${tape.Name} (${mb(tape.Size)})`

  if (haveProxy.has(proxyName) && !force) {
    console.log(`${head}\n  skip: proxy already in Drive (--force to rebuild)\n`)
    skipped++
    continue
  }

  console.log(head)
  const dest = join(work, proxyName)
  tempFiles.add(dest)
  const t0 = Date.now()

  try {
    const srcDuration = await masterDuration(show.folderId, tape.Name)
    if (srcDuration) console.log(`  master duration ${mins(srcDuration)}`)

    await transcode(show.folderId, tape.Name, dest)
    const info = await probe(dest)
    const size = (await stat(dest)).size

    // Asymmetric on purpose. Truncation makes the proxy SHORTER than the master, and that must
    // never be uploaded. A proxy that comes out *longer* than the probe reported just means the
    // 12 MB prefix under-reported (fragmented mp4 and MPEG-TS both do), which is harmless —
    // treating that as drift would reject a perfectly good encode after a full transcode.
    if (srcDuration && info.duration && info.duration < srcDuration - 0.5) {
      throw new Error(
        `proxy is ${(srcDuration - info.duration).toFixed(2)}s shorter than the master ` +
        `(${info.duration.toFixed(2)}s vs ${srcDuration.toFixed(2)}s) — truncated, refusing to upload`)
    }
    if (!srcDuration) {
      console.log('  ! master duration unknown, so the truncation check is off for this tape')
    }

    console.log(`  encoded ${info.width}x${info.height} ${mb(size)} ` +
      `(${((info.bitrate || 0) / 1e6).toFixed(2)} Mbps) in ${mins((Date.now() - t0) / 1000)}`)

    await run('rclone', ['copyto', ...inFolder(show.folderId), dest, `${REMOTE}:${PROXY_DIR}/${proxyName}`])
    console.log(`  uploaded -> ${PROXY_DIR}/${proxyName}`)

    await unlink(dest).catch(() => {})
    tempFiles.delete(dest)
    built++
  } catch (err) {
    console.error(`  FAILED: ${err.message}`)
    await unlink(dest).catch(() => {})
    tempFiles.delete(dest)
    failed++
  }
  console.log('')
}

console.log(`Done in ${mins((Date.now() - startedAll) / 1000)} — ` +
  `${built} built, ${skipped} skipped, ${failed} failed.`)

if (built) {
  console.log(
    `\nProxies inherit sharing from the show folder, which is already "anyone with the link".\n` +
    `Verify one is publicly readable before relying on it:\n` +
    `  curl -sI "https://drive.usercontent.google.com/download?id=<PROXY_ID>&export=download&confirm=t" | head -3\n` +
    `Want video/mp4, not text/html.`)
}
if (failed) process.exitCode = 1
