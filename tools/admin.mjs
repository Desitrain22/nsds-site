#!/usr/bin/env node
/**
 * Migration CLI for the tape review backend's admin actions. Zero dependencies.
 *
 *   NSDS_PASSWORD='…' NSDS_ADMIN_KEY='…' node tools/admin.mjs <command> [args]
 *
 *   list-folder <folderId>                         what Apps Script sees (incl. shortcuts)
 *   sheet-info  <show|sheetId>                     tabs, parents, header/layout state, A1 link
 *   read-rows   <show|sheetId>                     every row, classified (preamble/header/sample/legacy/app)
 *   ensure-sheet <show> [--apply] [--fix-a1] [--move-to-root]
 *   adopt       <show> [--apply] [--row N=<fileId>]…
 *
 * Secrets come from the environment only — never argv (argv is visible in `ps`). Everything is a
 * dry run unless --apply is given, and the plan printed dry is exactly what --apply executes.
 *
 * Why POSTs look the way they do: Apps Script can't answer a CORS preflight and answers POST with a
 * 302 to a GET-only echo URL; fetch follows that correctly by default. Content-Type text/plain.
 */

import { SHOWS, BACKEND_URL, getShow, isExcluded, performerName } from '../videoreview/shows.js'

const PASSWORD = process.env.NSDS_PASSWORD
const ADMIN_KEY = process.env.NSDS_ADMIN_KEY
const URL_ = process.env.NSDS_BACKEND_URL || BACKEND_URL

const args = process.argv.slice(2)
const cmd = args[0]
const positional = args.slice(1).filter(a => !a.startsWith('--'))
const flags = new Set(args.filter(a => a.startsWith('--') && !a.includes('=')))
const kv = args.filter(a => a.startsWith('--') && a.includes('=')).map(a => a.slice(2).split('=', 2))

function die(msg) { console.error(msg); process.exit(1) }
if (!cmd) die(`usage: node tools/admin.mjs <list-folder|sheet-info|read-rows|ensure-sheet|adopt> …`)
if (!PASSWORD || !ADMIN_KEY) die('set NSDS_PASSWORD and NSDS_ADMIN_KEY in the environment')
if (!URL_) die('no backend URL: set BACKEND_URL in videoreview/shows.js or NSDS_BACKEND_URL')

async function call(action, payload) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, password: PASSWORD, adminKey: ADMIN_KEY, ...payload }),
  })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { die(`backend returned non-JSON (${res.status}): ${text.slice(0, 200)}`) }
  if (data.ok === false) die(`backend: ${data.error}${data.rows ? ' rows ' + data.rows.join(',') : ''}`)
  return data
}

function resolveShow(arg) {
  const show = getShow(arg)
  if (show) return show
  if (/^[\w-]{25,}$/.test(arg || '')) return { sheetId: arg, folderId: null, label: arg, id: arg }
  die(`unknown show "${arg}". Known: ${SHOWS.map(s => s.id).join(' ')}`)
}
const label = show => `${show.label}${show.city ? ` (${show.city})` : ''}`

/** Tapes as the UI will see them, with the performer label the app derives. */
async function tapesFor(show) {
  const { tapes, tapesRoot } = await call('listTapes', { folderId: show.folderId, tapesFolderId: show.tapesFolderId || null })
  return {
    tapesRoot,
    tapes: tapes.filter(t => !isExcluded(show, t.name)).map(t => ({ fileId: t.fileId, name: t.name, performer: performerName(show, t.name) })),
  }
}

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n)

