#!/usr/bin/env node
/**
 * Bring one show's Drive folder to the standard layout, through the backend's admin actions
 * (they run as the folder owner, so ownership never blocks a move):
 *
 *   <show folder>/tapes/             raw set tapes
 *   <show folder>/photos/            photos
 *   <show folder>/completed_clips/   finished clips from the editor
 *   <show folder>/extras/            sizzles, highlight reels, hosting, "UPDATE" — not anyone's set
 *   <show folder>/<request sheet>    stays in the root
 *
 *   NSDS_PASSWORD='…' NSDS_ADMIN_KEY='…' node tools/reorg-show.mjs <show|folderId> [--apply]
 *       [--tapes=<folderId>] [--photos=<folderId>] [--clips=<folderId>] [--extras=<folderId>]
 *
 * The overrides name an EXISTING subfolder that should become tapes/, photos/, completed_clips/ or
 * extras/ (it is renamed in place). Use them where the heuristics can't tell — "Set proofs",
 * "Proofs", "Sets + Highlights" — instead of widening the guesswork.
 *
 * Dry run by default; the printed plan is exactly what --apply executes. Every applied op is
 * appended to tools/reorg-log.jsonl with before/after so it can be undone by hand. Nothing is ever
 * deleted, copied, or renamed inside a file — only folders are renamed and files moved, so every
 * Drive id (and therefore every link, YouTube CSV key and sheet reference) keeps working.
 *
 * Rules:
 *  - a legacy subfolder named like a tapes folder (Set Tapes / Sets / Footage) is RENAMED to
 *    "tapes" in place (id preserved) — likewise Flicks/Photo* -> photos, Clips -> completed_clips
 *  - loose videos in the root: set tapes -> tapes/; anything the app excludes -> extras/, except
 *    names that look like finished clips (…Request_…, …Clip…) -> completed_clips/
 *  - loose images -> photos/; spreadsheets, CSVs and shortcuts stay put and are reported
 *  - two candidates for one target (e.g. Sets AND Footage) is NEEDS-DECISION: nothing moves
 */

import { appendFileSync } from 'node:fs'
import { BACKEND_URL, isExcluded, matchShowArg, showShortId } from '../videoreview/shows.js'
import { TAPES_FOLDER_RE, EXCLUDED_TAPE_RE } from '../videoreview/tapes.js'

const PASSWORD = process.env.NSDS_PASSWORD
const ADMIN_KEY = process.env.NSDS_ADMIN_KEY
const URL_ = process.env.NSDS_BACKEND_URL || BACKEND_URL
const LOG = new URL('./reorg-log.jsonl', import.meta.url)

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const showArg = args.find(a => !a.startsWith('--'))
const override = Object.fromEntries(args.filter(a => /^--(tapes|photos|clips|extras)=/.test(a)).map(a => a.slice(2).split('=', 2)))
override.completed_clips = override.clips; delete override.clips
const die = m => { console.error(m); process.exit(1) }
if (!PASSWORD || !ADMIN_KEY) die('set NSDS_PASSWORD and NSDS_ADMIN_KEY')
if (!showArg) die(`usage: node tools/reorg-show.mjs <show|folderId> [--apply]   (shows: jul2025, mar2026-sf, …)`)
let show = /^[\w-]{25,}$/.test(showArg) ? { id: showArg, folderId: showArg, label: showArg } : null

async function call(action, payload) {
  const res = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, password: PASSWORD, adminKey: ADMIN_KEY, ...payload }) })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { die(`non-JSON from backend (${res.status}): ${text.slice(0, 160)}`) }
  if (data.ok === false) die(`${action}: ${data.error}`)
  return data
}
if (!show) {
  const shows = (await call('listShows', {})).shows
  const m = matchShowArg(shows, showArg)
  if (!m.show) die(`unknown show "${showArg}"${m.candidates?.length ? ` — ambiguous between ${m.candidates.map(showShortId).join(', ')}` : ''}. Known: ${shows.map(showShortId).join(' ')}`)
  show = { ...m.show, id: showShortId(m.show) }
}
const log = rec => { if (apply) appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), show: show.id, ...rec }) + '\n') }

const PHOTOS_RE = /^(flicks|photos?|stills|pics|pictures)\b/i
const CLIPS_RE = /^(clips|completed[ _-]?clips|finished[ _-]?clips|final[ _-]?clips)$/i
const FINISHED_NAME_RE = /request_|clip/i

const listing = await call('adminListFolder', { folderId: show.folderId })
console.log(`\n${listing.name}  (${listing.id})  ${apply ? 'APPLY' : 'DRY RUN'}\n`)

