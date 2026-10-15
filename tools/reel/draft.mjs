#!/usr/bin/env node
// First draft of a reel: transcribe the request's audio, tighten pauses if asked, group captions.
//
//   node tools/reel/draft.mjs <draftFileId>
//
// Run by .github/workflows/reel.yml (job: draft), never on a laptop. Reads the master through
// `rclone serve` (see lib.mjs) and writes words/breaks/ranges/status back into the draft.

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fillTimings, autoBreaks, cutPauses, wantsCutPauses } from '../../videoreview/reel.js'
import { readDraft, patchDraft, serveMaster, workdir, run, FFMPEG, shortError } from './lib.mjs'

// The transcript covers the request plus this much either side, which is what lets a trim in the
// editor reach past the request (REEL trimSlack is 5 s) and still have captions.
const PAD = 5

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

async function main(id) {
  const dir = await workdir()
  const draft = await readDraft(id, dir)
  let srv = null
  try {
    srv = await serveMaster(draft)
    const from = Math.max(0, draft.source.span.s - PAD)
    const to = draft.source.span.e + PAD
    const wav = join(dir, 'clip.wav')
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', from.toFixed(3), '-t', (to - from).toFixed(3),
      '-i', srv.url, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { quiet: true })
    srv.stop(); srv = null

    const json = join(dir, 'words.json')
    await run(process.env.NSDS_PYTHON || 'python3', [new URL('./transcribe.py', import.meta.url).pathname, wav, json], { capture: false })
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

    await patchDraft(draft, { status: 'ready', error: null, words, breaks: autoBreaks(words), ranges, draftedAt: new Date().toISOString() }, dir)
    console.log(`draft ready: ${words.length} words, ${ranges.length} range(s)`)
  } catch (err) {
    console.error(`draft failed: ${shortError(err)}`)
    await patchDraft(draft, { status: 'failed', error: shortError(err) }, dir).catch(() => {})
    process.exitCode = 1
  } finally {
    srv?.stop()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv[2])
