#!/usr/bin/env node
/**
 * Local dev server for the tape review app — one command, nothing deployed.
 *
 *   node videoreview/dev-server.mjs        then open http://localhost:8787
 *
 * Stands in for the one production service so the UI can be exercised before it exists:
 *
 *   /api   the Apps Script backend. listTapes is real (via rclone, which is already
 *          authorised for this Drive); clips are stored in a LOCAL JSON FILE.
 *
 * Clips deliberately do NOT go to Google Sheets here. Testing shouldn't write into the sheet
 * your editing team reads, and Apps Script can't run locally anyway. Deploy Code.gs when you
 * want the real thing, then point Settings at the /exec URL.
 *
 * Video comes straight from YouTube, so there's nothing to stand in for.
 *
 *   reel*  the reel editor's actions (reelOpen/reelGet/reelSave/renderReel) against
 *          .dev-reels.json: a draft "transcribes" in 2 s with a fixture sentence spread over
 *          the clip, and an export "renders" in a few seconds. Validation is the REAL
 *          validateReelEditGs, lifted out of Code.gs. Nothing reaches GitHub or Drive.
 *
 * --prod  (demo mode) reads shows, tapes and clip requests from the PRODUCTION Apps Script —
 *          the passphrase you type is checked there — and drafts clips for real, here: the
 *          master is read through rclone and transcribed by WhisperX from
 *          ~/.cache/nsds-reel/venv (NSDS_PYTHON overrides). Writes to the sheet go through
 *          production too, exactly as on the live page. Reel drafts stay in .dev-reels.json.
 *
 * Extra dev-only pages:
 *   /?selftest=1   drives the real UI end to end and prints a report
 *   /playertest    exercises player.js against a public YouTube video
 *
 * Zero dependencies, same as the rest of tools/ here.
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { extname, join, dirname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MEDIA_ROOT_ID, BACKEND_URL, isExcluded, parseShowFolderName, sortShows } from './shows.js'
import { buildDraft } from '../tools/reel/draft.mjs'
import { workdir } from '../tools/reel/lib.mjs'
import { homedir } from 'node:os'
import { pickTapesRoot, pickTapes, MAX_DEPTH } from './tapes.js'
import { legacyKey, autoBreaks, fillTimings, nextVersionName, rangesChanged, DEFAULT_STYLE } from './reel.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 8787)
// Deliberately NOT the real passphrase — this file is committed to a public repo. Pass the
// production one in when you want to test against it:
//   NSDS_PASSWORD='the real phrase' node videoreview/dev-server.mjs
const PASSWORD = process.env.NSDS_PASSWORD || 'dev'
const STORE = join(HERE, '.dev-clips.json')
// The portal's key. Deliberately not the review passphrase — Code.gs gates the upload actions on
// a separate property, and the dev server has to mirror that or the split goes untested.
const UPLOAD_KEY = process.env.NSDS_UPLOAD_KEY || 'devupload'
const SUB_STORE = join(HERE, '.dev-submissions.json')
const RCLONE = ['/opt/homebrew/bin/rclone', 'rclone'].find(p => p === 'rclone' || existsSync(p))
const REMOTE = 'nsdsdrive'

const MIME = { '.ttf': 'font/ttf', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
               '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml' }

const loadStore = () => { try { return JSON.parse(readFileSync(STORE, 'utf8')) } catch { return {} } }
const saveStore = d => writeFileSync(STORE, JSON.stringify(d, null, 2))

function rclone(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(RCLONE, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve(out)
      : reject(new Error(`rclone exited ${code}: ${err.trim().split('\n').slice(-2).join(' | ')}`)))
  })
}

const tapeCache = new Map()
const CACHE_MS = 60_000

/**
 * Mirrors Code.gs listShows: every "<Month> <YYYY> (City)" folder under Media/<year>/, with its
 * standard subfolders and request sheet resolved by name. Two rclone listings (folders to depth 3,
 * spreadsheets whose name says request/clips), cached for the life of the process.
 */
let showsCache = null
const rid = e => String(e.ID).split('\t')[0]
async function listShows() {
  if (showsCache) return showsCache
  const base = ['lsjson', '--drive-root-folder-id', MEDIA_ROOT_ID, '-R', '--max-depth', '3', '--fast-list']
  const dirs = JSON.parse(await rclone([...base, '--dirs-only', `${REMOTE}:`]))
  const files = JSON.parse(await rclone([...base, '--files-only', '--include', '*equest*', '--include', '*lips*', `${REMOTE}:`]))
  const shows = []
  for (const d of dirs) {
    const parts = d.Path.split('/')
    if (parts.length !== 2 || !/^\d{4}$/.test(parts[0])) continue
    const meta = parseShowFolderName(d.Name)
    if (!meta) continue
    const show = { folderId: rid(d), name: d.Name, ...meta, tapesFolderId: null, photosFolderId: null, completedClipsFolderId: null, extrasFolderId: null, sheetId: null, legacySheetId: null }
    for (const sub of dirs.filter(x => x.Path.startsWith(d.Path + '/') && x.Path.split('/').length === 3)) {
      const n = sub.Name.toLowerCase().replace(/[\s-]+/g, '_')
      const key = { tapes: 'tapesFolderId', photos: 'photosFolderId', completed_clips: 'completedClipsFolderId', extras: 'extrasFolderId' }[n]
      if (key && !show[key]) show[key] = rid(sub)
    }
    const isSheet = f => /spreadsheet/.test(f.MimeType || '')
    const inRoot = files.find(f => isSheet(f) && f.Path === `${d.Path}/${f.Name}` && /request/i.test(f.Name))
    if (inRoot) show.sheetId = rid(inRoot)
    const inExtras = files.find(f => isSheet(f) && f.Path.startsWith(`${d.Path}/extras/`) && /request|clips/i.test(f.Name))
    if (inExtras) show.legacySheetId = rid(inExtras)
    shows.push(show)
  }
  showsCache = { ok: true, shows: sortShows(shows), scannedAt: new Date().toISOString() }
  return showsCache
}

