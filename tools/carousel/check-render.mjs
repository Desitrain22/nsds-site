#!/usr/bin/env node
// CI check for the carousel export path (.github/workflows/reel-check.yml): composes a fixed 2-slide
// carousel through the same composeSlides() the real export uses, every panel cropped from one photo,
// with no Drive and no backend.
//
//   node tools/carousel/check-render.mjs <photo> <outdir>

import { join } from 'node:path'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { CAROUSEL_DEFAULT_STYLE, layout, frameBox } from '../../videoreview/carousel.js'
import { composeSlides, grabPanel } from './render.mjs'

const photo = process.argv[2]
const outDir = process.argv[3]
const DIMS = { w: 1600, h: 1020 }

// The performer's face in media/opt/AustinStage-1600.jpg (the brainstorm spike's YuNet box), framed
// exactly as a draft frames it (k = 2.3), and a little looser, so the panels differ.
const FACE = { cx: (550.4 + 101.5) / 1600, cy: 259.5 / 1020, w: 203 / 1600, h: 264 / 1020 }
const aspect = DIMS.w / DIMS.h
const crops = [2.3, 2.45, 2.6, 2.3, 2.45, 2.6].map(k => frameBox(FACE, aspect, DIMS.h, { k }))
const still = i => ({ t: 0, crop: crops[i] })
const line = (i, text, cap = { x: 50, y: 94 }) => ({ w: [i, i + 1], text, cap, still: still(i) })

const lines = [
  line(0, "I'm a software engineer, which means"),
  line(1, 'I spend eight hours a day asking a robot', { x: 30, y: 80 }), // dragged off the default
  line(2, 'to do my job,'),
  line(3, 'and then I take credit for it.'),
]
const fillers = [{ text: 'Artificially Unintelligent', cap: { x: 50, y: 94 }, still: still(4) }, { text: '', cap: { x: 50, y: 94 }, still: still(5) }]
const { slides } = layout(lines, fillers)
const flat = slides.flat()
await mkdir(outDir, { recursive: true })
// A slide left over from an earlier run must not pass for this one's (the CI checks there is no 03.jpg).
for (const f of await readdir(outDir)) if (/^(\d\d\.jpg|panel-\d+\.png|slide-\d+\.(html|png))$/.test(f)) await rm(join(outDir, f))
const pngs = []
for (let i = 0; i < flat.length; i++) {
  const png = join(outDir, `panel-${i}.png`)
  await grabPanel(photo, null, flat[i].still.crop, DIMS, png)
  pngs.push(png)
}
const jpgs = await composeSlides(slides, CAROUSEL_DEFAULT_STYLE, pngs, outDir)
console.log(`wrote ${jpgs.length} slides to ${outDir}`)
