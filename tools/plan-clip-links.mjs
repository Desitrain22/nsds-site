#!/usr/bin/env node
/**
 * Build the adminSetClipLinks plan: every finished clip in the MASTER tracker, attached to the
 * right row of the right show's Tape Requests sheet (column M).
 *
 * Reads only local exports (master.csv, sheets/*.csv, inv.json). Writes plan.json + a review
 * table. Applying it is a separate step and needs ADMIN_KEY.
 *
 * Sheet geometry, from Code.gs: HEADER_ROW 3, row 4 is the "(sample)" row, FIRST_DATA_ROW 5.
 * A CSV export line number IS the sheet row number, which the header assertion below verifies.
 */
import { readFileSync, writeFileSync } from 'node:fs'
const SP = process.argv[2]
const HEADER_ROW = 3, FIRST_DATA_ROW = 5

function parseCsv(t){const r=[];let f=[],c='',q=false;for(let i=0;i<t.length;i++){const ch=t[i];
 if(q){if(ch==='"'){if(t[i+1]==='"'){c+='"';i++}else q=false}else c+=ch}
 else if(ch==='"')q=true; else if(ch===','){f.push(c);c=''}
 else if(ch==='\n'){f.push(c);r.push(f);f=[];c=''} else if(ch!=='\r')c+=ch}
 if(c||f.length){f.push(c);r.push(f)} return r}

// master tracker show label -> Drive show folder name
const MAP = {
 'July 2024':'July 2024 (NYC)', 'Nov 2024 Roast':'November 2024 (NYC - Immigrant Founders Roast)',
 'January 2025':'January 2025 (NYC)', 'March 2025':'March 2025 (NYC)', 'March 2025 (SF)':'March 2025 (SF)',
 'June 2025':'June 2025 (NYC Tech Week)', 'July 2025':'July 2025 (NYC)', 'September 2025':'September 2025 (NYC)',
 'SF/LA Tech Week (Oct 2025)':'October 2025 (SF + LA Tech Week)', 'December 2025':'December 2025 (NYC)',
 'February 2026':'February 2026 (NYC)', 'March 2026 (NYC)':'March 2026 (NYC)', 'June 2026 (NYTW)':'June 2026 (NYTW)',
 'March 2026 (SF)':'March 2026 (SF)', 'April 2026':'April 2026 (NYC)' }

const STOP = new Set(['clip','clips','the','and','for','with','v2','mp4','mpeg','nocaption','nocaptions',
  'version','withcaps','web','full','show','tape','proof','set','final','rough','new','old','edit'])
const words = s => String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').split(' ')
  .filter(w => w.length >= 4 && !STOP.has(w))
// "DivyaUniversity.mp4" -> tokens incl. "university"; splits CamelCase and strips the performer.
function clipTokens(note, performer) {
  const stem = String(note||'').replace(/\.(mp4|mpeg|mov)\b/gi,' ')
  const split = stem.replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g,'$1 $2')
  const pw = new Set(words(performer))
  return [...new Set(words(split))].filter(w => !pw.has(w))
}
const timeRanges = s => [...String(s||'').matchAll(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/g)]
  .map(m => [ +m[1]*60 + +m[2], +m[3]*60 + +m[4] ])
const overlap = (a, b) => a[0] < b[1] && b[0] < a[1]
const norm = s => String(s||'').toLowerCase().replace(/\(.*?\)/g,' ').replace(/[^a-z ]/g,' ').replace(/\s+/g,' ').trim()
function likeName(a, b) {
  const x = norm(a).split(' ')[0], y = norm(b).split(' ')[0]
  if (!x || !y) return false
  if (x === y) return true
  const n = Math.min(x.length, y.length)
  if (n >= 4 && (x.startsWith(y) || y.startsWith(x))) return true
  if (n >= 5) { let d = 0; for (let i = 0; i < n; i++) if (x[i] !== y[i]) d++
    if (d <= 2 && Math.abs(x.length - y.length) <= 1) return true }
  return false
}

const inv = JSON.parse(readFileSync(`${SP}/inv.json`,'utf8'))
const master = parseCsv(readFileSync(`${SP}/master.csv`,'utf8'))
const mHdr = master[0].map(h => h.trim())
const C = { show: mHdr.indexOf('Show'), perf: mHdr.indexOf('Performer'),
            link: mHdr.indexOf('Link to clip'), notes: mHdr.indexOf('Notes') }

// group master rows by show
const byShow = new Map()
for (const r of master.slice(1)) {
  const url = (r[C.link]||'').trim()
  if (!/^https:\/\/drive\.google\.com/.test(url)) continue         // PENDING / prose rows
  const show = (r[C.show]||'').trim()
  if (!byShow.has(show)) byShow.set(show, [])
  byShow.get(show).push({ performer: (r[C.perf]||'').trim(), url, note: (r[C.notes]||'').trim() })
}

const plan = []
const audit = []
let stats = { link: 0, newRow: 0, unmatched: 0, noSheet: 0, clips: 0 }

