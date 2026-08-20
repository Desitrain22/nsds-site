#!/usr/bin/env node
/**
 * Local dev server for the tape review app — one command, nothing deployed.
 *
 *   node videoreview/dev-server.mjs      then open http://localhost:8787
 *
 * It stands in for the two production pieces so the UI can be exercised before either exists:
 *
 *   /tape?id=&t=    the Cloudflare Worker. Runs the REAL worker/tape-proxy.js handler, so the
 *                   video path is genuinely the shipping code against real Drive bytes.
 *   /api            the Apps Script backend. listTapes is real (via rclone, which is already
 *                   authorised for this Drive); clips are stored in a LOCAL JSON FILE.
 *
 * Clips deliberately do NOT go to Google Sheets here. Testing shouldn't write to the sheet
 * your editing team reads, and Apps Script can't run locally anyway. Deploy Code.gs when you
 * want the real thing, then just point Settings at the /exec URL.
 *
 * Zero dependencies, same as the rest of tools/ here.
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { extname, join, dirname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleRequest as workerFetch } from './worker/tape-proxy.js'
import { SHOWS } from './shows.js'

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

// ---------------------------------------------------------------- local clip store --

function loadStore() {
  try { return JSON.parse(readFileSync(STORE, 'utf8')) } catch { return {} }
}
function saveStore(data) {
  writeFileSync(STORE, JSON.stringify(data, null, 2))
}

// ---------------------------------------------------------------- rclone --

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
const PROXY_SUFFIX = '__480p.mp4'

/**
 * Mirrors Code.gs listTapes: one subfolder deep, video mime types only, minus the reels.
 * Real Drive data, so the tape list you see is the tape list the deployed backend will show.
 */
const tapeCache = new Map()   // folderId -> { at, value }
const CACHE_MS = 60_000