/** Mirrors Code.gs listTapes: one subfolder deep, video mime types only, minus the reels. */
async function lsjson(folderId, depth) {
  // --fast-list halves the wall time, and rclone's shared client_id is rate-limited.
  const raw = await rclone(['lsjson', '--drive-root-folder-id', folderId, '-R',
                            '--max-depth', String(depth), '--fast-list', `${REMOTE}:`])
  return JSON.parse(raw)
}

/**
 * Mirrors Code.gs listTapes: resolve the tapes root (pinned > the one tapes-like subfolder > the
 * show folder), then scan it with the shared rule in tapes.js — so finished clips in
 * completed_clips/ are never offered as tapes here either.
 */
async function listTapes(folderId, tapesFolderId, completedClipsFolderId) {
  const key = `${folderId}|${tapesFolderId || ''}|${completedClipsFolderId || ''}`
  const hit = tapeCache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value

  // Same youtube.csv the backend reads, written by tools/youtube-sync.mjs.
  const youtube = {}
  try {
    const csv = await rclone(['cat', '--drive-root-folder-id', folderId, `${REMOTE}:youtube.csv`])
    for (const line of csv.split(/\r?\n/).slice(1)) {
      const c = line.split(',')
      if (c[0] && c[3]) youtube[c[0]] = c[3]
    }
  } catch { /* no csv yet */ }

  const top = await lsjson(folderId, 1)
  const root = pickTapesRoot(top, tapesFolderId || null)
  const entries = root.id ? await lsjson(root.id, MAX_DEPTH + 1) : top.concat(await lsjson(folderId, MAX_DEPTH + 1))
  const seen = new Set()
  const tapes = pickTapes(entries, name => isExcluded(name))
    .filter(e => !seen.has(e.ID) && seen.add(e.ID))
    .map(e => {
      const id = String(e.ID).split('\t')[0]
      return {
        fileId: id,
        name: e.Name,
        folderName: e.Path.includes('/') ? e.Path.split('/')[0] : null,
        size: e.Size,
        isPublic: true,
        youtubeId: youtube[id] || null,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
  const rootEntry = root.id ? top.find(e => String(e.ID).split('\t')[0] === root.id) : null
  // Mirrors Code.gs listFinishedClips: the show's completed_clips/ folder, videos only, one level.
  let finishedClips = null
  if (completedClipsFolderId) {
    try {
      finishedClips = (await lsjson(completedClipsFolderId, 1))
        .filter(e => !e.IsDir && /^video\//.test(e.MimeType || ''))
        .map(e => { const id = String(e.ID).split('\t')[0]; return { fileId: id, name: e.Name, size: e.Size, url: `https://drive.google.com/file/d/${id}/view` } })
        .sort((a, b) => a.name.localeCompare(b.name))
    } catch { finishedClips = null }
  }
  const value = { ok: true, tapes, finishedClips, tapesRoot: { id: root.id || folderId, name: rootEntry ? rootEntry.Name : '(show folder)', mode: root.mode } }
  tapeCache.set(key, { at: Date.now(), value })
  return value
}

const fmt = s => {
  const t = Math.round(Number(s) || 0)
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}
const hasTimeRange = t => /\d{1,2}(?::\d{1,2}){0,2}\s*[-–—]\s*\d{1,2}(?::\d{1,2}){0,2}/.test(String(t || ''))

/** Same A-G rendering rules as Code.gs, so what you see here is what the sheet will say. */
function renderRow(clip, ranges) {
  let granular
  if (ranges.length > 1) granular = ranges.map(r => `${fmt(r.s)} - ${fmt(r.e)}`).join(', ')
  else if (hasTimeRange(clip.granular)) granular = ''
  else granular = clip.granular || ''
  return { name: clip.name || '', start: fmt(ranges[0].s), end: fmt(ranges[ranges.length - 1].e), granular }
}

const loadSubs = () => { try { return JSON.parse(readFileSync(SUB_STORE, 'utf8')) } catch { return {} } }
const saveSubs = d => writeFileSync(SUB_STORE, JSON.stringify(d, null, 2))

/**
 * A seeded stand-in for a Dropbox folder, so the confirm table is stable across reloads and the
 * states you cannot otherwise reach are reachable. Real enumeration needs the live private
 * endpoint; that is Code.gs's job in production and tools/nsds_fetch.py's on a laptop.
 *
 *   ?partial=1     the listing came back short  -> the refusal path, which is the whole design
 *   ?photosonly=1  no video at all
 *   ?empty=1       nothing there
 */
function fakeDropbox(link) {
  const url = new URL(link)
  const seed = [...(url.pathname.match(/[a-z0-9]/gi) || [])].reduce((n, c) => n + c.charCodeAt(0), 0)
  const rand = i => ((seed * (i + 7) * 2654435761) % 1000) / 1000
  const names = ['AndrewG', 'Karthik', 'NateM', 'Neal P', 'PeterB', 'PeterL', 'Sristi', 'Victoria', 'Yanjaa']
  const entries = []
  if (url.searchParams.get('empty') === '1') return { entries, reported: 0 }
  if (url.searchParams.get('photosonly') !== '1') {
    names.forEach((n, i) => entries.push({ path: `/${n}_10-14-25.mp4`, bytes: Math.round(3e9 + rand(i) * 6e9) }))
    entries.push({ path: '/AI_10-14 SIZZLE.mp4', bytes: 52_000_000 })
  }
  for (let i = 1; i <= 104; i++) entries.push({ path: `/photos/NSDS-${i}.jpg`, bytes: Math.round(8e6 + rand(i) * 2e7) })
  entries.push({ path: '/.DS_Store', bytes: 6148 })
  const reported = entries.length
  if (url.searchParams.get('partial') === '1') return { entries: entries.slice(0, entries.length - 12), reported }
  return { entries, reported }
}

async function uploadApi(body) {
  // Trimmed, matching checkUpload in Code.gs — the dev server exists to catch this kind of
  // mismatch before it reaches production, so it has to compare the same way.
  if (String(body.uploadKey || '').trim() !== UPLOAD_KEY.trim()) {
    return { ok: false, error: 'that upload key is wrong' }
  }
  switch (body.action) {
    case 'uploadShows': {
      const { shows } = await listShows()
      return { ok: true, shows: (shows || []).map(s => ({
        folderId: s.folderId, name: s.name, label: s.label,
        month: s.month, year: s.year, city: s.city, tapesFolderId: s.tapesFolderId,
      })) }
    }
    case 'uploadPreview': {
      const link = String(body.link || '')
      if (/drive\.google\.com/.test(link)) {
        const id = (/\/folders\/([A-Za-z0-9_-]+)/.exec(link) || [])[1]
        if (!id) return { ok: false, error: 'no folder id in that link' }
        const raw = await rclone(['lsjson', '--drive-root-folder-id', id, '-R', '--max-depth', '3', '--fast-list', `${REMOTE}:`])
        const entries = JSON.parse(raw).filter(e => !e.IsDir).map(e => ({ path: '/' + e.Path, bytes: e.Size }))
        return { ok: true, source: 'drive', entries, fileCount: entries.length,
                 totalBytes: entries.reduce((n, e) => n + e.bytes, 0), complete: true }
      }
      const { entries, reported } = fakeDropbox(link)
      const complete = entries.length === reported
      return {
        ok: true, source: 'dropbox', entries, fileCount: entries.length, reportedCount: reported,
        totalBytes: entries.reduce((n, e) => n + e.bytes, 0), complete,
        incomplete: complete ? undefined : { reason: `got ${entries.length} of ${reported} files` },
      }
    }
    case 'uploadCreateShow': {
      const subs = loadSubs()
      const key = String(body.submissionKey || '')
      if (!key) return { ok: false, error: 'submissionKey is required' }
      if (subs[key]) return { ...subs[key], duplicate: true }
      const folderName = body.folderName || `${body.month}/${body.year}`
      const rec = {
        ok: true, submissionId: `dev-${Date.now()}-${key.slice(0, 8)}`, submissionKey: key,
        createdAt: new Date().toISOString(),
        source: { kind: body.source, link: body.link },
        show: { folderId: 'dev-folder-' + key.slice(0, 6), folderName, created: true,
                year: body.year, month: body.month, city: body.city || null,
                sheetId: null, sheetUrl: null },
        manifest: body.manifest || [], existing: [], status: 'pending',
      }
      subs[key] = rec
      saveSubs(subs)
      console.log(`  filed ${folderName} — ${(body.manifest || []).length} files`)
      return rec
    }
    case 'uploadStatus': {
      const subs = loadSubs()
      if (body.submissionKey) {
        const rec = subs[String(body.submissionKey)]
        return rec ? { ok: true, found: true, submission: rec } : { ok: true, found: false }
      }
      return { ok: true, submissions: Object.values(subs).map(r => ({
        submissionId: r.submissionId, submissionKey: r.submissionKey, createdAt: r.createdAt,
        folderName: r.show.folderName, status: r.status, files: (r.manifest || []).length })) }
    }
    default:
      return { ok: false, error: 'unknown upload action: ' + body.action }
  }
}

// ---------------------------------------------------------------- reels --
// The backend's own validators, run here so the dev server can't be laxer than production.
const REEL_STORE = join(HERE, '.dev-reels.json')
const loadReels = () => { try { return JSON.parse(readFileSync(REEL_STORE, 'utf8')) } catch { return {} } }
const saveReels = d => writeFileSync(REEL_STORE, JSON.stringify(d, null, 2))
const GS = (() => {
  const gs = readFileSync(join(HERE, 'apps-script', 'Code.gs'), 'utf8')
  const fn = n => gs.slice(gs.indexOf(`function ${n}(`), gs.indexOf('\n}\n', gs.indexOf(`function ${n}(`)) + 2)
  const names = ['validateRangesGs', 'validateReelEditGs', 'hexToAssGs']
  return new Function(gs.match(/var REEL_[A-Z_]+ = .*?;/g).join('\n') + names.map(fn).join('\n') + `\nreturn { ${names.join(', ')} }`)()
})()
const SAY = "so I told my manager the model is learning and he said great so am I and then he fired the model and kept me which honestly is the nicest thing a company has ever done for a robot".split(' ')

function reelPatchLater(id, ms, patch) {
  setTimeout(() => {
    const all = loadReels()
    if (!all[id]) return
    all[id] = { ...all[id], ...(typeof patch === 'function' ? patch(all[id]) : patch), updatedAt: new Date().toISOString() }
    saveReels(all)
    console.log(`  reel ${id.slice(0, 10)} -> ${all[id].status}`)
  }, ms)
}

// ---------------------------------------------------------------- --prod --
const PROD = process.argv.includes('--prod') || process.env.NSDS_PROD === '1'
const LOCAL_PY = join(homedir(), '.cache', 'nsds-reel', 'venv', 'bin', 'python')
if (PROD && !process.env.NSDS_PYTHON && existsSync(LOCAL_PY)) process.env.NSDS_PYTHON = LOCAL_PY

async function prodCall(body) {
  const res = await fetch(BACKEND_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) })
  return res.json()
}
const goodPasswords = new Set()
async function prodAuth(password) {
  if (goodPasswords.has(password)) return true
  const res = await prodCall({ action: 'ping', password })
  if (res.ok) goodPasswords.add(password)
  return !!res.ok
}

/** Where the master lives: the folder rclone serve needs, found by walking the show folder. */
async function findMaster(showFolderId, fileId) {
  const out = await rclone(['lsjson', '-R', '--max-depth', '3', '--drive-root-folder-id', showFolderId, `${REMOTE}:`])
  const all = JSON.parse(out)
  const hit = all.find(e => !e.IsDir && rid(e) === fileId)
  if (!hit) throw new Error('could not find the tape in the show folder')
  const parentPath = hit.Path.includes('/') ? hit.Path.slice(0, hit.Path.lastIndexOf('/')) : ''
  const parent = parentPath ? all.find(e => e.IsDir && e.Path === parentPath) : null
  return { fileId, name: hit.Name, parentId: parent ? rid(parent) : showFolderId }
}

/** A real draft, on this machine: the same buildDraft() the GitHub job runs. */
async function localDraft(id) {
  const started = Date.now()
  const patch = p => { const all = loadReels(); all[id] = { ...all[id], ...p, updatedAt: new Date().toISOString() }; saveReels(all) }
  try {
    const d = loadReels()[id]
    const master = await findMaster(d.show.folderId, d.tape.fileId)
    patch({ master })
    console.log(`  drafting ${d.tape.performer || ''} ${d.source.span.s}-${d.source.span.e}s from ${master.name} …`)
    const built = await buildDraft({ ...d, master }, await workdir())
    patch({ status: 'ready', error: null, ...built, draftedAt: new Date().toISOString() })
    console.log(`  draft ready: ${built.words.length} words in ${Math.round((Date.now() - started) / 1000)}s`)
  } catch (err) {
    console.error(`  ! draft failed: ${err.message}`)
    patch({ status: 'failed', error: String(err.message).split('\n')[0].slice(0, 300) })
  }
}

function reelApi(body) {
  const all = loadReels()
  switch (body.action) {
    case 'reelOpen': {
      const vr = GS.validateRangesGs(body.ranges)
      if (!vr.ok) return vr
      const key = body.clipId || legacyKey(body.row || {})
      const existing = Object.values(all).find(d => d.key === key && d.show.folderId === body.folderId)
      if (existing && !body.redraft) return { ok: true, draft: { ...existing, requestChanged: rangesChanged(existing.source.ranges, vr.ranges) } }
      const id = existing?.id || `dev${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`.padEnd(24, '0')
      const span = { s: vr.ranges[0].s, e: vr.ranges[vr.ranges.length - 1].e }
      all[id] = {
        id, key, v: 1, status: 'drafting', error: null, rev: (existing?.rev || 0) + 1,
        show: { folderId: body.folderId, label: body.showLabel },
        source: { clipId: body.clipId || null, row: body.row || null, ranges: vr.ranges, span, notes: body.notes || '', granular: body.granular || '' },
        tape: body.tape, ranges: vr.ranges, words: [], breaks: [],
        style: existing?.style || DEFAULT_STYLE, exports: existing?.exports || [], updatedAt: new Date().toISOString(),
      }
      saveReels(all)
      if (PROD) { localDraft(id); return { ok: true, draft: all[id] } }
      // "Transcribe": the fixture sentence spread over the request, one word made untimed like a number.
      reelPatchLater(id, 2000, d => {
        const len = span.e - span.s
        const words = fillTimings(SAY.map((text, i) => i === 7
          ? { text: '2014' }
          : { text, s: span.s + (i / SAY.length) * len, e: span.s + ((i + 0.8) / SAY.length) * len }))
        return { status: 'ready', words, breaks: autoBreaks(words) }
      })
      return { ok: true, draft: all[id] }
    }
    case 'reelGet': {
      const d = all[body.draftId]
      if (!d) return { ok: false, error: 'not a reel draft' }
      const last = d.exports[d.exports.length - 1]
      if (d.status === 'done' && last && !last.linked) { last.linked = true; saveReels(all) }
      return { ok: true, draft: d }
    }
    case 'reelSave':
    case 'renderReel': {
      const d = all[body.draftId]
      if (!d) return { ok: false, error: 'not a reel draft' }
      if (['drafting', 'queued', 'rendering'].includes(d.status)) return { ok: false, error: `this draft is busy (${d.status})` }
      if (Number(body.rev) !== d.rev) return { ok: false, error: 'conflict', conflict: true, currentRev: d.rev }
      const v = GS.validateReelEditGs(body.edit, d)
      if (!v.ok) return v
      v.words.forEach((t, i) => { d.words[i].text = t })
      Object.assign(d, { breaks: v.breaks, ranges: v.ranges, style: v.style, rev: d.rev + 1, updatedAt: new Date().toISOString() })
      if (body.action === 'renderReel') {
        d.status = 'queued'
        console.log(`  render ${d.id.slice(0, 10)}: ${v.style.font} fill ${v.style.ass.fill} highlight ${v.style.ass.highlight}`)
        reelPatchLater(d.id, 1500, { status: 'rendering' })
        reelPatchLater(d.id, 4500, cur => {
          const name = nextVersionName(cur.tape?.performer, cur.ranges[0].s, cur.exports.map(x => x.name))
          const version = +name.match(/ v(\d+)\.mp4$/)[1]
          return { status: 'done', exports: [...cur.exports, { version, name, fileId: 'dev', url: 'https://example.com/dev-export', at: new Date().toISOString(), linked: false }] }
        })
      }
      saveReels(all)
      return { ok: true, rev: d.rev, draft: d }
    }
  }
  return { ok: false, error: `unknown action: ${body.action}` }
}

async function api(body) {
  const isReel = /^(reel|renderReel$)/.test(String(body.action || ''))
  if (PROD) {
    if (isReel) return (await prodAuth(body.password)) ? reelApi(body) : { ok: false, error: 'bad password' }
    if (/^(upload|admin)/.test(String(body.action || ''))) return { ok: false, error: 'not available in --prod demo mode' }
    return prodCall(body)
  }
  if (/^upload/.test(String(body.action || ''))) return uploadApi(body)
  if (isReel) {
    if (String(body.password || '') !== PASSWORD) return { ok: false, error: 'bad password' }
    return reelApi(body)
  }
  if (String(body.password || '') !== PASSWORD) return { ok: false, error: 'bad password' }
  const key = body.folderId
  const store = loadStore()
  store[key] = store[key] || []

  switch (body.action) {
    // Matches Code.gs: the gate's password check, with no Drive work behind it.
    case 'ping':
      return { ok: true }
    case 'listShows':
      return listShows()

    case 'listTapes':
      return listTapes(body.folderId, body.tapesFolderId || null, body.completedClipsFolderId || null)

    case 'getClips': {
      const clips = body.videoFileId
        ? store[key].filter(c => c.videoFileId === body.videoFileId)
        : store[key]
      return { ok: true, sheetExists: true, sheetUrl: null, clips: clips.map(c => ({ clipLinks: [], ...c })), legacy: [] }
    }

    case 'saveClip': {
      const clip = body.clip || {}
      const ranges = (clip.ranges || []).slice().sort((a, b) => a.s - b.s)
      if (!ranges.length) return { ok: false, error: 'a clip needs at least one range' }
      for (let i = 0; i < ranges.length; i++) {
        if (!(ranges[i].e > ranges[i].s)) return { ok: false, error: `range ${i + 1} ends at or before it starts` }
        if (clip.duration && ranges[i].e > Number(clip.duration) + 1) {
          return { ok: false, error: `range ${i + 1} runs past the end of the tape` }
        }
      }
      const row = renderRow(clip, ranges)
      const at = store[key].findIndex(c => c.clipId === clip.clipId)
      const rev = (at >= 0 ? Number(store[key][at].rev || 0) : 0) + 1
      const record = { ...clip, ranges, rev, ...row, updatedAt: new Date().toISOString() }
      if (at >= 0) store[key][at] = record; else store[key].push(record)
      saveStore(store)
      console.log(`  saved ${clip.clipId.slice(0, 8)} — ${row.start} → ${row.end}` +
        (row.granular ? `  D="${row.granular}"` : ''))
      return { ok: true, row: (at >= 0 ? at : store[key].length - 1) + 5, rev, sheetUrl: null }
    }

    case 'deleteClip': {
      const before = store[key].length
      store[key] = store[key].filter(c => c.clipId !== body.clipId)
      saveStore(store)
      return { ok: true, alreadyGone: before === store[key].length }
    }

    default:
      return { ok: false, error: `unknown action: ${body.action}` }
  }
}

// Seed the backend URL so there is nothing to configure by hand.
const BOOTSTRAP = `
<script>
(function () {
  var K = 'nsds-review-config';
  var want = { endpoint: location.origin + '/api' };
  var have = {};
  try { have = JSON.parse(localStorage.getItem(K) || '{}'); } catch (e) {}
  if (have.endpoint !== want.endpoint) localStorage.setItem(K, JSON.stringify(want));
})();
</script>
`

// Drives the REAL index.html + app.js, so the DOM wiring is exercised rather than the modules
// in isolation. Video assertions live in /playertest instead, since the tapes may not be
// uploaded yet.
const SELFTEST = `
<script type="module">
const L = [];
let pass = 0, fail = 0;
const log = s => { L.push(s); };
const ck = (l, c, d) => { c ? (pass++, log('  ok   ' + l + (d ? ' — ' + d : '')))
                            : (fail++, log('  FAIL ' + l + (d ? ' — ' + d : ''))); };
const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 60000)) { const v = fn(); if (v) return v; await sleep(150); }
  throw new Error('timed out waiting for ' + label);
}
window.addEventListener('load', async () => {
  try {
    log('-- gate --');
    ck('gate showing', !$('#gate').hidden);
    $('#gate-input').value = ${JSON.stringify(PASSWORD)};
    $('#gate-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await until(() => !$('#app').hidden, 'unlock');
    ck('unlocked', $('#gate').hidden && !$('#app').hidden);

    log('\\n-- story 1: year -> show -> tape --');
    const shows = await until(() => {
      const c = [...$('#shows').querySelectorAll('.chip')]; return c.length ? c : null;
    }, 'show chips');
    ck('9 shows listed', shows.length === 9, shows.length + '');
    const april = shows.find(b => /April/.test(b.textContent));
    ck('April present', !!april);
    april.click();
    const tapes = await until(() => {
      const t = [...$('#tapes').querySelectorAll('.tape')]; return t.length ? t : null;
    }, 'tapes');
    ck('8 set tapes listed (intro is in extras/)', tapes.length === 8, tapes.length + '');
    const names = tapes.map(t => t.querySelector('strong').textContent);
    ck('names cleaned', names.includes('Alberta') && names.includes('S.') && !names.includes('Mayberry (intro)'), names.join(', '));
    ck('Photos link points at photos/', !$('#photos-link').hidden && $('#photos-link').href.includes('1CFeeKKfdLrLTXNGBUvfmMGCQNEZgg9Eq'), $('#photos-link').href);
    ck('no note for April', $('#tapes-note').hidden);
    ck('no settings UI anywhere', !document.querySelector('#open-settings, #gate-settings, dialog#settings'));
    ck('tape buttons show the performer only', tapes.every(t => !/GB|\.mp4/i.test(t.textContent)), tapes[0].textContent);

    tapes.find(t => /DavidS/.test(t.textContent)).click();
    await until(() => !$('#review').hidden, 'review view');
    ck('review view opened', !$('#review').hidden);
    ck('deep link written (by folder id)', /show=1bS6gBq5vcLFbbGNG/.test(location.search), location.search);
    ck('open tape is marked in the grid', $('#tapes').querySelectorAll('.tape.on').length === 1,
       $('#tapes').querySelectorAll('.tape.on').length + ' marked');

    log('\\n-- story 2: a slow show response must never paint over a newer one --');
    // Both cold, so the two listings really are in flight together. Before the nav guard the last
    // response to arrive won, which put one show's tapes under the other show's heading — and
    // opening one of them sent that fileId to the OTHER show's sheet.
    const chip = label => shows.find(b => new RegExp(label).test(b.textContent));
    const gridNames = () => [...$('#tapes').querySelectorAll('.tape')]
      .map(t => t.querySelector('strong').textContent).join('|');
    chip('May').click();
    await sleep(30);
    chip('July').click();
    await until(() => $('#tapes').getAttribute('aria-busy') === null
                   && $('#tapes').querySelectorAll('.tape').length > 0, 'July tapes', 90000);
    const raced = gridNames();
    await sleep(2500);   // long enough for May's listing to land if it were going to
    ck('grid still shows the show that was clicked last', gridNames() === raced, gridNames());
    ck('crumbs agree with the grid', /July/.test($('#crumbs').textContent), $('#crumbs').textContent);

    log('\\n-- story 3: leaving a tape blanks the video --');
    const jTapes = [...$('#tapes').querySelectorAll('.tape')];
    jTapes[0].click();
    await until(() => $('.frame').dataset.state !== 'idle', 'frame leaves idle');
    jTapes[1].click();
    // The moment a different tape is picked the frame must stop showing the old one. Previously
    // the iframe kept the previous performer loaded and playable under the new performer's name.
    ck('frame is not ready the instant another tape is opened',
       $('.frame').dataset.state !== 'ready', $('.frame').dataset.state);
    ck('the newly opened tape is the marked one', $('#tapes').querySelector('.tape.on') === jTapes[1]);

    chip('April').click();
    ck('review closes when you change show', $('#review').hidden);
    ck('player unloaded', $('.frame').dataset.state !== 'ready', $('.frame').dataset.state);
    ck('stop button cleared', $('#stop-ranges').hidden);
    ck('sheet link cleared', $('#sheet-link').hidden);
    ck('timeline cleared', $('#timeline').children.length === 0);
    await until(() => $('#tapes').querySelectorAll('.tape').length > 0, 'back to April', 90000);
    [...$('#tapes').querySelectorAll('.tape')][0].click();
    await until(() => !$('#review').hidden, 'review again');
    await until(() => $('#clip-list').getAttribute('aria-busy') === null
                   && !$('#clip-list').classList.contains('muted'), 'clips loaded');

    log('\\n-- clip editor works even with no video loaded --');
    $('#new-clip').click();
    const card = await until(() => $('#clip-list').querySelector('.clip'), 'new clip card');
    ck('card created', !!card);
    card.querySelector('.start').value = '1:40';
    card.querySelector('.start').dispatchEvent(new Event('change', { bubbles: true }));
    ck('Save survives a timestamp change', document.contains(card.querySelector('.save')));
    card.querySelector('.end').value = '2:10';
    card.querySelector('.end').dispatchEvent(new Event('change', { bubbles: true }));

    // Adding a range used to re-render the whole list, throwing away every input in it — so the
    // caret jumped out of the field you were typing in. The card must be the SAME element after.
    const notes = card.querySelector('.notes');
    notes.focus();
    card.querySelector('.add-range').click();
    const card2 = $('#clip-list').querySelector('.clip');
    ck('adding a range keeps the same card', card2 === card);
    ck('adding a range keeps focus where it was', document.activeElement === notes,
       document.activeElement.className);
    const rows = card2.querySelectorAll('.range');
    ck('second range added', rows.length === 2, rows.length + ' ranges');
    ck('rows are numbered once there are two',
       rows[0].querySelector('.range-label').textContent === '1.',
       rows[0].querySelector('.range-label').textContent);
    rows[1].querySelector('.start').value = '3:15';
    rows[1].querySelector('.start').dispatchEvent(new Event('change', { bubbles: true }));
    rows[1].querySelector('.end').value = '3:30';
    rows[1].querySelector('.end').dispatchEvent(new Event('change', { bubbles: true }));
    ck('summary shows 2 parts', /2 parts/.test(card2.querySelector('.clip-summary').textContent),
       card2.querySelector('.clip-summary').textContent);

    // Dropping the FIRST of three must remove that one, not the last — the old code captured the
    // row index at render time, so it deleted the wrong range once anything had shifted.
    card2.querySelector('.add-range').click();
    const three = card2.querySelectorAll('.range');
    three[2].querySelector('.start').value = '9:00';
    three[2].querySelector('.start').dispatchEvent(new Event('change', { bubbles: true }));
    three[2].querySelector('.end').value = '9:30';
    three[2].querySelector('.end').dispatchEvent(new Event('change', { bubbles: true }));
    three[0].querySelector('.drop-range').click();
    const left = [...card2.querySelectorAll('.range')].map(r => r.querySelector('.start').value);
    ck('dropping the first range drops the right one', left.join(',') === '3:15,9:00', left.join(','));

    card2.querySelector('.save').click();
    const msg = await until(() => {
      const t = card2.querySelector('.clip-msg').textContent;
      return /Saved|error|conflict|past|missing/i.test(t) ? t : null;
    }, 'save');
    ck('saved on first click', /Saved/i.test(msg), msg);

    log('\\n-- reels: draft, regroup, restyle, export --');
    card2.querySelector('.make-reel').click();
    await until(() => $('#reel').open, 'reel dialog');
    ck('reel editor opens over the review', $('#reel').open);
    await until(() => $('#reel').dataset.status === 'ready', 'draft ready', 15000);
    const words = [...$('#reel-tx').querySelectorAll('.w')];
    ck('transcript arrived', words.length > 10, words.length + ' words');
    ck('an untimed word is marked as estimated', $('#reel-tx').querySelectorAll('.w.est').length === 1);
    ck('auto breaks shown', $('#reel-tx').querySelectorAll('.seam.brk').length > 2);
    const seams = [...$('#reel-tx').querySelectorAll('.seam')];
    const firstPlain = seams.find(x => !x.classList.contains('brk'));
    const before = $('#reel-tx').querySelectorAll('.seam.brk').length;
    firstPlain.click();
    ck('clicking a seam adds a break', $('#reel-tx').querySelectorAll('.seam.brk').length === before + 1);
    ck('editing marks unsaved', /Unsaved/.test($('#reel-msg').textContent));
    words[3].click();
    ck('clicking a word paints its caption', $('#reel-cap').textContent.length > 0, $('#reel-cap').textContent);
    const font = $('#reel-font');
    ck('five fonts offered', font.options.length === 5);
    font.value = 'anton'; font.dispatchEvent(new Event('change'));
    ck('font applies to the preview', /Reel anton/.test($('#reel-cap').style.fontFamily), $('#reel-cap').style.fontFamily);
    $('#reel-fill').querySelectorAll('button')[1].click();
    ck('text colour applies', $('#reel-cap').querySelector('span')?.style.color !== '', $('#reel-cap').innerHTML.slice(0, 80));
    $('#reel-save').click();
    await until(() => /Saved/.test($('#reel-msg').textContent) || /error/.test($('#reel-msg').className), 'reel save');
    ck('draft saved', /Saved/.test($('#reel-msg').textContent), $('#reel-msg').textContent);
    $('#reel-export').click();
    await until(() => $('#reel').dataset.status === 'done', 'export done', 30000);
    ck('export finished', /Exported v1/.test($('#reel-status').textContent), $('#reel-status').textContent);
    await until(() => /linked in the sheet/.test($('#reel-exports').textContent), 'link appended', 15000);
    ck('export listed and linked', /reel v1\\.mp4/.test($('#reel-exports').textContent), $('#reel-exports').textContent);
    $('#reel-close').click();
    ck('closing returns to the review', !$('#reel').open);
  } catch (e) { fail++; log('\\nTHREW: ' + e.message); }
  log('\\n' + pass + ' passed, ' + fail + ' failed');
  navigator.sendBeacon('/selftest-result', L.join('\\n'));
});
</script>
`

// Exercises player.js against a public YouTube video, so the IFrame integration is verified
// without needing any tape uploaded. "Me at the zoo" — 19s, stable, embeddable.
const PLAYERTEST = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>player test</title></head>
<body style="font:13px monospace;background:#2e1a42;color:#ffffc0">
<div style="width:480px"><div id="mount"></div></div><pre id="out">running…</pre>
<script type="module">
import { Player } from './player.js';
const out = document.getElementById('out'), L = [];
const log = s => { L.push(s); out.textContent = L.join('\\n'); };
let pass = 0, fail = 0;
const ck = (l, c, d) => { c ? (pass++, log('  ok   ' + l + (d ? ' — ' + d : '')))
                            : (fail++, log('  FAIL ' + l + (d ? ' — ' + d : ''))); };
(async () => {
  try {
    const p = new Player(document.getElementById('mount'));
    log('-- load --');
    const d = await p.load('jNQXAC9IVRw');
    ck('duration read', d > 0, d + 's');

    log('\\n-- "now" + seek --');
    await p.seek(10);
    ck('seek to 10s', Math.abs(p.now() - 10) < 0.6, 'now()=' + p.now().toFixed(2));
    await p.seek(4);
    ck('seek back to 4s', Math.abs(p.now() - 4) < 0.6, 'now()=' + p.now().toFixed(2));

    log('\\n-- play two ranges then pause --');
    const seen = [];
    await p.playRanges([{ s: 2, e: 4 }, { s: 8, e: 10 }], { onEnter: (i, r) => seen.push(i + '@' + r.s) });
    ck('entered both in order', seen.join(' ') === '0@2 1@8', seen.join(' '));
    ck('paused at the end', p.paused);
    ck('stopped near the last range end', Math.abs(p.now() - 10) < 1.2, 'now()=' + p.now().toFixed(2));

    log('\\n-- cancel --');
    const run = p.playRanges([{ s: 0, e: 19 }]);
    await new Promise(r => setTimeout(r, 700));
    p.cancel(); p.pause(); await run;
    ck('cancel stops it', p.paused, 'at ' + p.now().toFixed(2));

    log('\\n-- unload blanks the frame, which is what stops the PREVIOUS tape showing --');
    ck('hasVideo while loaded', p.hasVideo);
    p.unload();
    ck('hasVideo false after unload', !p.hasVideo);
    ck('paused after unload', p.paused);

    log('\\n-- a superseded load never reports the new video as its own --');
    const a = p.load('jNQXAC9IVRw');
    const b = p.load('jNQXAC9IVRw');
    const both = await Promise.all([a, b]);
    ck('superseded load resolves null', both[0] === null, String(both[0]));
    ck('latest load resolves a duration', both[1] > 0, String(both[1]));

    log('\\n-- a bad id reports something useful --');
    let m = '';
    try { await p.load('!!!!!!!!!!!'); } catch (e) { m = e.message; }
    ck('error surfaced', m.length > 0, m);
  } catch (e) { fail++; log('THREW: ' + e.message); }
  log('\\n' + pass + ' passed, ' + fail + ' failed');
  navigator.sendBeacon('/playertest-result', L.join('\\n'));
})();
</script></body></html>`

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const path = url.pathname

  try {
    for (const [route, label] of [['/selftest-result', 'SELFTEST'], ['/playertest-result', 'PLAYERTEST']]) {
      if (path === route) {
        let raw = ''
        for await (const chunk of req) raw += chunk
        res.writeHead(204).end()
        console.log(`\n===== ${label} =====\n${raw}\n${'='.repeat(20)}\n`)
        return
      }
    }

    if (path === '/api') {
      if (req.method === 'OPTIONS') { res.writeHead(204).end(); return }
      let raw = ''
      for await (const chunk of req) raw += chunk
      let body = {}
      try { body = JSON.parse(raw || '{}') } catch {}
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(await api(body)))
      return
    }

    if (path === '/playertest') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PLAYERTEST)
      return
    }

    const rel = path === '/' ? 'index.html' : normalize(path).replace(/^[/\\]+/, '').replace(/^(\.\.[/\\])+/, '')
    // /data/* comes from the repo root, not from here. status.html fetches
    // ../data/upload-status.json, which on Pages resolves against the site root -- without this
    // the page would work in production and 404 only in dev, which is the worst way round.
    // media/* too: the reel editor's bug loads ../media/brand/Icon.svg.
    const file = /^(data|media)\//.test(rel) ? join(HERE, '..', rel) : join(HERE, rel)
    if (!existsSync(file)) { res.writeHead(404).end('not found'); return }

    // upload.html needs the same localStorage bootstrap, so match any page, not just index.
    if (rel.endsWith('.html')) {
      let html = readFileSync(file, 'utf8').replace('</head>', `${BOOTSTRAP}</head>`)
      if (url.searchParams.get('selftest') === '1') html = html.replace('</body>', `${SELFTEST}</body>`)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html)
      return
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' })
      .end(readFileSync(file))
  } catch (err) {
    console.error(`  ! ${path}: ${err.message}`)
    res.writeHead(500, { 'content-type': 'text/plain' }).end(String(err.message))
  }
})

server.listen(PORT, async () => {
  console.log(`
  NSDS tape review — DEV
  ----------------------
  open        http://localhost:${PORT}
  passphrase  ${PASSWORD}

  video       YouTube (unlisted), per <show folder>/youtube.csv
  clips       ${STORE.replace(process.env.HOME || '~', '~')}  (local file, NOT Google Sheets)
  extras      /playertest   verify the player against a public video
              /?selftest=1  drive the whole UI and print a report
`)
  try {
    const { shows } = await listShows()
    console.log(`  ${shows.length} shows discovered under Media/ (newest: ${shows[0]?.name}).`)
    const { tapes } = await listTapes(shows[0].folderId, shows[0].tapesFolderId, shows[0].completedClipsFolderId)
    const linked = tapes.filter(t => t.youtubeId)
    console.log(`  ${shows[0].label}: ${tapes.length} tapes, ${linked.length} on YouTube (per youtube.csv).`)
    if (!linked.length) console.log(`  None playable yet — run: node tools/youtube-sync.mjs`)
  } catch (err) {
    console.log(`  ! could not reach Drive via rclone: ${err.message}`)
  }
  console.log('')
})
