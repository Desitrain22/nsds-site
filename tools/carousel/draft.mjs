#!/usr/bin/env node
// First pass of a carousel: transcribe the clip (unless a reel draft already did), cut 4 fps preview
// frames, score the performer's face in each, put the previews in Drive and report words, lines,
// frames and the master's dimensions to the backend.
//
//   node tools/carousel/draft.mjs <draftFileId>
//
// Run by .github/workflows/reel.yml (job: carousel-draft), never on a laptop. Reads the master
// through `rclone serve` (one read, see tools/reel/lib.mjs). Logs counts only: the repo is public.

import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FPS, CAROUSEL_LIMITS, scoreFrames, splitLines, defaultStills } from '../../videoreview/carousel.js'
import { readDraft, patchDraft, serveMaster, replaceFolderFiles, workdir, run, FFMPEG, shortError } from '../reel/lib.mjs'
import { transcribeWav } from '../reel/draft.mjs'
import { showinfoParser, toMs } from './showinfo.mjs'

// The transcript covers the span plus this much either side, so a trim in the editor can reach past
// the span (same slack as the reel job).
const PAD = 5
// Previews also run this far past each range's end, for the filler panels (carousel.js fillerWindow:
// the 3 s after the last placed line, which is the end of a range when the clip has more lines than
// fit). Nothing else outside the ranges is cut: a request's ranges can be spread across a long set.
const TAIL = 3
// The backend refuses a frames list longer than this (Code.gs carouselJobPut).
export const MAX_FRAMES = 5000
const FFPROBE = process.env.NSDS_FFPROBE || 'ffprobe'

/** The master's pixel size, probed over the same HTTP URL ffmpeg reads. */
async function masterDims(url) {
  const raw = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', url], { quiet: true })
  const v = JSON.parse(raw).streams?.[0] || {}
  if (!(Number.isInteger(v.width) && v.width > 0 && Number.isInteger(v.height) && v.height > 0)) throw new Error('could not read the master\'s size')
  return { w: v.width, h: v.height }
}

/**
 * The stretches of the read to cut previews from, in seconds from the seek origin `from`: every
 * range, each run on by `tail`, merged where they touch so no frame is in two.
 */
export function previewWindows(ranges, from, tail = TAIL) {
  const out = []
  for (const r of [...ranges].sort((a, b) => a.s - b.s)) {
    const a = Math.max(0, r.s - from)
    const b = r.e + tail - from
    const last = out[out.length - 1]
    if (last && a <= last.b) last.b = Math.max(last.b, b)
    else out.push({ a, b })
  }
  return out
}

/** How many previews `windows` can make at FPS, at most (one per 1/FPS slot of each window). */
export const previewCount = windows => windows.reduce((n, w) => n + Math.ceil((w.b - w.a) * FPS - 1e-9), 0)

/**
 * The `select` expression for `windows`: inside a window [a, b), the first frame of each 1/FPS slot
 * counted from a, i.e. the first frame at or after a + k/FPS. A frame starts a new slot when its slot
 * number is above the previous INPUT frame's (`prev_t`; NAN for the very first frame, which then
 * starts one if it is inside a window). The windows are disjoint, so the sum is 0 or 1. Commas are
 * escaped for the filtergraph.
 */
export function previewSelect(windows) {
  const f = v => v.toFixed(3)
  const terms = windows.map(({ a, b }) =>
    `gte(t\\,${f(a)})*lt(t\\,${f(b)})*(isnan(prev_t)+gt(floor((t-${f(a)})*${FPS})\\,floor((prev_t-${f(a)})*${FPS})))`)
  return terms.length ? terms.join('+') : '0'
}

/**
 * One ffmpeg read of the master -> the WAV (when asked for) and the preview JPEGs, returning each
 * JPEG's real presentation time in the master, in file order. `windows` are previewWindows(), and
 * the read runs to the end of the last of them or `readLen`, whichever is later.
 *
 * `fps=4` would label slot n as from + n/4, but it picks the NEAREST source frame for the slot, so the
 * picture can be ~0.1 s off its label and the export (`-ss t -frames:v 1`) would grab another frame.
 * So frames are chosen with `select` (previewSelect: the first frame at or after each slot, `-fps_mode
 * passthrough` so nothing is duplicated or dropped) and `showinfo` reports their true pts, which
 * counts from the input seek point `from`. The recorded t is exact (integer pts x time base, floored
 * to a millisecond; see showinfo.mjs): an input `-ss` keeps frames at or after its time, so a time
 * rounded up would skip to the next frame.
 */
