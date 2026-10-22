#!/usr/bin/env node
// CI check that the export grabs the very frame the editor previewed (.github/workflows/reel-check.yml,
// reel-image.yml). Cuts previews from a tape with the draft job's own extractPreviews(), then, for
// three of the recorded times, grabs the panel with the render job's own grabPanel() — and also the
// frame either side of it. The grab at t must match its preview better than either neighbour does: a
// time rounded the wrong way, a seek that lands one frame late, or previews labelled with the nearest
// slot instead of their real pts all pick a neighbour instead.
//
//   node tools/carousel/check-grab.mjs <tape.mp4> <workdir>
//
// The tape wants motion in every frame (the workflows use lavfi testsrc2 at 30000/1001 fps).

import { spawn } from 'node:child_process'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { maxCropH, cropPixels } from '../../videoreview/carousel.js'
import { extractPreviews, previewWindows } from './draft.mjs'
import { grabPanel } from './render.mjs'

const FFMPEG = process.env.NSDS_FFMPEG || 'ffmpeg'
const FFPROBE = process.env.NSDS_FFPROBE || 'ffprobe'
// Compared at this size: big enough to see testsrc2 move between frames, small enough that the
// preview's 1280 px JPEG and the grab's 4K crop come out alike.
const CMP = { w: 360, h: 150 }
// The matching grab must also be close in absolute terms (mean absolute difference per channel, 0-255).
const MAX_MAE = 8

function out(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks = []
    p.stdout.on('data', d => chunks.push(d))
    p.on('error', () => reject(new Error(`${cmd} could not start`)))
    p.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`${cmd} exited ${code}`)))
  })
}

/** An image as raw RGB at CMP size, after an optional crop. */
const raw = (path, crop = '') => out(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', path, '-frames:v', '1',
  '-vf', `${crop}scale=${CMP.w}:${CMP.h}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])

const mae = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length }

const tape = process.argv[2]
const dir = process.argv[3]
if (!tape || !dir) { console.error('usage: check-grab.mjs <tape.mp4> <workdir>'); process.exit(2) }

const probe = JSON.parse(await out(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', tape])).streams[0]
const dims = { w: probe.width, h: probe.height }
const [num, den] = probe.r_frame_rate.split('/').map(Number)
const frame = den / num

const framesDir = join(dir, 'previews')
await rm(framesDir, { recursive: true, force: true })
await mkdir(framesDir, { recursive: true })
// The draft job's shape: the read starts before the range (PAD) and previews start at the range.
const ranges = [{ s: 2.2, e: 3.9 }]
const from = 1
const times = await extractPreviews({ url: tape, from, windows: previewWindows(ranges, from, 0), framesDir })
const files = (await readdir(framesDir)).filter(f => /^f\d+\.jpg$/.test(f)).sort()
if (files.length !== times.length || times.length < 3) throw new Error(`${files.length} previews for ${times.length} times`)

const crop = { cx: 0.5, cy: 0.5, h: maxCropH(dims.w / dims.h) }
const picks = [0, times.length >> 1, times.length - 1]
let failed = 0
for (const k of picks) {
  const t = times[k]
  const preview = join(framesDir, files[k])
  const pd = { w: 1280, h: Math.round(1280 * dims.h / dims.w / 2) * 2 }
  const r = cropPixels(crop, pd.w, pd.h)
  const want = await raw(preview, `crop=${r.w}:${r.h}:${r.x}:${r.y},`)
  const score = {}
  // The neighbours' seek times sit 1 ms inside their frames: grabPanel prints -ss to the millisecond,
  // and t + frame itself could round past the next frame's pts.
  for (const [label, at] of [['before', t - frame - 0.001], ['at', t], ['after', t + frame - 0.001]]) {
    const png = join(dir, `grab-${k}-${label}.png`)
    await grabPanel(tape, Math.max(0, at), crop, dims, png)
    score[label] = Math.round(mae(await raw(png), want) * 100) / 100
  }
  const ok = score.at < score.before && score.at < score.after && score.at <= MAX_MAE
  if (!ok) failed++
  console.log(`t=${t.toFixed(3)}: grab vs preview ${score.at} (frame before ${score.before}, after ${score.after}) ${ok ? 'ok' : 'MISMATCH'}`)
}
if (failed) { console.log(`::error::${failed} of ${picks.length} grabs are not the previewed frame`); process.exit(1) }
console.log(`grab ok: ${picks.length} of ${times.length} previews grabbed exactly`)
