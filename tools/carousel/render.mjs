#!/usr/bin/env node
// Export a carousel: grab each chosen still from the 4K master at full resolution, crop it to the
// panel, compose each 1080x1350 slide by rendering the SAME markup the editor shows (videoreview/
// carousel-slide.js) in headless Chromium, encode JPEGs and file them as a new "<who> - 2m38 carousel
// vN" folder in the show's completed_clips/.
//
//   node tools/carousel/render.mjs <draftFileId>      (.github/workflows/reel.yml, job: carousel-render)
//
// Public repo: logs carry counts and ids only, and ffmpeg/Chromium failures become fixed messages
// with an exit code (their stderr can echo file names and metadata).

import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { layout, cropPixels, isSoft, nextCarouselName, CAROUSEL_LIMITS } from '../../videoreview/carousel.js'
import { slideHtml } from '../../videoreview/carousel-slide.js'
import { fontById } from '../../videoreview/reel.js'
import { readDraft, patchDraft, serveMaster, listFolders, uploadDir, workdir, FFMPEG, shortError } from '../reel/lib.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const FONTS_DIR = join(ROOT, 'videoreview', 'fonts')
const ICON_SVG = join(ROOT, 'media', 'brand', 'Icon.svg')
const CHROMIUM = () => process.env.NSDS_CHROMIUM || 'chromium'

// How long one program may run before it is killed. A wedged headless Chromium (or an ffmpeg stuck on
// a stalled `rclone serve` read) would otherwise hold the job until the workflow's own timeout.
const CHROMIUM_MS = 90_000
const FFMPEG_MS = 120_000

/**
 * Run a program, discarding its output; a failure is a fixed message plus the exit code. It is killed
 * after `timeoutMs`, and that is a fixed message too.
 */
function exec(what, cmd, args, timeoutMs = FFMPEG_MS) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'ignore'] })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL') }, timeoutMs)
    p.on('error', () => { clearTimeout(timer); reject(new Error(`${what} could not start`)) })
    p.on('close', code => {
      clearTimeout(timer)
      if (timedOut) reject(new Error(`${what} took longer than ${Math.round(timeoutMs / 1000)} s`))
      else if (code === 0) resolve()
      else reject(new Error(`${what} exited ${code}`))
    })
  })
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** The crop rectangle in source pixels, shifted (never shrunk) to lie inside the frame. */
export function cropRect(crop, srcW, srcH) {
  const r = cropPixels(crop, srcW, srcH)
  return { ...r, x: clamp(r.x, 0, Math.max(0, srcW - r.w)), y: clamp(r.y, 0, Math.max(0, srcH - r.h)) }
}

/**
 * One panel image: the frame at time t of `input` (t null = a still image), cropped to `crop` and
 * scaled to 1080x450. Input seek, exactly the recorded time with no offset.
 */
export async function grabPanel(input, t, crop, dims, out) {
  const r = cropRect(crop, dims.w, dims.h)
  const seek = t == null ? [] : ['-ss', Number(t).toFixed(3)]
  await exec('ffmpeg (panel)', FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...seek, '-i', input, '-frames:v', '1',
    '-vf', `crop=${r.w}:${r.h}:${r.x}:${r.y},scale=1080:450:flags=lanczos`, out])
}

const dataUrl = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`

/** Compose each slide in headless Chromium; returns the JPEG paths 01.jpg, 02.jpg, ... */
export async function composeSlides(slides, style, panelPngs, outDir) {
  await mkdir(outDir, { recursive: true })
  const fonts = {
    caption: dataUrl('font/ttf', await readFile(join(FONTS_DIR, fontById(style.font).file))),
    bug: dataUrl('font/ttf', await readFile(join(FONTS_DIR, 'AzeretMono-Bold.ttf'))),
    icon: dataUrl('image/svg+xml', await readFile(ICON_SVG)),
  }
  const jpgs = []
  let n = 0
  for (let k = 0; k < slides.length; k++) {
    const panels = slides[k]
    const images = panels.map(() => ({ src: pathToFileURL(panelPngs[n++]).href }))
    const html = join(outDir, `slide-${k}.html`)
    const png = join(outDir, `slide-${k}.png`)
    await writeFile(html, `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000}</style></head><body>${slideHtml(panels, style, { images, fonts })}</body></html>`)
    // --disable-dev-shm-usage: a container's /dev/shm is 64 MB, which Chromium outgrows and then
    // crashes or hangs. --force-color-profile=srgb: the screenshot's colours are the CSS hex values.
    await exec('chromium', CHROMIUM(), ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--force-color-profile=srgb',
      '--hide-scrollbars', '--force-device-scale-factor=1', '--allow-file-access-from-files', '--virtual-time-budget=5000', '--window-size=1080,1350',
      `--screenshot=${png}`, pathToFileURL(html).href], CHROMIUM_MS)
    const jpg = join(outDir, `${String(k + 1).padStart(2, '0')}.jpg`)
    await exec('ffmpeg (jpeg)', FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', png, '-q:v', '2', jpg])
    jpgs.push(jpg)
  }
  return jpgs
}

async function main(id) {
  const dir = await workdir()
  const draft = await readDraft(id, 'carousel')
  if (!['queued', 'rendering'].includes(draft.status)) {
    console.log(`nothing to render (status ${draft.status})`)
    return
  }
  let srv = null
  try {
    await patchDraft(draft, { status: 'rendering' }, 'carousel')
    const { slides } = layout(draft.lines, draft.fillers)
    const panels = slides.flat()
    if (!panels.length) throw new Error('the carousel has no panels')
    if (panels.length > CAROUSEL_LIMITS.maxPlaced + 2) throw new Error('too many panels')
    if (panels.some(p => !p.still)) throw new Error('a panel has no still: pick one for every panel and export again')
    const dims = draft.dims
    const soft = panels.flatMap((p, i) => (isSoft(p.still.crop, dims.h) ? [i] : []))

    srv = await serveMaster(draft)
    const pngs = []
    for (let i = 0; i < panels.length; i++) {
      const png = join(dir, `panel-${i}.png`)
      await grabPanel(srv.url, panels[i].still.t, panels[i].still.crop, dims, png)
      pngs.push(png)
    }
    srv.stop(); srv = null

    const outDir = join(dir, 'slides')
    const jpgs = await composeSlides(slides, draft.style, pngs, outDir)
    const name = nextCarouselName(draft.tape.performer || draft.source.row?.name, draft.ranges[0].s, await listFolders(draft.folders.completed))
    // The folder holds the JPEGs only; the intermediate html/png stay behind.
    const upDir = join(dir, 'upload')
    await mkdir(upDir)
    for (const j of jpgs) await writeFile(join(upDir, j.split('/').pop()), await readFile(j))
    const folderId = await uploadDir(upDir, draft.folders.completed, name)
    const version = +name.match(/ v(\d+)$/)[1]
    await patchDraft(draft, { status: 'done', export: { version, name, folderId, soft: soft.slice(0, CAROUSEL_LIMITS.maxPlaced) } }, 'carousel')
    console.log(`exported v${version}: ${jpgs.length} slides, ${soft.length} soft`)
  } catch (err) {
    console.error(`render failed: ${shortError(err)}`)
    await patchDraft(draft, { status: 'failed', error: shortError(err) }, 'carousel').catch(() => {})
    process.exitCode = 1
  } finally {
    srv?.stop()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv[2])