export async function extractPreviews({ url, from, windows, wav, framesDir, readLen = 0 }) {
  if (!windows.length) throw new Error('no ranges to cut previews from')
  const count = previewCount(windows)
  if (count > MAX_FRAMES) throw new Error(`these ranges would make ${count} preview frames; a carousel can have at most ${MAX_FRAMES}`)
  const end = windows[windows.length - 1].b
  const args = ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info', '-y', '-ss', from.toFixed(3), '-t', Math.max(readLen, end).toFixed(3), '-i', url]
  if (wav) args.push('-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav)
  args.push('-map', '0:v:0', '-an', '-fps_mode', 'passthrough',
    '-vf', `select='${previewSelect(windows)}',scale=1280:-2,showinfo`, '-q:v', '3', join(framesDir, 'f%05d.jpg'))
  const parser = showinfoParser(toMs(from))
  await new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let buf = ''
    p.stderr.on('data', d => {
      buf += d
      const lines = buf.split('\n'); buf = lines.pop()
      try { for (const line of lines) parser.line(line) } catch (err) { p.kill(); reject(err) }
    })
    p.on('error', reject)
    // Never echo ffmpeg's stderr: at -loglevel info it includes the input's metadata.
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)))
  })
  const times = parser.times()
  if (times.length > MAX_FRAMES) throw new Error(`ffmpeg cut ${times.length} preview frames; a carousel can have at most ${MAX_FRAMES}`)
  return times
}

/** Build everything a carousel draft job reports. `step` reports progress; main() sends the result. */
export async function buildCarousel(draft, dir, step = () => {}) {
  let srv = null
  try {
    const { s, e } = draft.source.span
    const ranges = draft.ranges || draft.source.ranges
    const haveWords = Array.isArray(draft.words) && draft.words.length > 0
    step({ tape: 'running' })
    srv = await serveMaster(draft)
    const framesDir = join(dir, 'frames')
    await mkdir(framesDir, { recursive: true })
    const wav = join(dir, 'clip.wav')

    // One read of the master. With words to make, it starts PAD before the span and runs PAD past
    // it (the WAV covers all of that); otherwise it starts at the span. Previews come only from the
    // ranges and their tails (previewWindows), wherever the read starts.
    const from = haveWords ? s : Math.max(0, s - PAD)
    const windows = previewWindows(ranges, from)
    const times = await extractPreviews({ url: srv.url, from, windows, readLen: haveWords ? 0 : e + PAD - from, wav: haveWords ? null : wav, framesDir })
    const dims = await masterDims(srv.url)
    srv.stop(); srv = null
    step({ tape: 'done' })

    let words = draft.words
    if (haveWords) {
      step({ captions: 'done' })
    } else {
      step({ captions: 'running' })
      try { words = await transcribeWav(wav, from) } catch (err) { step({ captions: 'failed' }); throw err }
      step({ captions: 'done' })
    }

    step({ stills: 'running' })
    try {
      const seen = join(dir, 'stills.json')
      await run(process.env.NSDS_PYTHON || 'python3', [new URL('./stills.py', import.meta.url).pathname, framesDir, seen], { capture: false })
      const found = JSON.parse(await readFile(seen, 'utf8'))
      if (found.samples.length !== times.length) throw new Error('the frame times and the previews disagree')
      const ids = await replaceFolderFiles(framesDir, draft.folders.frames, { parentId: draft.folders.drafts, name: 'frames' })
      const samples = found.samples.map((x, i) => {
        if (!ids[x.file]) throw new Error('a preview did not land in Drive')
        return { t: times[i], fileId: ids[x.file], faces: x.faces }
      })
      const frames = scoreFrames(samples)
      let lines = defaultStills(splitLines(words, draft.ranges), words, frames, dims.w / dims.h, dims.h)
      if (lines.length > CAROUSEL_LIMITS.maxStored) {
        console.log(`keeping the first ${CAROUSEL_LIMITS.maxStored} of ${lines.length} lines`)
        lines = lines.slice(0, CAROUSEL_LIMITS.maxStored)
      }
      step({ stills: 'done' })
      return { words: haveWords ? undefined : words, frames, dims, lines }
    } catch (err) { step({ stills: 'failed' }); throw err }
  } finally {
    srv?.stop()
  }
}

async function main(id) {
  const dir = await workdir()
  const draft = await readDraft(id, 'carousel')
  // Step reports, one at a time and in order. Best effort: a lost report must never fail the draft.
  let reports = Promise.resolve()
  const step = progress => { reports = reports.then(() => patchDraft(draft, { status: 'drafting', progress }, 'carousel')).catch(() => {}) }
  try {
    const built = await buildCarousel(draft, dir, step)
    await reports
    const { words, ...rest } = built
    await patchDraft(draft, { status: 'ready', error: null, ...(words ? { words } : {}), ...rest }, 'carousel')
    console.log(`carousel ready: ${built.frames.length} frames, ${built.lines.length} line(s)`)
  } catch (err) {
    console.error(`carousel draft failed: ${shortError(err)}`)
    await reports
    await patchDraft(draft, { status: 'failed', error: shortError(err) }, 'carousel').catch(() => {})
    process.exitCode = 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv[2])