const plan = []   // { kind, ...details, run: async () => result }
const notes = []
let target_extras_override = null
const byTarget = { tapes: [], photos: [], completed_clips: [] }
const overridden = new Set(Object.values(override).filter(Boolean))
for (const [name, id] of Object.entries(override)) {
  if (!id) continue
  const f = listing.folders.find(x => x.id === id)
  if (!f) die(`--${name === 'completed_clips' ? 'clips' : name}=${id} is not a subfolder of this show`)
  if (name === 'extras') { target_extras_override = f; continue }
  byTarget[name] = [f]
}
for (const f of listing.folders) {
  if (overridden.has(f.id)) continue
  if (f.name === 'tapes' || TAPES_FOLDER_RE.test(f.name)) byTarget.tapes.push(f)
  else if (PHOTOS_RE.test(f.name)) byTarget.photos.push(f)
  else if (CLIPS_RE.test(f.name)) byTarget.completed_clips.push(f)
  else if (/^extras?$/i.test(f.name)) { /* fine */ }
  else if (/^proxies$/i.test(f.name)) notes.push(`Proxies/ (${f.id}) is a leftover from the abandoned Cloudflare path — safe to delete by hand`)
  else notes.push(`subfolder "${f.name}" (${f.id}) left alone — not recognised as tapes/photos/clips`)
}

const target = {}   // name -> folder id (existing, renamed, or to-be-created)
for (const [name, cands] of Object.entries(byTarget)) {
  const exact = cands.find(c => c.name === name)
  if (exact) { target[name] = exact.id; continue }
  if (cands.length > 1) { notes.push(`NEEDS-DECISION: ${cands.length} candidates for ${name}/: ${cands.map(c => `"${c.name}" (${c.id})`).join(', ')} — nothing moved into ${name}/`); continue }
  if (cands.length === 1) {
    const c = cands[0]
    plan.push({ kind: 'rename', id: c.id, from: c.name, to: name,
      run: () => call('adminRenameFile', { fileId: c.id, title: name }) })
    target[name] = c.id
  } else {
    plan.push({ kind: 'mkdir', title: name, parentId: show.folderId,
      run: async () => { const r = await call('adminCreateFolder', { parentId: show.folderId, title: name }); target[name] = r.id; return r } })
    target[name] = null   // filled on apply
  }
}

const needExtras = []
for (const f of listing.files) {
  const mime = f.mimeType || ''
  if (f.isShortcut) { notes.push(`shortcut "${f.name}" -> ${f.targetId} left in root (Apps Script can't see through it; move the target instead)`); continue }
  if (mime.startsWith('video/')) {
    if (isExcluded(f.name)) {
      if (FINISHED_NAME_RE.test(f.name)) plan.push({ kind: 'move', id: f.id, name: f.name, to: 'completed_clips' })
      else { plan.push({ kind: 'move', id: f.id, name: f.name, to: 'extras' }); needExtras.push(f) }
    } else plan.push({ kind: 'move', id: f.id, name: f.name, to: 'tapes' })
  } else if (mime.startsWith('image/')) {
    plan.push({ kind: 'move', id: f.id, name: f.name, to: 'photos' })
  } else if (mime === 'application/vnd.google-apps.spreadsheet' || /csv|text/.test(mime)) {
    notes.push(`"${f.name}" (${mime.replace('application/vnd.google-apps.', 'g:')}) stays in the show root`)
  } else notes.push(`"${f.name}" (${mime}) left alone`)
}
if (needExtras.length && !listing.folders.some(f => /^extras?$/i.test(f.name))) {
  plan.unshift({ kind: 'mkdir', title: 'extras', parentId: show.folderId,
    run: async () => { const r = await call('adminCreateFolder', { parentId: show.folderId, title: 'extras' }); target.extras = r.id; return r } })
} else if (target_extras_override) {
  if (target_extras_override.name !== 'extras') plan.unshift({ kind: 'rename', id: target_extras_override.id, from: target_extras_override.name, to: 'extras',
    run: () => call('adminRenameFile', { fileId: target_extras_override.id, title: 'extras' }) })
  target.extras = target_extras_override.id
} else { const e = listing.folders.find(f => /^extras?$/i.test(f.name)); if (e) target.extras = e.id }

// ---- print the plan ----
for (const p of plan) {
  if (p.kind === 'rename') console.log(`  rename  "${p.from}" -> "${p.to}"   (${p.id})`)
  else if (p.kind === 'mkdir') console.log(`  mkdir   ${p.title}/`)
  else console.log(`  move    ${p.name}  ->  ${p.to}/`)
}
for (const n of notes) console.log(`  note    ${n}`)
if (!plan.length) console.log('  (already in the standard layout)')

if (!apply) { console.log('\n(dry run — add --apply to execute)'); process.exit(0) }

// ---- execute: structure first, then moves ----
for (const p of plan.filter(p => p.kind !== 'move')) {
  const r = await p.run()
  log({ op: p.kind, ...(p.kind === 'rename' ? { id: p.id, from: p.from, to: p.to } : { title: p.title, id: r.id, parentId: p.parentId }) })
}
for (const p of plan.filter(p => p.kind === 'move')) {
  const dest = target[p.to]
  if (!dest) { console.log(`  !! no ${p.to}/ folder resolved for ${p.name} — skipped`); continue }
  const r = await call('adminMoveFile', { fileId: p.id, newParentId: dest })
  log({ op: 'move', id: p.id, name: p.name, from: r.from, to: r.to })
  console.log(`  moved   ${p.name} -> ${p.to}/`)
}

const after = await call('adminListFolder', { folderId: show.folderId })
console.log(`\nDone. Root now: ${after.folders.map(f => f.name + '/').join(' ')}  + ${after.files.length} file(s)`)
console.log('\nNothing to pin: the backend discovers tapes/, photos/ and completed_clips/ by name (listShows).')
