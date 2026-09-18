// Shared helpers for the tape tooling: Drive listing via rclone, set-tape discovery, and the
// 1080p transcode. Zero dependencies.
//
// Everything here keys on Drive FILE IDS, not paths. The Drive tree is being reorganised (the
// "Media/<year>/<show>/tapes" layout), and Drive file/folder ids survive moves and renames.

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const REMOTE = 'nsdsdrive'
const RCLONE = '/opt/homebrew/bin/rclone'
const FFMPEG = '/opt/homebrew/bin/ffmpeg'
const FFPROBE = '/opt/homebrew/bin/ffprobe'

export function run(cmd, argv, { capture = true, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: ['ignore', capture ? 'pipe' : 'inherit', 'pipe'] })
    let out = ''
    let err = ''
    if (capture) child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d; if (!quiet && /error|failed/i.test(String(d)) && !/shared Google Drive client_id/.test(String(d))) process.stderr.write(d) })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve(out)
      : reject(new Error(`${cmd.split('/').pop()} exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`)))
  })
}

export const inFolder = id => ['--drive-root-folder-id', id]
export const rclone = (args, opts) => run(RCLONE, args, opts)

/**
 * Recursive listing (json) beneath a Drive folder id.
 *
 * Drive's recursive listing can come back PARTIAL with exit code 0 — on 2026-09-11 a single pass
 * saw 1 of March SF's 8 sets and --stage-all quietly skipped the other 7. Nothing in the output
 * marks it as incomplete, so one pass can never be trusted.
 *
 * Demanding that two passes AGREE (the 2026-09-11 fix) turned out to be too strong: traversal
 * through a shortcut to someone else's folder flaps. March SF holds a shortcut to jim's
 * "3:18:26 Tech Comedy Show sets/", and its eight children appear in some passes and not others,
 * so the 2026 tree alternates between 707, 723 and 731 entries and never repeats itself. That
 * failed the whole run on 2026-09-17.
 *
 * So: UNION the passes instead of comparing them. Partial listings can only ever be a subset of
 * the truth, so a union is monotone — it converges upward on the full tree and a dropped entry can
 * never hide. Stop as soon as a pass contributes nothing new, which is the same "two passes agree"
 * signal without being defeated by an entry that flaps.
 */
export async function listTree(folderId, depth = 4) {
  const args = ['lsjson', ...inFolder(folderId), '-R', '--max-depth', String(depth), '--fast-list', `${REMOTE}:`]
  const seen = new Map()
  for (let pass = 1; pass <= 4; pass++) {
    const out = JSON.parse(await rclone(args, { quiet: true }))
    const before = seen.size
    for (const e of out) if (e.ID && !seen.has(e.ID)) seen.set(e.ID, e)
    if (pass > 1 && seen.size === before) break            // converged
    if (pass > 1) process.stderr.write(`Drive listing of ${folderId} pass ${pass} added ${seen.size - before} entries not seen before (${seen.size} total); listing again\n`)
  }
  return [...seen.values()]
}

// Not anyone's set: reels, sizzles, recaps, already-cut clips, our own artefacts, and Drive's
// "Copy of" duplicates (March SF has every set twice).
const EXCLUDE_NAME = [/sizzle/i, /highlight/i, /update/i, /recap/i, /^copy of /i, /request_/i, /clip_/i, /rough/i, /^sponsor sketch/i]
// extras/ holds sizzles, recaps and hosting bits filed by hand — never anyone's set.
const EXCLUDE_DIR = /^(clips?|proxies|flicks|photos?|stills|completed[_ ]clips?|extras?)$/i

