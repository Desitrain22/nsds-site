#!/usr/bin/env node
// Export a reel: cut the ranges from the 4K master, crop to 9:16, burn in the captions and the bug,
// and file the MP4 as a new version in the show's completed_clips/.
//
//   node tools/reel/render.mjs <draftFileId>      (.github/workflows/reel.yml, job: render)
//
// Everything about the picture comes from videoreview/reel.js — the same functions the editor's
// preview paints from — so the export matches what was edited.

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAss, ffmpegArgs, nextVersionName } from '../../videoreview/reel.js'
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

export async function renderTo(draft, input, out, dir) {
  const ass = join(dir, 'captions.ass')
  await writeFile(ass, buildAss(draft))
  await run(FFMPEG, ffmpegArgs(draft, {
    input, ass, fontsDir: FONTS_DIR, icon: await icon(dir), bugFont: join(FONTS_DIR, 'AzeretMono-Bold.ttf'), out,
  }), { quiet: true })
}

async function main(id) {
  const dir = await workdir()
  const draft = await readDraft(id)
  if (!['queued', 'rendering'].includes(draft.status)) {
    console.log(`nothing to render (status ${draft.status})`)
    return
  }
  let srv = null
  try {
    await patchDraft(draft, { status: 'rendering' })
    srv = await serveMaster(draft)
    const out = join(dir, 'reel.mp4')
    await renderTo(draft, srv.url, out, dir)
    srv.stop(); srv = null

    const name = nextVersionName(draft.tape.performer || draft.source.row?.name, draft.ranges[0].s, await listNames(draft.folders.completed))
    const fileId = await upload(out, draft.folders.completed, name)
    const version = +name.match(/ v(\d+)\.mp4$/)[1]
    await patchDraft(draft, { status: 'done', export: { version, name, fileId } })
    console.log(`exported v${version}`)
  } catch (err) {
    console.error(`render failed: ${shortError(err)}`)
    await patchDraft(draft, { status: 'failed', error: shortError(err) }).catch(() => {})
    process.exitCode = 1
  } finally {
    srv?.stop()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv[2])
