#!/usr/bin/env node
// CI check that a composed slide has content, not just the right size (.github/workflows/reel-check.yml,
// reel-image.yml): each of its three panels must be a picture rather than a flat fill, and the first
// panel's bottom band must hold the caption box's purple. A Chromium that rendered nothing, a panel
// that failed to load, or a caption that never drew all still make a 1080x1350 JPEG.
//
//   node tools/carousel/check-slide.mjs <slide.jpg> [boxHex]
//
// Dependency-free: ffmpeg decodes the JPEG to raw RGB and the arithmetic is here.

import { spawn } from 'node:child_process'
import { SLIDE, PANEL, CAROUSEL_DEFAULT_STYLE } from '../../videoreview/carousel.js'

const FFMPEG = process.env.NSDS_FFMPEG || 'ffmpeg'
// A photo panel's luma spread is well into the 40s; a flat fill with JPEG noise is ~1.
const MIN_STDDEV = 12
// The caption box: this many pixels within TOL of its colour on every channel (one line of the
// default 44 px caption is ~900 x 60 px; the stage wall behind it is a much lighter purple-grey).
const MIN_BOX_PX = 8000
const TOL = 14

/** The slide as raw RGB, decoded by ffmpeg. */
function decode(path) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks = []
    p.stdout.on('data', d => chunks.push(d))
    p.on('error', () => reject(new Error('ffmpeg could not start')))
    p.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exited ${code}`)))
  })
}

export async function checkSlide(path, boxHex = CAROUSEL_DEFAULT_STYLE.box) {
  const px = await decode(path)
  const { w, h } = SLIDE
  if (px.length !== w * h * 3) throw new Error(`expected a ${w}x${h} slide, got ${px.length} bytes`)
  const box = [1, 3, 5].map(i => parseInt(boxHex.slice(i, i + 2), 16))
  const report = { stddev: [], boxPx: 0 }
  for (let k = 0; k < 3; k++) {
    let n = 0, sum = 0, sq = 0
    for (let y = k * PANEL.h; y < (k + 1) * PANEL.h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const i = (y * w + x) * 3
        const l = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
        n++; sum += l; sq += l * l
      }
    }
    const mean = sum / n
    report.stddev.push(Math.round(Math.sqrt(Math.max(0, sq / n - mean * mean)) * 10) / 10)
  }
  // The bottom third of panel 1, where its default-position caption sits.
  for (let y = Math.round(PANEL.h * 2 / 3); y < PANEL.h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      if (Math.abs(px[i] - box[0]) <= TOL && Math.abs(px[i + 1] - box[1]) <= TOL && Math.abs(px[i + 2] - box[2]) <= TOL) report.boxPx++
    }
  }
  const problems = []
  report.stddev.forEach((s, k) => { if (s < MIN_STDDEV) problems.push(`panel ${k + 1} is flat (luma stddev ${s} < ${MIN_STDDEV})`) })
  if (report.boxPx < MIN_BOX_PX) problems.push(`panel 1 has no caption box (${report.boxPx} px of ${boxHex} < ${MIN_BOX_PX})`)
  return { ...report, problems }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await checkSlide(process.argv[2], process.argv[3])
  console.log(`panel luma stddev ${r.stddev.join(' / ')}, caption box ${r.boxPx} px`)
  if (r.problems.length) {
    for (const p of r.problems) console.log(`::error::${p}`)
    process.exit(1)
  }
  console.log('slide ok')
}
