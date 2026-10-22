#!/usr/bin/env node
// First pass of a carousel: transcribe the clip (unless a reel draft already did), cut 4 fps preview
// frames, score the performer's face in each, put the previews in Drive and report words, lines,
// frames and the master's dimensions to the backend.
//
//   node tools/carousel/draft.mjs <draftFileId>
//
// Run by .github/workflows/reel.yml (job: carousel-draft), never on a laptop. Reads the master
// through `rclone serve` (one read, see tools/reel/lib.mjs). Logs counts only: the repo is public.

import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FPS, scoreFrames, splitLines, defaultStills } from '../../videoreview/carousel.js'
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

    // One read of the master. With words to make, it starts PAD early and the previews skip ahead to
    // the span (output -ss counts from the input seek); otherwise it starts at the span.
    const from = haveWords ? s : Math.max(0, s - PAD)
    const lead = s - from
    const out = [
      '-map', '0:v:0', '-an', '-ss', lead.toFixed(3), '-t', (e + TAIL - s).toFixed(3),
      '-vf', `fps=${FPS},scale=1280:-2`, '-q:v', '3', join(framesDir, 'f%05d.jpg'),
    ]
    if (!haveWords) out.unshift('-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav)
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', from.toFixed(3), '-t', (e + PAD - from).toFixed(3), '-i', srv.url, ...out], { quiet: true })
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
    const seen = join(dir, 'stills.json')
    await run(process.env.NSDS_PYTHON || 'python3', [new URL('./stills.py', import.meta.url).pathname, framesDir, seen], { capture: false })
    const found = JSON.parse(await readFile(seen, 'utf8'))
    const ids = await replaceFolderFiles(framesDir, draft.folders.frames)
    const samples = found.samples.map((x, i) => {
      if (!ids[x.file]) throw new Error('a preview did not land in Drive')
      return { t: s + i / FPS, fileId: ids[x.file], faces: x.faces }
    })
    const scored = scoreFrames(samples)
    const lines = defaultStills(splitLines(words, draft.ranges), words, scored, dims.w / dims.h, dims.h)
    // The backend stores a frame's face as [cx, cy, w, h]; defaultStills above wanted the object.
    const frames = scored.map(f => ({ ...f, face: f.face && [f.face.cx, f.face.cy, f.face.w, f.face.h] }))
    return { words: haveWords ? undefined : words, frames, dims, lines }
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
