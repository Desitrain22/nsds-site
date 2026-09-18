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
import { SHOWS, isExcluded } from './shows.js'
import { pickTapesRoot, pickTapes, MAX_DEPTH } from './tapes.js'

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

const tapeCache = new Map()
const CACHE_MS = 60_000

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
async function listTapes(folderId, tapesFolderId) {
  const key = `${folderId}|${tapesFolderId || ''}`
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

  const show = SHOWS.find(s => s.folderId === folderId)
  const top = await lsjson(folderId, 1)
  const root = pickTapesRoot(top, tapesFolderId || null)
  const entries = root.id ? await lsjson(root.id, MAX_DEPTH + 1) : top.concat(await lsjson(folderId, MAX_DEPTH + 1))
  const seen = new Set()
  const tapes = pickTapes(entries, name => (show ? isExcluded(show, name) : false))
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
  const value = { ok: true, tapes, tapesRoot: { id: root.id || folderId, name: rootEntry ? rootEntry.Name : '(show folder)', mode: root.mode } }
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

async function api(body) {
  if (String(body.password || '') !== PASSWORD) return { ok: false, error: 'bad password' }
  const key = body.folderId
  const store = loadStore()
  store[key] = store[key] || []

  switch (body.action) {
    // Matches Code.gs: the gate's password check, with no Drive work behind it.
    case 'ping':
      return { ok: true }

    case 'listTapes':
      return listTapes(body.folderId, body.tapesFolderId || null)

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
    ck('8 set tapes listed (intro is in extras/)', tapes.length === 8, tapes.length + '');
    const names = tapes.map(t => t.querySelector('strong').textContent);
    ck('names cleaned', names.includes('Alberta') && names.includes('S.') && !names.includes('Mayberry (intro)'), names.join(', '));
    ck('Photos link points at photos/', !$('#photos-link').hidden && $('#photos-link').href.includes('1CFeeKKfdLrLTXNGBUvfmMGCQNEZgg9Eq'), $('#photos-link').href);
    ck('no "scanning whole folder" warning', $('#tapes-note').hidden);

    tapes.find(t => /DavidS/.test(t.textContent)).click();
    await until(() => !$('#review').hidden, 'review view');
    ck('review view opened', !$('#review').hidden);
    ck('deep link written', /show=apr2026/.test(location.search));
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

  video       YouTube (unlisted), per <show folder>/youtube.csv
  clips       ${STORE.replace(process.env.HOME || '~', '~')}  (local file, NOT Google Sheets)
  extras      /playertest   verify the player against a public video
              /?selftest=1  drive the whole UI and print a report
`)
  try {
    const { tapes } = await listTapes(SHOWS[0].folderId, SHOWS[0].tapesFolderId || null)
    const linked = tapes.filter(t => t.youtubeId)
    console.log(`  ${SHOWS[0].label}: ${tapes.length} tapes, ${linked.length} on YouTube (per youtube.csv).`)
    if (!linked.length) console.log(`  None playable yet — run: node tools/youtube-sync.mjs`)
  } catch (err) {
    console.log(`  ! could not reach Drive via rclone: ${err.message}`)
  }
  console.log('')
})