async function listTapes(folderId) {
  const hit = tapeCache.get(folderId)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value

  // --fast-list halves the wall time here, and rclone's shared client_id is rate-limited, so
  // fewer calls matters. Concurrent listings on that shared project get slow fast.
  const raw = await rclone(['lsjson', '--drive-root-folder-id', folderId, '-R',
                            '--max-depth', '2', '--fast-list', `${REMOTE}:`])
  const entries = JSON.parse(raw)

  const proxies = {}
  for (const e of entries) {
    if (!e.IsDir && /^Proxies\//.test(e.Path)) proxies[e.Name] = { id: e.ID, size: e.Size }
  }

  const tapes = []
  for (const e of entries) {
    if (e.IsDir) continue
    if (!/^video\//.test(e.MimeType || '')) continue
    if (/^Proxies\//.test(e.Path)) continue
    if (/^(Flicks|Photos?|Stills)\//i.test(e.Path)) continue
    if (GLOBAL_EXCLUDE.some(re => re.test(e.Name))) continue

    const base = e.Name.replace(/\.[^.]+$/, '')
    const proxy = proxies[base + PROXY_SUFFIX] || null
    tapes.push({
      fileId: e.ID,
      name: e.Name,
      folderName: e.Path.includes('/') ? e.Path.split('/')[0] : null,
      size: e.Size,
      isPublic: true,          // not checked here; the real backend reports it per file
      proxyFileId: proxy ? proxy.id : null,
      proxySize: proxy ? proxy.size : null,
    })
  }
  tapes.sort((a, b) => a.name.localeCompare(b.name))
  const value = { ok: true, tapes, proxyCount: Object.keys(proxies).length }
  tapeCache.set(folderId, { at: Date.now(), value })
  return value
}

// ---------------------------------------------------------------- api --

function fmt(seconds) {
  const t = Math.round(Number(seconds) || 0)
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
      const all = store[key]
      const clips = body.videoFileId
        ? all.filter(c => c.videoFileId === body.videoFileId)
        : all
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
      const existing = store[key].findIndex(c => c.clipId === clip.clipId)
      const rev = (existing >= 0 ? Number(store[key][existing].rev || 0) : 0) + 1
      const record = { ...clip, ranges, rev, ...row, updatedAt: new Date().toISOString() }
      if (existing >= 0) store[key][existing] = record
      else store[key].push(record)
      saveStore(store)
      console.log(`  saved ${clip.clipId.slice(0, 8)} — ${row.start} → ${row.end}` +
        (row.granular ? `  D="${row.granular}"` : ''))
      return { ok: true, row: (existing >= 0 ? existing : store[key].length - 1) + 5, rev, sheetUrl: null }
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

// ---------------------------------------------------------------- server --

// Dev-only UI driver, injected on ?selftest=1. Drives the REAL index.html + app.js so the DOM
// wiring is exercised, not just the modules. Posts its report to /selftest-result.
const SELFTEST = `
<script type="module">
const L = [];
let pass = 0, fail = 0;
const log = s => { L.push(s); console.log(s); };
const ck = (l, c, d='') => { c ? (pass++, log('  ok   ' + l + (d ? ' — ' + d : '')))
                               : (fail++, log('  FAIL ' + l + (d ? ' — ' + d : ''))); };
const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(150); }
  throw new Error('timed out waiting for ' + label);
}
const finish = () => {
  log('\\n' + pass + ' passed, ' + fail + ' failed');
  navigator.sendBeacon('/selftest-result', L.join('\\n'));
};

window.addEventListener('load', async () => {
  try {
    log('-- gate --');
    ck('gate is showing', !$('#gate').hidden);
    $('#gate-input').value = ${JSON.stringify(PASSWORD)};
    $('#gate-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await until(() => !$('#app').hidden, 'app to unlock');
    ck('unlocked with the right passphrase', $('#gate').hidden && !$('#app').hidden);

    log('\\n-- story 1: year -> show -> tape --');
    const years = [...$('#years').querySelectorAll('.chip')];
    ck('year chips rendered', years.length >= 1, years.map(b => b.textContent).join(','));
    const shows = await until(() => {
      const c = [...$('#shows').querySelectorAll('.chip')];
      return c.length ? c : null;
    }, 'show chips');
    ck('show chips rendered', shows.length === 9, shows.length + ' shows');
    const april = shows.find(b => /April/.test(b.textContent));
    ck('April 2026 is listed', !!april, april && april.textContent);
    april.click();

    const tapes = await until(() => {
      const t = [...$('#tapes').querySelectorAll('.tape')];
      return t.length ? t : null;
    }, 'tape list');
    ck('tapes listed', tapes.length === 9, tapes.length + ' tapes');
    const names = tapes.map(t => t.querySelector('strong').textContent);
    ck('performer names cleaned', names.includes('Alberta') && names.includes('DavidS'), names.join(', '));

    const davids = tapes.find(t => /DavidS/.test(t.textContent));
    davids.click();
    await until(() => !$('#review').hidden, 'review view');
    ck('review view opened', !$('#review').hidden);

    const v = $('#video');
    await until(() => v.readyState >= 1 && v.duration > 0, 'video metadata');
    ck('video loaded via the proxy', Math.abs(v.duration - 453.820042) < 0.01, 'duration=' + v.duration);
    ck('480p proxy chosen', v.videoHeight === 480 || v.videoWidth === 854,
       v.videoWidth + 'x' + v.videoHeight);
    ck('quality toggle visible', !$('#quality').hidden, $('#quality').textContent);
    ck('deep link written', /show=apr2026/.test(location.search) && /tape=/.test(location.search));

    log('\\n-- existing clip repopulated (story 3) --');
    const existing = await until(() => {
      const c = [...$('#clip-list').querySelectorAll('.clip')];
      return c.length ? c : null;
    }, 'saved clip to load');
    ck('the clip saved earlier came back', existing.length >= 1, existing.length + ' clip(s)');
    const firstRanges = existing[0].querySelectorAll('.range');
    ck('it has its two ranges', firstRanges.length === 2, firstRanges.length + ' ranges');
    ck('summary says 2 parts', /2 parts/.test(existing[0].querySelector('.clip-summary').textContent),
       existing[0].querySelector('.clip-summary').textContent);

    log('\\n-- story 2: new clip, "now" buttons, save --');
    v.currentTime = 100;
    await until(() => Math.abs(v.currentTime - 100) < 0.5, 'seek to 100s');
    $('#new-clip').click();
    const cards = [...$('#clip-list').querySelectorAll('.clip')];
    const card = cards[cards.length - 1];
    ck('new card appended', cards.length === existing.length + 1);
    const startVal = card.querySelector('.start').value;
    ck('start seeded from the playhead', startVal === '1:40', startVal);

    v.currentTime = 130;
    await until(() => Math.abs(v.currentTime - 130) < 0.5, 'seek to 130s');
    card.querySelector('.now-end').click();
    ck('"now" captured the end', card.querySelector('.end').value === '2:10',
       card.querySelector('.end').value);

    card.querySelector('.notes').value = 'cut the dead air';
    card.querySelector('.notes').dispatchEvent(new Event('input', { bubbles: true }));

    // The bug this checks: a timestamp change used to re-render the list and destroy the Save
    // button between mousedown and mouseup, so the first click did nothing.
    card.querySelector('.start').dispatchEvent(new Event('change', { bubbles: true }));
    ck('Save button survives a timestamp change', document.contains(card.querySelector('.save')));

    card.querySelector('.save').click();
    const msg = await until(() => {
      const t = card.querySelector('.clip-msg').textContent;
      return /Saved|error|conflict|past|missing/i.test(t) ? t : null;
    }, 'save to resolve');
    ck('saved on the first click', /Saved/i.test(msg), msg);

    log('\\n-- story 4: play timestamps --');
    const before = v.currentTime;
    existing[0].querySelector('.play-ranges').click();
    await until(() => v.currentTime !== before, 'playback to start');
    ck('Stop button appeared', !$('#stop-ranges').hidden);
    $('#stop-ranges').click();
    await sleep(300);
    ck('Stop paused it', v.paused);

    log('\\n-- timeline --');
    ck('timeline bars drawn', $('#timeline').querySelectorAll('.tl').length >= 2,
       $('#timeline').querySelectorAll('.tl').length + ' bars');
  } catch (e) {
    fail++;
    log('\\nTHREW: ' + e.message);
  }
  finish();
});
</script>
`

// Seed the two backend URLs so there is nothing to configure by hand.
const BOOTSTRAP = `
<script>
(function () {
  var K = 'nsds-review-config';
  var want = { endpoint: location.origin + '/api', proxy: location.origin + '/tape' };
  var have = {};
  try { have = JSON.parse(localStorage.getItem(K) || '{}'); } catch (e) {}
  if (have.endpoint !== want.endpoint || have.proxy !== want.proxy) {
    localStorage.setItem(K, JSON.stringify(want));
  }
})();
</script>
`

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const path = url.pathname

  try {
    // --- the real Worker handler, against real Drive ---
    if (path === '/tape') {
      const request = new Request(`http://localhost${req.url}`, {
        method: req.method,
        headers: Object.entries(req.headers).flatMap(([k, v]) =>
          Array.isArray(v) ? v.map(x => [k, x]) : [[k, v]]),
      })
      const out = await workerFetch(request, { TAPE_TOKEN: PASSWORD })
      res.writeHead(out.status, Object.fromEntries(out.headers))
      if (out.body) Readable.fromWeb(out.body).pipe(res)
      else res.end()
      return
    }

    if (path === '/selftest-result') {
      let raw = ''
      for await (const chunk of req) raw += chunk
      res.writeHead(204).end()
      console.log('\n===== SELFTEST =====\n' + raw + '\n====================\n')
      return
    }

    // --- stand-in for the Apps Script web app (same text/plain contract) ---
    if (path === '/api') {
      if (req.method === 'OPTIONS') { res.writeHead(204).end(); return }
      let raw = ''
      for await (const chunk of req) raw += chunk
      let body = {}
      try { body = JSON.parse(raw || '{}') } catch {}
      const out = await api(body)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out))
      return
    }

    // --- static, with the config bootstrap injected into the page ---
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

  video       real Drive bytes, through the real Worker handler
  clips       ${STORE.replace(process.env.HOME || '~', '~')}  (local file, NOT Google Sheets)
`)
  try {
    const { tapes, proxyCount } = await listTapes(SHOWS[0].folderId)
    const withProxy = tapes.filter(t => t.proxyFileId)
    console.log(`  ${SHOWS[0].label}: ${tapes.length} tapes, ${proxyCount} proxy/proxies built.`)
    if (withProxy.length) {
      console.log(`  Start with:  ${withProxy.map(t => t.name).join(', ')}  (these scrub instantly)`)
    }
    if (withProxy.length < tapes.length) {
      console.log(`  The other ${tapes.length - withProxy.length} fall back to the 4K master and will barely seek —`)
      console.log(`  build proxies with:  node tools/make-proxies.mjs ${SHOWS[0].id}`)
    }
  } catch (err) {
    console.log(`  ! could not reach Drive via rclone: ${err.message}`)
  }
  console.log('')
})