const commands = {
  async 'list-folder'([folderId]) {
    const r = await call('adminListFolder', { folderId })
    console.log(`${r.name}  (${r.id})`)
    for (const f of r.folders) console.log(`  [dir]  ${f.name}  ${f.id}  ${f.owner || ''}`)
    for (const f of r.files) console.log(`  ${f.isShortcut ? '[link]' : '[file]'} ${pad(f.name, 44)} ${f.mimeType.replace('application/vnd.google-apps.', 'g:')}  ${f.id}${f.isShortcut ? ' -> ' + f.targetId : ''}`)
  },

  async 'sheet-info'([arg]) {
    const show = resolveShow(arg)
    let sheetId = show.sheetId
    if (!sheetId) {
      const e = await call('adminEnsureSheet', { folderId: show.folderId, showLabel: label(show), dryRun: true })
      if (!e.found) return console.log(`${show.id}: no request sheet (would create "${e.title}" in ${e.parentId})`)
      sheetId = e.sheetId
    }
    console.log(JSON.stringify(await call('adminSheetInfo', { sheetId }), null, 2))
  },

  async 'read-rows'([arg]) {
    const show = resolveShow(arg)
    const sheetId = show.sheetId || (await call('adminEnsureSheet', { folderId: show.folderId, showLabel: label(show), dryRun: true })).sheetId
    if (!sheetId) return console.log(`${show.id}: no sheet`)
    const r = await call('adminReadRows', { sheetId })
    console.log(`${r.title} / ${r.tab}`)
    for (const row of r.rows) {
      const v = row.values
      console.log(`  ${pad(row.row, 3)} ${pad(row.kind, 8)} ${pad(v[0] || row.inheritedName || '', 16)} ${pad(v[1], 8)} ${pad(v[2], 8)} ${pad(v[3], 30)} ${pad(v[7] || '', 8)}`)
    }
  },

  async 'ensure-sheet'([arg]) {
    const show = resolveShow(arg)
    const r = await call('adminEnsureSheet', {
      folderId: show.folderId, showLabel: label(show), sheetId: show.sheetId || null,
      tapesFolderId: show.tapesFolderId || null,
      dryRun: !flags.has('--apply'), fixA1Link: flags.has('--fix-a1'), moveToRoot: flags.has('--move-to-root'),
    })
    console.log(JSON.stringify(r, null, 2))
    if (r.created || (r.found && !show.sheetId)) console.log(`\n→ pin in shows.js:  sheetId: '${r.sheetId}',`)
  },

  async adopt([arg]) {
    const show = resolveShow(arg)
    const sheetId = show.sheetId || (await call('adminEnsureSheet', { folderId: show.folderId, showLabel: label(show), dryRun: true })).sheetId
    if (!sheetId) die(`${show.id}: no request sheet to adopt from`)
    const { tapes, tapesRoot } = await tapesFor(show)
    console.log(`${label(show)} — ${tapes.length} tapes (root: ${tapesRoot.name}, ${tapesRoot.mode})`)
    for (const t of tapes) console.log(`  ${pad(t.performer, 20)} ${t.name}  ${t.fileId}`)
    const assignments = kv.filter(([k]) => k === 'row').map(([, v]) => { const [row, videoFileId] = v.split('='); return { row: Number(row), videoFileId } })
    const r = await call('adminAdoptRows', { sheetId, tapes: tapes.map(({ fileId, performer }) => ({ fileId, performer })), assignments, dryRun: !flags.has('--apply') })
    console.log(`\n${r.dryRun ? 'DRY RUN' : 'APPLIED'} — ${r.adopted} adopted`)
    console.log(`  ${pad('row', 4)} ${pad('name', 16)} ${pad('start', 8)} ${pad('end', 8)} ${pad('verdict', 18)} ranges / why`)
    for (const x of r.report) {
      const dur = x.tapeDuration != null ? ` (tape ${Math.round(x.tapeDuration)}s)` : ''
      const extra = x.ranges ? x.ranges.map(q => `${q.s}-${q.e}`).join(',') + dur : (x.why || (x.candidates ? 'candidates: ' + x.candidates.join('|') : ''))
      console.log(`  ${pad(x.row, 4)} ${pad(x.name, 16)} ${pad(x.start, 8)} ${pad(x.end, 8)} ${pad(x.verdict, 18)} ${extra}`)
    }
    if (r.dryRun) console.log('\n(add --apply to write H..L for the ADOPT rows; use --row=N=<fileId> to resolve SKIP-AMBIGUOUS/SKIP-NO-TAPE)')
    else console.log(`\n${r.sheetUrl}`)
  },
}

const fn = commands[cmd]
if (!fn) die(`unknown command "${cmd}"`)
await fn(positional)
