#!/usr/bin/env node
// First draft of a reel: transcribe the request's audio, track the performer for the 9:16 crop,
// tighten pauses if asked, group captions.
//
//   node tools/reel/draft.mjs <draftFileId>
//
// Run by .github/workflows/reel.yml (job: draft), never on a laptop. Reads the master through
// `rclone serve` (see lib.mjs) and reports words/breaks/ranges/track to the backend.

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fillTimings, autoBreaks, cutPauses, wantsCutPauses, followTrack } from '../../videoreview/reel.js'
import { readDraft, patchDraft, serveMaster, workdir, run, FFMPEG, shortError } from './lib.mjs'

// The transcript covers the request plus this much either side, which is what lets a trim in the
// editor reach past the request (REEL trimSlack is 5 s) and still have captions.
const PAD = 5
// Frames per second the face detector looks at. Plenty for a camera that should move slowly anyway.
const TRACK_FPS = 4

/** ffmpeg silencedetect over a WAV -> [{s, e}] in WAV seconds. Quiet = dead air; a laugh is not quiet. */
export async function silences(wav) {
  let log = ''
  await new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-nostdin', '-i', wav, '-af', 'silencedetect=noise=-35dB:d=0.4', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] })
    p.stderr.on('data', d => { log += d })
    p.on('error', reject)
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`silencedetect exited ${code}`)))
  })
  const out = []
  let start = null
  for (const line of log.split('\n')) {
    const s = line.match(/silence_start: ([\d.]+)/)
    const e = line.match(/silence_end: ([\d.]+)/)
    if (s) start = +s[1]
    if (e && start !== null) { out.push({ s: start, e: +e[1] }); start = null }
  }
  return out
}

/**
 * Transcribe, track and group one draft. Returns the fields a draft job owns; main() reports them
 * to the backend.
 */
export async function buildDraft(draft, dir, step = () => {}) {
  let srv = null
  try {
    step({ tape: 'running' })
    srv = await serveMaster(draft)
    const from = Math.max(0, draft.source.span.s - PAD)
    const to = draft.source.span.e + PAD
    const wav = join(dir, 'clip.wav')
    const frames = join(dir, 'frames.mp4')
    // One read of the master, two outputs: 16 kHz mono for WhisperX, and a small low-frame-rate
    // copy for the face detector.
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', from.toFixed(3), '-t', (to - from).toFixed(3),
      '-i', srv.url,
      '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav,
      '-map', '0:v:0', '-an', '-vf', `fps=${TRACK_FPS},scale=960:-2`, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', frames,
    ], { quiet: true })
    srv.stop(); srv = null
    step({ tape: 'done', captions: 'running', tracking: 'running' })

    const python = process.env.NSDS_PYTHON || 'python3'
    const json = join(dir, 'words.json')
    const faces = join(dir, 'faces.json')
    // Transcription and face tracking don't depend on each other — run them side by side.
    await Promise.all([
      run(python, [new URL('./transcribe.py', import.meta.url).pathname, wav, json], { capture: false })
        .then(() => step({ captions: 'done' }), err => { step({ captions: 'failed' }); throw err }),
      run(python, [new URL('./track.py', import.meta.url).pathname, frames, String(TRACK_FPS), faces], { capture: false })
        .then(() => step({ tracking: 'done' }), err => { step({ tracking: 'failed' }); throw err }),
    ])
    const seen = JSON.parse(await readFile(faces, 'utf8'))
    const track = followTrack(seen.samples.map(x => ({ ...x, t: x.t + from })), seen.aspect)
    console.log(track ? `performer tracked: ${track.length} keyframes` : 'no face found — the crop stays where the editor puts it')
    const raw = JSON.parse(await readFile(json, 'utf8')).words
    const words = fillTimings(raw.map(w => ({
      text: w.text,
      s: Number.isFinite(w.s) ? w.s + from : null,
      e: Number.isFinite(w.e) ? w.e + from : null,
    })))
    if (!words.length) throw new Error('no speech found in this clip')

    let ranges = draft.source.ranges
    if (wantsCutPauses(`${draft.source.granular} ${draft.source.notes}`)) {
      const quiet = (await silences(wav)).map(q => ({ s: q.s + from, e: q.e + from }))
      const before = ranges.length
      ranges = cutPauses(ranges, words, quiet)
      console.log(`cut pauses: ${before} range(s) -> ${ranges.length}`)
    }
    return { words, breaks: autoBreaks(words), ranges, track }
  } finally {
    srv?.stop()
  }
}

async function main(id) {
  const dir = await workdir()
  const draft = await readDraft(id)
  // Step reports for the editor's "making your clip" screen, sent one at a time and in order. Best
  // effort: a lost report must never fail the draft itself.
  let reports = Promise.resolve()
  const step = progress => { reports = reports.then(() => patchDraft(draft, { status: 'drafting', progress })).catch(() => {}) }
  try {
    const built = await buildDraft(draft, dir, step)
    await reports
    await patchDraft(draft, { status: 'ready', error: null, ...built })
    console.log(`draft ready: ${built.words.length} words, ${built.ranges.length} range(s)`)
  } catch (err) {
    console.error(`draft failed: ${shortError(err)}`)
    await reports
    await patchDraft(draft, { status: 'failed', error: shortError(err) }).catch(() => {})
    process.exitCode = 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv[2])