/** Is this Drive entry a reviewable set tape? */
export function isSetTape(entry) {
  if (entry.IsDir) return false
  if (!/^video\//.test(entry.MimeType || '')) return false
  const parts = entry.Path.split('/')
  if (parts.slice(0, -1).some(d => EXCLUDE_DIR.test(d))) return false
  if (EXCLUDE_NAME.some(re => re.test(entry.Name))) return false
  return true
}

/**
 * Human label for a show folder: "April 2026 Tapes／Photos" -> "April 2026", "NYTW 2026 Media" ->
 * "NYTW 2026", "May 2026 Tapes／Photos (Boston)" -> "May 2026 (Boston)".
 */
export function showLabel(folderName) {
  return folderName
    .replace(/[／/]/g, ' ')
    .replace(/\b(tapes?|photos?|media|and|footage)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\(\s*/g, '(').replace(/\s*\)/g, ')')
    .trim()
}

/** Performer from a tape filename: "DavidS_4-23-26.mp4" -> "DavidS", "Aakash Set.mp4" -> "Aakash". */
/**
 * A whole-show recording rather than one comic's set.
 *
 * These are real and there are four of them: March 2025 (SF), July 2024 (NYC) and both October
 * 2024 tech weeks filed only a `Full Show.mp4`, up to 34.9 GB. They are legitimately tapes — they
 * stay in Drive and stay listed for review — but they are never mirrored to YouTube. Two reasons:
 * a proof tape is meant to be one performer's set, so "Full Show — October 2024 (SF Tech Week)"
 * helps nobody find their own bit; and at roughly six uploads a night these four alone would burn
 * most of a night's budget while the per-performer backlog waits.
 *
 * The patterns match the ones performerName in videoreview/shows.js already treats as a full show,
 * so both halves agree about what one is.
 */
export const FULL_SHOW_RE = /^(full\s*show|au\s*latw\s*micaudio|sf\s*full\s*tape|aufullshowreview)/i

export function isFullShowTape(filename) {
  const stem = String(filename || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  return FULL_SHOW_RE.test(stem)
}

export function performerFrom(filename) {
  let n = filename.replace(/\.[^.]+$/, '').trim()
  n = n.replace(/[_ ]?\(?\d{1,2}-\d{1,2}-\d{2,4}\)?/g, ' ')
  n = n.replace(/\bset\b/i, ' ').replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim()
  return n || filename
}

/**
 * Discover show folders and their set tapes beneath the given root folder ids.
 * Returns [{ rootId, folderId, folderName, label, tapes:[{ id, name, size, path, performer }] }].
 * `path` is relative to rootId — pass rootId (not folderId) to transcode().
 * A "show folder" is the top-level child of a root that contains tapes.
 *
 * A show's tapes are the videos in its `tapes/` subfolder — the same rule the backend already
 * uses (Code.gs resolveTapesRoot). Taking anything beneath the show folder instead is what
 * uploaded six March SF sets TWICE: that show root also holds a shortcut to the videographer's
 * own "3:18:26 Tech Comedy Show sets/", which is a copy of every set under different file ids,
 * and EXCLUDE_DIR has no way to anticipate a name like that. Shows filed before the reorg have no
 * tapes/ subfolder, so fall back to the old behaviour for those rather than dropping them.
 */
export async function discoverShows(rootIds) {
  const shows = []
  for (const rootId of rootIds) {
    const entries = await listTree(rootId)
    const dirs = new Map(entries.filter(e => e.IsDir && !e.Path.includes('/')).map(e => [e.Name, e]))
    for (const [name, tapes] of groupTapesByShow(entries, new Set(dirs.keys()))) {
      shows.push({ rootId, folderId: dirs.get(name).ID, folderName: name, label: showLabel(name), tapes })
    }
  }
  return shows
}

/**
 * The pure half of discoverShows: rclone entries (paths relative to a year root) -> Map of show
 * folder name -> its tapes, sorted by name. `showNames` is the set of top-level folders; a tape
 * whose top-level segment isn't one of them is sitting loose in the root and is skipped.
 */
export function groupTapesByShow(entries, showNames) {
  const hasTapesDir = new Set(
    entries.filter(e => e.IsDir && /^[^/]+\/tapes$/i.test(e.Path)).map(e => e.Path.split('/')[0]))
  const byShow = new Map()
  for (const e of entries) {
    if (!isSetTape(e)) continue
    const parts = e.Path.split('/')
    const top = parts[0]
    if (!showNames.has(top)) continue
    // Once a show has a tapes/ folder, that folder is the only source of truth for it.
    if (hasTapesDir.has(top) && !/^tapes$/i.test(parts[1] || '')) continue
    if (!byShow.has(top)) byShow.set(top, [])
    byShow.get(top).push({ id: e.ID, name: e.Name, size: e.Size, path: e.Path, performer: performerFrom(e.Name) })
  }
  for (const tapes of byShow.values()) tapes.sort((a, b) => a.name.localeCompare(b.name))
  return byShow
}

/** Duration in seconds from the file's first bytes (works only for faststart mp4). */
export async function headerDuration(tapePath, rootId) {
  const tmp = join(tmpdir(), `nsds-head-${process.pid}-${Date.now()}.mp4`)
  try {
    await new Promise((resolve, reject) => {
      const cat = spawn(RCLONE, ['cat', ...inFolder(rootId), '--count', '12000000', `${REMOTE}:${tapePath}`], { stdio: ['ignore', 'pipe', 'pipe'] })
      const sink = createWriteStream(tmp)
      const timer = setTimeout(() => { cat.kill('SIGKILL'); reject(new Error('rclone timed out')) }, 120000)
      cat.stdout.pipe(sink)
      cat.on('error', e => { clearTimeout(timer); reject(e) })
      cat.on('close', code => { clearTimeout(timer); sink.end(); code === 0 ? sink.on('close', resolve) : reject(new Error(`rclone exited ${code}`)) })
    })
    const raw = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', tmp], { quiet: true })
    const v = Number(raw.trim())
    return Number.isFinite(v) && v > 0 ? v : null
  } catch { return null } finally { await unlink(tmp).catch(() => {}) }
}

export async function probe(path) {
  const raw = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration,bit_rate', '-show_entries', 'stream=width,height', '-of', 'json', path], { quiet: true })
  const d = JSON.parse(raw)
  const v = (d.streams || []).find(s => s.width) || {}
  return { duration: Number(d.format?.duration) || null, bitrate: Number(d.format?.bit_rate) || null, width: v.width, height: v.height }
}

function ffmpegArgs(input, dest, height, bitrate) {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-stats', '-stats_period', '15',
    '-i', input, '-vf', `scale=-2:${height}`,
    '-c:v', 'h264_videotoolbox', '-b:v', bitrate,
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-movflags', '+faststart', dest]
}

/**
 * Transcode a Drive tape to a local 1080p file.
 *
 * Fast path streams `rclone cat | ffmpeg`. That only works when the moov atom is at the FRONT
 * of the source (faststart). SarahB_4-23-26.mp4 has it at the end, so ffmpeg can't parse a pipe
 * -- for those we download the whole master to disk first, then transcode from the file.
 */
export async function transcode(tape, rootId, dest, { height = 1080, bitrate = '6M', log = () => {} } = {}) {
  const srcDuration = await headerDuration(tape.path, rootId)
  const faststart = srcDuration !== null
  let full = null

  try {
    if (faststart) {
      await new Promise((resolve, reject) => {
        const cat = spawn(RCLONE, ['cat', ...inFolder(rootId), `${REMOTE}:${tape.path}`], { stdio: ['ignore', 'pipe', 'pipe'] })
        const ff = spawn(FFMPEG, ffmpegArgs('pipe:0', dest, height, bitrate), { stdio: ['pipe', 'inherit', 'inherit'] })
        cat.stdout.pipe(ff.stdin)
        ff.stdin.on('error', () => {})
        let catCode = null
        cat.on('close', c => { catCode = c })
        ff.on('close', code => {
          const stillRunning = catCode === null
          try { cat.kill('SIGTERM') } catch {}
          if (code !== 0) return reject(new Error(`ffmpeg exited ${code}`))
          if (!stillRunning && catCode !== 0) return reject(new Error(`rclone exited ${catCode} mid-stream (truncated)`))
          resolve()
        })
        ff.on('error', reject); cat.on('error', reject)
      })
    } else {
      log(`  source is not faststart — downloading ${(tape.size / 1e9).toFixed(1)} GB first`)
      full = join(tmpdir(), `nsds-full-${process.pid}-${tape.id}.mp4`)
      await rclone(['copyto', ...inFolder(rootId), `${REMOTE}:${tape.path}`, full], { capture: false, quiet: true })
      const got = (await stat(full)).size
      if (got !== tape.size) throw new Error(`download incomplete: ${got} of ${tape.size} bytes`)
      await run(FFMPEG, ffmpegArgs(full, dest, height, bitrate), { capture: false, quiet: true })
    }

    const info = await probe(dest)
    // Asymmetric: truncation makes the output SHORTER; a longer output just means the header
    // probe under-reported. Only the first is a failure.
    if (srcDuration && info.duration && info.duration < srcDuration - 0.5) {
      throw new Error(`output ${(srcDuration - info.duration).toFixed(1)}s shorter than master — truncated`)
    }
    if (full) {
      const fullInfo = await probe(full)
      if (fullInfo.duration && info.duration < fullInfo.duration - 0.5) throw new Error('output shorter than downloaded master — truncated')
    }
    return info
  } finally {
    if (full) await unlink(full).catch(() => {})
  }
}
