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
import { SHOWS, YOUTUBE } from './shows.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 8787)
// Deliberately NOT the real passphrase — this file is committed to a public repo. Pass the
// production one in when you want to test against it:
//   NSDS_PASSWORD='the real phrase' node videoreview/dev-server.mjs
const PASSWORD = process.env.NSDS_PASSWORD || 'dev'
const STORE = join(HERE, '.dev-clips.json')
const RCLONE = ['/opt/homebrew/bin/rclone', 'rclone'].find(p => p === 'rclone' || existsSync(p))
const REMOTE = 'nsdsdrive'

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
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

const GLOBAL_EXCLUDE = [/sizzle/i, /highlight/i, /update/i, /recap/i]
const tapeCache = new Map()
const CACHE_MS = 60_000

/** Mirrors Code.gs listTapes: one subfolder deep, video mime types only, minus the reels. */
async function listTapes(folderId) {
  const hit = tapeCache.get(folderId)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value

  // --fast-list halves the wall time, and rclone's shared client_id is rate-limited.
  const raw = await rclone(['lsjson', '--drive-root-folder-id', folderId, '-R',
                            '--max-depth', '2', '--fast-list', `${REMOTE}:`])
  const tapes = []
  for (const e of JSON.parse(raw)) {
    if (e.IsDir) continue
    if (!/^video\//.test(e.MimeType || '')) continue
    if (/^(Flicks|Photos?|Stills|Proxies)\//i.test(e.Path)) continue
    if (GLOBAL_EXCLUDE.some(re => re.test(e.Name))) continue
    tapes.push({
      fileId: e.ID,
      name: e.Name,
      folderName: e.Path.includes('/') ? e.Path.split('/')[0] : null,
      size: e.Size,
      isPublic: true,
    })
  }
  tapes.sort((a, b) => a.name.localeCompare(b.name))
  const value = { ok: true, tapes }
  tapeCache.set(folderId, { at: Date.now(), value })
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

async function api(body) {
  if (String(body.password || '') !== PASSWORD) return { ok: false, error: 'bad password' }
  const key = body.folderId
  const store = loadStore()
  store[key] = store[key] || []

  switch (body.action) {
    case 'listTapes':
      return listTapes(body.folderId)

    case 'getClips': {
      const clips = body.videoFileId
        ? store[key].filter(c => c.videoFileId === body.videoFileId)
        : store[key]
      return { ok: true, sheetExists: true, sheetUrl: null, clips, legacy: [] }
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
    ck('9 tapes listed', tapes.length === 9, tapes.length + '');
    const names = tapes.map(t => t.querySelector('strong').textContent);
    ck('names cleaned', names.includes('Alberta') && names.includes('Mayberry (intro)'), names.join(', '));

    tapes.find(t => /DavidS/.test(t.textContent)).click();
    await until(() => !$('#review').hidden, 'review view');
    ck('review view opened', !$('#review').hidden);
    ck('deep link written', /show=apr2026/.test(location.search));

    log('\\n-- clip editor works even with no video loaded --');
    $('#new-clip').click();
    const card = await until(() => $('#clip-list').querySelector('.clip'), 'new clip card');
    ck('card created', !!card);
    card.querySelector('.start').value = '1:40';
    card.querySelector('.start').dispatchEvent(new Event('change', { bubbles: true }));
    ck('Save survives a timestamp change', document.contains(card.querySelector('.save')));
    card.querySelector('.end').value = '2:10';
    card.querySelector('.end').dispatchEvent(new Event('change', { bubbles: true }));
    card.querySelector('.add-range').click();
    const card2 = $('#clip-list').querySelector('.clip');
    const rows = card2.querySelectorAll('.range');
    ck('second range added', rows.length === 2, rows.length + ' ranges');
    rows[1].querySelector('.start').value = '3:15';
    rows[1].querySelector('.start').dispatchEvent(new Event('change', { bubbles: true }));
    rows[1].querySelector('.end').value = '3:30';
    rows[1].querySelector('.end').dispatchEvent(new Event('change', { bubbles: true }));
    ck('summary shows 2 parts', /2 parts/.test(card2.querySelector('.clip-summary').textContent),
       card2.querySelector('.clip-summary').textContent);

    card2.querySelector('.save').click();
    const msg = await until(() => {
      const t = card2.querySelector('.clip-msg').textContent;
      return /Saved|error|conflict|past|missing/i.test(t) ? t : null;
    }, 'save');
    ck('saved on first click', /Saved/i.test(msg), msg);
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

    const rel = path === '/' ? 'index.html' : normalize(path).replace(/^(\.\.[/\\])+/, '')
    const file = join(HERE, rel)
    if (!existsSync(file)) { res.writeHead(404).end('not found'); return }

    if (rel === 'index.html') {
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

  video       YouTube (unlisted), per the ids in shows.js
  clips       ${STORE.replace(process.env.HOME || '~', '~')}  (local file, NOT Google Sheets)
  extras      /playertest   verify the player against a public video
              /?selftest=1  drive the whole UI and print a report
`)
  try {
    const { tapes } = await listTapes(SHOWS[0].folderId)
    const map = YOUTUBE[SHOWS[0].id] || {}
    const linked = tapes.filter(t => map[t.name])
    console.log(`  ${SHOWS[0].label}: ${tapes.length} tapes, ${linked.length} linked to YouTube.`)
    if (!linked.length) {
      console.log(`  None are playable yet. Prepare uploads with:`)
      console.log(`      node tools/publish-tapes.mjs ${SHOWS[0].id}`)
      console.log(`  then paste the ids it prints into YOUTUBE in videoreview/shows.js.`)
    }
  } catch (err) {
    console.log(`  ! could not reach Drive via rclone: ${err.message}`)
  }
  console.log('')
})
