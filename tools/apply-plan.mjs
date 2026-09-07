#!/usr/bin/env node
/**
 * Execute a Drive reorganisation plan (JSONL, one op per line) through the backend's admin
 * actions, which run as the folder owner.
 *
 *   NSDS_PASSWORD='…' NSDS_ADMIN_KEY='…' node tools/apply-plan.mjs tools/plans/<plan>.jsonl
 *        [--apply] [--from=N] [--to=N] [--include=N,N] [--skip-optional] [--skip-needs-decision]
 *
 * Op shapes (as produced by the inventory survey):
 *   {"op":"mkdir","key":"S1_photos","newTitle":"photos","parentForMkdir":"<id|$KEY>","why":…}
 *   {"op":"rename","fileId":"<id>","newTitle":"…"}
 *   {"op":"move","fileId":"<id>","newParentId":"<id|$KEY>","newTitle"?:"…"}
 * `$KEY` refers to a folder created by an earlier mkdir (or an existing same-named folder — mkdir is
 * idempotent). Ops marked OPTIONAL / NEEDS-DECISION carry a `status`.
 *
 * Nothing is deleted. Failures (typically a 403 on someone else's file) are recorded and the run
 * continues; every attempted op is appended to tools/reorg-log.jsonl with before/after.
 */

import { readFileSync, appendFileSync } from 'node:fs'
import { BACKEND_URL } from '../videoreview/shows.js'

const PASSWORD = process.env.NSDS_PASSWORD
const ADMIN_KEY = process.env.NSDS_ADMIN_KEY
const URL_ = process.env.NSDS_BACKEND_URL || BACKEND_URL
const LOG = new URL('./reorg-log.jsonl', import.meta.url)

const args = process.argv.slice(2)
const file = args.find(a => !a.startsWith('--'))
const apply = args.includes('--apply')
const flag = (name, dflt) => { const a = args.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt }
const from = Number(flag('from', 1)), to = Number(flag('to', Infinity))
const include = new Set(String(flag('include', '')).split(',').filter(Boolean).map(Number))
const skipOptional = args.includes('--skip-optional')
const skipND = args.includes('--skip-needs-decision')
const die = m => { console.error(m); process.exit(1) }
if (!file) die('usage: node tools/apply-plan.mjs <plan.jsonl> [--apply] …')
if (!PASSWORD || !ADMIN_KEY) die('set NSDS_PASSWORD and NSDS_ADMIN_KEY')

const ops = readFileSync(file, 'utf8').split('\n').filter(l => l.trim().startsWith('{')).map(l => JSON.parse(l.replace(/,\s*$/, '')))
const selected = ops.filter(o => (o.n >= from && o.n <= to) || include.has(o.n))
  .filter(o => !(skipOptional && /OPTIONAL/.test(o.status || '')))
  .filter(o => !(skipND && /NEEDS-DECISION/.test(o.status || '')))

async function call(action, payload) {
  const res = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, password: PASSWORD, adminKey: ADMIN_KEY, ...payload }) })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { throw new Error(`non-JSON (${res.status}): ${text.slice(0, 120)}`) }
  if (data.ok === false) throw new Error(data.error)
  return data
}
const log = rec => { if (apply) appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), plan: file.split('/').pop(), ...rec }) + '\n') }

const keys = {}                       // $KEY -> folder id
const resolve = v => (typeof v === 'string' && v.startsWith('$')) ? (keys[v.slice(1)] || null) : v
const short = s => String(s || '').slice(0, 95)

console.log(`${selected.length} of ${ops.length} ops selected  (${apply ? 'APPLY' : 'DRY RUN'})\n`)
let ok = 0, failed = 0, skipped = 0
const failures = []

for (const o of selected) {
  const tag = o.status ? ` [${o.status}]` : ''
  try {
    if (o.op === 'mkdir') {
      const parent = resolve(o.parentForMkdir)
      console.log(`n=${String(o.n).padStart(3)} mkdir  ${o.newTitle}/  in ${parent || o.parentForMkdir}${tag}`)
      if (!parent) throw new Error(`parent ${o.parentForMkdir} unresolved`)
      if (!apply) { keys[o.key] = `<${o.key}>`; ok++; continue }
      const r = await call('adminCreateFolder', { parentId: parent, title: o.newTitle })
      keys[o.key] = r.id
      log({ plan_n: o.n, op: 'mkdir', key: o.key, id: r.id, parentId: parent, created: r.created })
      ok++
    } else if (o.op === 'rename') {
      console.log(`n=${String(o.n).padStart(3)} rename ${o.fileId} -> "${o.newTitle}"${tag}   ${short(o.why)}`)
      if (!apply) { ok++; continue }
      const r = await call('adminRenameFile', { fileId: o.fileId, title: o.newTitle })
      log({ plan_n: o.n, op: 'rename', id: o.fileId, from: r.from, to: o.newTitle, renamed: r.renamed })
      ok++
    } else if (o.op === 'move') {
      const dest = resolve(o.newParentId)
      console.log(`n=${String(o.n).padStart(3)} move   ${o.fileId} -> ${dest || o.newParentId}${o.newTitle ? ` as "${o.newTitle}"` : ''}${tag}   ${short(o.why)}`)
      if (!dest) throw new Error(`destination ${o.newParentId} unresolved`)
      if (!apply) { ok++; continue }
      const r = await call('adminMoveFile', { fileId: o.fileId, newParentId: dest, allowShortcut: true })
      log({ plan_n: o.n, op: 'move', id: o.fileId, from: r.from || r.parents, to: dest, moved: r.moved })
      if (o.newTitle) {
        const rn = await call('adminRenameFile', { fileId: o.fileId, title: o.newTitle })
        log({ plan_n: o.n, op: 'rename', id: o.fileId, from: rn.from, to: o.newTitle, renamed: rn.renamed })
      }
      ok++
    } else { console.log(`n=${o.n} unknown op ${o.op} — skipped`); skipped++ }
  } catch (err) {
    failed++
    failures.push({ n: o.n, op: o.op, fileId: o.fileId, error: err.message, why: o.why })
    console.log(`     !! n=${o.n} FAILED: ${err.message}`)
    log({ plan_n: o.n, op: o.op, id: o.fileId, failed: true, error: err.message })
  }
}
console.log(`\n${apply ? 'applied' : 'would apply'} ${ok}, failed ${failed}, skipped ${skipped}`)
if (failures.length) {
  console.log('\nFailures (need Neal, usually ownership):')
  for (const f of failures) console.log(`  n=${f.n} ${f.op} ${f.fileId || ''}: ${f.error}   — ${short(f.why)}`)
}
if (apply && Object.keys(keys).length) {
  console.log('\nFolders created/resolved:'); for (const [k, v] of Object.entries(keys)) console.log(`  ${k.padEnd(14)} ${v}`)
}
