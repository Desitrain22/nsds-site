#!/usr/bin/env node
// CI check for the carousel export path (.github/workflows/reel-check.yml): composes a fixed 2-slide
// carousel through the same composeSlides() the real export uses, every panel cropped from one photo,
// with no Drive and no backend.
//
//   node tools/carousel/check-render.mjs <photo> <outdir>

import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { CAROUSEL_DEFAULT_STYLE, layout } from '../../videoreview/carousel.js'
import { composeSlides, grabPanel } from './render.mjs'

const photo = process.argv[2]
const outDir = process.argv[3]
const DIMS = { w: 1600, h: 1020 }

const crops = [
  { cx: 0.5, cy: 0.45, h: 0.42 }, { cx: 0.3, cy: 0.5, h: 0.4 }, { cx: 0.7, cy: 0.5, h: 0.4 },
  { cx: 0.5, cy: 0.4, h: 0.3 }, { cx: 0.4, cy: 0.55, h: 0.35 }, { cx: 0.6, cy: 0.45, h: 0.41 },
]
const still = i => ({ t: 0, crop: crops[i] })
const line = (i, text, cap = { x: 50, y: 94 }) => ({ w: [i, i + 1], text, cap, still: still(i) })

const lines = [
  line(0, "I'm a software engineer, which means"),
  line(1, 'I spend eight hours a day asking a robot', { x: 30, y: 60 }), // dragged off the default
  line(2, 'to do my job,'),
  line(3, 'and then I take credit for it.'),
]
const fillers = [{ text: 'Artificially Unintelligent', cap: { x: 50, y: 94 }, still: still(4) }, { text: '', cap: { x: 50, y: 94 }, still: still(5) }]
const { slides } = layout(lines, fillers)
const flat = slides.flat()
await mkdir(outDir, { recursive: true })
const pngs = []
for (let i = 0; i < flat.length; i++) {
  const png = join(outDir, `panel-${i}.png`)
  await grabPanel(photo, null, flat[i].still.crop, DIMS, png)
  pngs.push(png)
}
const jpgs = await composeSlides(slides, CAROUSEL_DEFAULT_STYLE, pngs, outDir)
console.log(`wrote ${jpgs.length} slides to ${outDir}`)
