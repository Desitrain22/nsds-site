#!/usr/bin/env node
// Export a reel: cut the ranges from the 4K master, crop to 9:16, burn in the captions and the bug,
// and file the MP4 as a new version in the show's completed_clips/.
//
//   node tools/reel/render.mjs <draftFileId>             (CI, .github/workflows/reel.yml job: render)
//   node tools/reel/render.mjs --local <video> <out.mp4> (smoke test: a fixture draft, no Drive)
//
// Everything about the picture comes from videoreview/reel.js — the same functions the editor's
// preview paints from — so the export matches what was edited.

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAss, ffmpegArgs, nextVersionName, DEFAULT_STYLE } from '../../videoreview/reel.js'
import { readDraft, patchDraft, serveMaster, workdir, run, FFMPEG, listNames, upload, shortError } from './lib.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const FONTS_DIR = join(ROOT, 'videoreview', 'fonts')
const ICON_SVG = join(ROOT, 'media', 'brand', 'Icon.svg')

/** Rasterise the logo for the bug (86 px wide at 1080 — 24 px on the 300-px preview). */
async function icon(dir) {
  const png = join(dir, 'icon.png')
  await run(process.env.NSDS_RSVG || 'rsvg-convert', ['-w', '86', '-o', png, ICON_SVG], { quiet: true })
  return png
}

async function renderTo(draft, input, out, dir) {
  const ass = join(dir, 'captions.ass')
  await writeFile(ass, buildAss(draft))
  await run(FFMPEG, ffmpegArgs(draft, {
    input, ass, fontsDir: FONTS_DIR, icon: await icon(dir), bugFont: join(FONTS_DIR, 'AzeretMono-Bold.ttf'), out,
  }), { quiet: true })
}

async function main(id) {
  const dir = await workdir()
  const draft = await readDraft(id, dir)
  if (!['queued', 'rendering'].includes(draft.status)) {
    console.log(`nothing to render (status ${draft.status})`)
    return
  }
  let srv = null
  try {
    await patchDraft(draft, { status: 'rendering', error: null }, dir)
    srv = await serveMaster(draft)
    const out = join(dir, 'reel.mp4')
    await renderTo(draft, srv.url, out, dir)
    srv.stop(); srv = null

    const name = nextVersionName(draft.tape.performer || draft.source.row?.name, draft.ranges[0].s, await listNames(draft.folders.completed))
    const fileId = await upload(out, draft.folders.completed, name)
    const version = +name.match(/ v(\d+)\.mp4$/)[1]
    await patchDraft(draft, current => ({
      status: 'done',
      error: null,
      exports: [...(current.exports || []), {
        version, name, fileId, url: `https://drive.google.com/file/d/${fileId}/view`, at: new Date().toISOString(), linked: false,
      }],
    }), dir)
    console.log(`exported v${version}`)
  } catch (err) {
    console.error(`render failed: ${shortError(err)}`)
    await patchDraft(draft, { status: 'failed', error: shortError(err) }, dir).catch(() => {})
    process.exitCode = 1
  } finally {
    srv?.stop()
  }
}

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
  style: { ...DEFAULT_STYLE },
}

const argv = process.argv.slice(2)
if (import.meta.url === `file://${process.argv[1]}`) {
  if (argv[0] === '--local') {
    const dir = await workdir()
    await renderTo(FIXTURE, argv[1], argv[2], dir)
    console.log(`wrote ${argv[2]}`)
  } else {
    await main(argv[0])
  }
}
