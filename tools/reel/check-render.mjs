#!/usr/bin/env node
// CI check for the export path (.github/workflows/reel-check.yml): renders a fixed draft over any
// video through the same renderTo() the real export uses — captions, bug, crop — with no Drive
// and no backend.
//
//   node tools/reel/check-render.mjs <video> <out.mp4>

import { DEFAULT_STYLE } from '../../videoreview/reel.js'
import { renderTo } from './render.mjs'
import { workdir } from './lib.mjs'

// The joke from the agreed mockup, timed against the first 8.4 s of whatever video is passed in.
const FIXTURE = {
  words: [
    ["I'm", 0, .18], ['a', .18, .28], ['software', .28, .74], ['engineer,', .74, 1.3], ['which', 1.45, 1.62], ['means', 1.62, 1.9],
    ['I', 2, 2.08], ['spend', 2.08, 2.4], ['eight', 2.4, 2.66], ['hours', 2.66, 2.98], ['a', 2.98, 3.06], ['day', 3.06, 3.4],
    ['asking', 3.6, 3.98], ['a', 3.98, 4.06], ['robot', 4.06, 4.5], ['to', 4.5, 4.6], ['do', 4.6, 4.78], ['my', 4.78, 4.96], ['job,', 4.96, 5.4],
    ['and', 6.1, 6.24], ['then', 6.24, 6.44], ['I', 6.44, 6.52], ['take', 6.7, 7], ['credit', 7, 7.4], ['for', 7.4, 7.56], ['it.', 7.56, 7.9],
  ].map(([text, s, e]) => ({ text, s, e, aligned: true })),
  breaks: [4, 8, 12, 15, 19, 22],
  ranges: [{ s: 0, e: 4 }, { s: 4.5, e: 8.4 }],
  // Moved off the defaults on purpose, so the check exercises dragged positions too.
  style: { ...DEFAULT_STYLE, x: 38, y: 62, bugX: 80, bugY: 12 },
}

await renderTo(FIXTURE, process.argv[2], process.argv[3], await workdir())
console.log(`wrote ${process.argv[3]}`)