for (const [mShow, clips] of byShow) {
  const folder = MAP[mShow]
  const s = folder && inv.find(x => x.show === folder)
  const sheet = s && s.sheets.filter(x => x.path.split('/').length === 2 && /request/i.test(x.name))[0]
  stats.clips += clips.length
  if (!sheet) {
    stats.noSheet += clips.length
    audit.push({ show: mShow, verdict: 'NO SHEET', detail: `${clips.length} clip(s) — no request sheet in Drive`, clips: clips.map(c=>c.note) })
    continue
  }
  const safe = folder.replace(/[^A-Za-z0-9()-]/g,'')
  const rows = parseCsv(readFileSync(`${SP}/sheets/${safe}.csv`,'utf8'))
  if (String(rows[HEADER_ROW-1]?.[0]).trim() !== 'Name')
    throw new Error(`${folder}: CSV line ${HEADER_ROW} is not the header — geometry assumption broken`)
  const hdr = rows[HEADER_ROW-1]
  const ci = n => hdr.findIndex(c => new RegExp(n,'i').test(c||''))
  const cStart = 1, cEnd = 2, cGran = 3, cNotes = 4
  const cId = ci('clip_id'), cRanges = ci('ranges_json')
  // real data rows, with their true sheet row numbers
  const dataRows = rows.map((r, i) => ({ row: i + 1, cells: r }))
    .filter(x => x.row >= FIRST_DATA_ROW && (x.cells[0]||'').trim() && !/^sample|\(sample\)/i.test((x.cells[0]||'').trim()))

  // performer -> their rows
  const groups = new Map()
  for (const c of clips) {
    const key = c.performer
    if (!groups.has(key)) groups.set(key, { clips: [], rows: dataRows.filter(d => likeName(d.cells[0], key)) })
    groups.get(key).clips.push(c)
  }

  const links = new Map()      // row -> urls[]
  const newRows = []
  for (const [performer, g] of groups) {
    if (!g.rows.length) {
      newRows.push({ name: performer, notes: `Finished clip: ${g.clips.map(c => c.note || '(clip)').join('; ')}`, urls: g.clips.map(c => c.url) })
      stats.newRow++
      audit.push({ show: mShow, performer, verdict: 'NEW ROW', detail: `no request row; appending one with ${g.clips.length} link(s)` })
      continue
    }
    for (const c of g.clips) {
      let target = null, how = null
      // (a) explicit timestamps in the clip note that overlap a row's range
      const ct = timeRanges(c.note)
      if (ct.length) {
        const hits = g.rows.filter(d => {
          const rt = [...timeRanges(`${d.cells[cStart]||''} - ${d.cells[cEnd]||''}`), ...timeRanges(d.cells[cGran]||''),
                      ...(d.cells[cRanges] ? (JSON.parse(d.cells[cRanges]||'[]')||[]).map(o => [o.s, o.e]) : [])]
          return rt.some(r => ct.some(x => overlap(x, r)))
        })
        if (hits.length === 1) { target = hits[0]; how = 'timestamp' }
      }
      // (b) a distinctive word from the clip name that lands in exactly one of their rows
      if (!target) {
        const toks = clipTokens(c.note, performer)
        const scored = g.rows.map(d => ({ d, n: toks.filter(t =>
          new RegExp(t, 'i').test(`${d.cells[0]||''} ${d.cells[cNotes]||''} ${d.cells[cGran]||''}`)).length }))
        const best = scored.filter(x => x.n > 0).sort((a,b) => b.n - a.n)
        if (best.length === 1 || (best.length > 1 && best[0].n > best[1].n)) { target = best[0].d; how = 'topic' }
      }
      // (c) they only have one row — unambiguous by construction
      if (!target && g.rows.length === 1) { target = g.rows[0]; how = 'sole-row' }

      if (!target) {
        stats.unmatched++
        audit.push({ show: mShow, performer, verdict: 'LEFT TO FINISHED-CLIPS LIST',
                     detail: `"${c.note}" — ${g.rows.length} candidate rows, no distinguishing signal` })
        continue
      }
      if (!links.has(target.row)) links.set(target.row, { expectName: (target.cells[0]||'').trim(), urls: [] })
      links.get(target.row).urls.push(c.url)
      stats.link++
      audit.push({ show: mShow, performer, verdict: 'LINK', row: target.row, how,
                   detail: `"${c.note}" → row ${target.row} (${(target.cells[0]||'').trim()}) via ${how}` })
    }
  }
  if (links.size || newRows.length) {
    plan.push({ show: mShow, folder, sheetId: sheet.id, sheetName: sheet.name,
      links: [...links.entries()].map(([row, v]) => ({ row, expectName: v.expectName, urls: v.urls })).sort((a,b)=>a.row-b.row),
      newRows })
  }
}

writeFileSync(`${SP}/plan.json`, JSON.stringify(plan, null, 1))
writeFileSync(`${SP}/plan-audit.json`, JSON.stringify(audit, null, 1))
console.log(`clips in master with a Drive link: ${stats.clips}`)
console.log(`  -> linked onto an existing row:  ${stats.link}`)
console.log(`  -> new row appended:             ${stats.newRow}  (performer has no request row)`)
console.log(`  -> left to Finished-clips list:  ${stats.unmatched}  (ambiguous among several rows)`)
console.log(`  -> show has no request sheet:    ${stats.noSheet}`)
console.log(`\nplan covers ${plan.length} sheets; ${plan.reduce((n,p)=>n+p.links.length,0)} row writes, ${plan.reduce((n,p)=>n+p.newRows.length,0)} appends`)
