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

// The transcript covers the span plus this much either side, so a trim in the editor can reach past
// the span (same slack as the reel job).
const PAD = 5
// Previews run this far past the span's end, for the filler panel (carousel.js fillerWindow).
const TAIL = 3
const FFPROBE = process.env.NSDS_FFPROBE || 'ffprobe'

/** The master's pixel size, probed over the same HTTP URL ffmpeg reads. */
async function masterDims(url) {
  const raw = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', url], { quiet: true })
  const v = JSON.parse(raw).streams?.[0] || {}
  if (!(Number.isInteger(v.width) && v.width > 0 && Number.isInteger(v.height) && v.height > 0)) throw new Error('could not read the master\'s size')
  return { w: v.width, h: v.height }
}

/**
 * One ffmpeg read of the master -> the WAV (when asked for) and the preview JPEGs, returning each
 * JPEG's real presentation time in the master, in file order.
 *
 * `fps=4` would label slot n as span.s + n/4, but it picks the NEAREST source frame for the slot, so
 * the picture can be ~0.1 s off its label and the export (`-ss t -frames:v 1`) would grab another
 * frame. So frames are chosen with `select` (the first frame at or after each slot, `-fps_mode
 * passthrough` so nothing is duplicated or dropped) and `showinfo` reports their true pts_time, which
 * counts from the input seek point `from`. The recorded t is floored to a millisecond: showinfo
 * rounds to microseconds and an input `-ss` keeps frames at or after its time, so rounding up could
 * skip to the next frame.
 */
export async function extractPreviews({ url, from, lead, len, wav, framesDir, readLen = lead + len }) {
  const args = ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info', '-y', '-ss', from.toFixed(3), '-t', Math.max(readLen, lead + len).toFixed(3), '-i', url]
  if (wav) args.push('-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav)
  args.push('-map', '0:v:0', '-an', '-fps_mode', 'passthrough',
    '-vf', `select='gte(t\\,${lead.toFixed(3)}+${1 / FPS}*selected_n)*lt(t\\,${(lead + len).toFixed(3)})',scale=1280:-2,showinfo`, '-q:v', '3', join(framesDir, 'f%05d.jpg'))
  const times = []
  let tail = ''
  await new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let buf = ''
    p.stderr.on('data', d => {
      buf += d
      const lines = buf.split('\n'); buf = lines.pop()
      for (const line of lines) {
        const m = line.match(/Parsed_showinfo.*\bpts_time:(-?[\d.]+)/)
        if (m) times.push(from + Number(m[1]))
        else if (/error|failed|invalid/i.test(line)) tail = line.slice(0, 200)
      }
    })
    p.on('error', reject)
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}${tail ? `: ${tail}` : ''}`)))
  })
  return times.map(t => Math.floor(t * 1000) / 1000)
}

/** Build everything a carousel draft job reports. `step` reports progress; main() sends the result. */
export async function buildCarousel(draft, dir, step = () => {}) {
  let srv = null
  try {
    const { s, e } = draft.source.span
    const haveWords = Array.isArray(draft.words) && draft.words.length > 0
    step({ tape: 'running' })
    srv = await serveMaster(draft)
    const framesDir = join(dir, 'frames')
    await mkdir(framesDir, { recursive: true })
    const wav = join(dir, 'clip.wav')

    // One read of the master. With words to make, it starts PAD early and the previews begin LEAD
    // seconds in, at the span; otherwise it starts at the span.
    const from = haveWords ? s : Math.max(0, s - PAD)
    const times = await extractPreviews({ url: srv.url, from, lead: s - from, len: e + TAIL - s, readLen: e + PAD - from, wav: haveWords ? null : wav, framesDir })
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
      const ids = await replaceFolderFiles(framesDir, draft.folders.frames)
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
