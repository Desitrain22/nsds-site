#!/usr/bin/env node
/**
 * Keep every set tape mirrored on YouTube (unlisted) and write a youtube.csv into each show's
 * Drive folder so the site can embed them. Idempotent; meant to run daily from launchd.
 *
 *   node tools/youtube-sync.mjs --auth          # one-time browser consent as the channel owner
 *   node tools/youtube-sync.mjs                 # sync: upload what's missing, up to the daily quota
 *   node tools/youtube-sync.mjs --dry-run       # inventory + what would upload, no changes
 *   node tools/youtube-sync.mjs --shard 2/6     # only every 6th pending tape -- for parallel CI
 *   node tools/youtube-sync.mjs --install-cron  # launchd job, daily 03:30 (also DEPLOYS the copy
 *                                                 it runs -- editing this file is not enough)
 *   node tools/youtube-sync.mjs --stage-all     # transcode everything missing, NO upload, into
 *                                                 ~/NSDS-youtube-upload/DRAG-ME/ named by title
 *   node tools/youtube-sync.mjs --adopt         # match the channel's uploads to tapes by title
 *   node tools/youtube-sync.mjs --retitle       # fix titles after tapes were renamed in Drive
 *                                                 and write youtube.csv -- for tapes you dragged
 *                                                 into youtube.com/upload by hand (no quota)
 *   node tools/youtube-sync.mjs --status        # write data/upload-status.json for the internal
 *                                                 status page. Read-only, no YouTube credential,
 *                                                 no quota -- safe to run while uploads are broken
 *
 * WHY A QUOTA CAP, AND WHY IT IS NO LONGER 6
 * The old cap of 6 came from videos.insert costing 1,600 of a project's default 10,000 daily
 * units. Google has since changed that twice: the cost dropped to ~100 units on 2025-12-04, and
 * on 2026-06-01 videos.insert moved into its OWN quota bucket at 1 unit per call with a default
 * of 100 calls/day. Uploads no longer draw from the 10,000-unit pool at all, so they no longer
 * compete with the read calls in --adopt/--retitle either. The ceiling is ~100 uploads a day.
 *
 * So the cap is 90 — 100 minus headroom, because a tape that fails mid-upload and is retried on a
 * later run spends a second insert call. The sync still stops at the cap or the first
 * quotaExceeded and picks up tomorrow, and everything it has done is in the per-show youtube.csv,
 * so re-runs are safe.
 *
 * WHAT ACTUALLY LIMITS A RUN NOW
 * The CHANNEL's daily upload cap, which is neither of the above. YouTube refuses a channel's
 * uploads past a per-channel limit with uploadLimitExceeded, however much API quota is left: on
 * 2026-10-15 the channel took 10 in sixteen minutes, refused the 11th, and was still refusing at
 * the next day's run. So a backlog drains at roughly 10 a day no matter how many shards run --
 * extra shards only reach the cap sooner (and six listing Drive at once trip its rate limit). The
 * run stops at the first refusal rather than transcoding tapes it cannot upload.
 *
 * Below the cap, transcoding is what takes the time. Each tape is ~5-15 min of
 * rclone-cat-into-ffmpeg, so a full 90 would be a long run. NSDS_MAX_HOURS (default 6) stops the
 * run from grinding into the working day: at the nightly 03:30 it gives up around 09:30 and resumes
 * the next night. Raise it for a
 * catch-up run you are babysitting. Neither limit ever splits a tape — both are checked only
 * between tapes, so a partly-transcoded file is never left behind as a finished one.
 *
 * AUTH
 * Needs a Google Cloud OAuth client (Desktop app) with the YouTube Data API enabled, saved at
 * ~/.config/nsds/youtube-client.json (the JSON the console gives you). Consent is stored at
 * ~/.config/nsds/youtube-token.json. Publish the consent screen (or make it Internal on the
 * Workspace) so the refresh token doesn't expire after 7 days -- a cron can't re-consent.
 *
 * Sign in as WHICHEVER ACCOUNT OWNS THE CHANNEL. That is not necessarily the Workspace mailbox;
 * set NSDS_YT_ACCOUNT to point the picker somewhere else. --auth now refuses to save a token for
 * an account with no channel, which is the mistake that left two dead token files behind here.
 *
 * In CI there is no browser and no ~/.config, so all three values come from the environment
 * instead: NSDS_YT_CLIENT_ID, NSDS_YT_CLIENT_SECRET, NSDS_YT_REFRESH_TOKEN. Generate the refresh
 * token once with --auth on a laptop and copy it into the secret store. Drive is reached with a
 * service account there rather than the laptop's rclone OAuth -- see
 * .github/workflows/youtube-sync.yml.
 *
 * WHAT IT WRITES TO DRIVE
 * <show folder>/youtube.csv with one row per tape:
 *   file_id,filename,performer,youtube_id,youtube_url,title,uploaded_at
 * Keyed on Drive file id, so it survives the folder reorganisation. Apps Script reads it.
 *
 * Zero dependencies. Nothing here touches the 4K masters except to read them.
 */

import { createServer } from 'node:http'
import { readFile, writeFile, mkdir, stat, unlink, open } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { rclone, inFolder, REMOTE, discoverShows, discoverYearRoots, transcode, isFullShowTape, classifyTapes, showStatus, statusPayload } from './lib/tapes.mjs'
import { MEDIA_ROOT_ID } from '../videoreview/shows.js'

const CFG_DIR = join(homedir(), '.config', 'nsds')
const CLIENT_FILE = join(CFG_DIR, 'youtube-client.json')
const TOKEN_FILE = join(CFG_DIR, 'youtube-token.json')
const LOG_DIR = join(homedir(), 'Library', 'Logs', 'nsds')
// Overridable so a CI runner can stage on the volume with the space (and so this is testable
// without a laptop's leftover transcodes silently satisfying the run).
const STAGE_DIR = process.env.NSDS_STAGE_DIR || join(homedir(), 'NSDS-youtube-upload')

// Where the show folders live: the <year> folders under NSDS/Media, discovered from Drive rather
// than pinned here. MEDIA_ROOT_ID is the single id this whole system knows, shared with the review
// page and (byte-identically) with Code.gs, so a new year needs no code change in either half.
//
// Resolved once per process and reused: every subcommand below wants the same list, and the
// listing is four rclone passes.
let rootsPromise = null
function roots() {
  if (!rootsPromise) {
    rootsPromise = discoverYearRoots(MEDIA_ROOT_ID)
      .then(ids => { log(`year roots under Media: ${ids.length}`); return ids })
  }
  return rootsPromise
}
// Which Google account owns the YouTube channel. This was hardcoded to
// hello@notsodailystandup.com, but that is the Workspace mailbox, not necessarily the channel
// owner -- the channel may well sit under the personal account. Getting it wrong means consenting
// as the wrong identity and uploading into the wrong channel, so it is a setting, not a constant.
// Whatever you sign in as during --auth is what the refresh token is bound to.
const CHANNEL_ACCOUNT = process.env.NSDS_YT_ACCOUNT || 'hello@notsodailystandup.com'
const CHANNEL_HINT = `Tech Comedy Show (${CHANNEL_ACCOUNT})`
const MAX_PER_RUN = Number(process.env.NSDS_MAX_PER_RUN) || 90
const MAX_HOURS = Number(process.env.NSDS_MAX_HOURS) || 6
const SCOPE = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly'
const CSV_NAME = 'youtube.csv'
const CSV_HEADER = 'file_id,filename,performer,youtube_id,youtube_url,title,uploaded_at'

// YouTube's ways of saying "no more today". quotaExceeded and dailyLimitExceeded are the API's
// quota. uploadLimitExceeded is the CHANNEL's own daily upload cap -- separate from the API quota
// and far lower: the channel took 10 uploads on 2026-10-15 and refused the 11th. It was missing
// from this list, so that day's runs kept transcoding for five more hours, tape after tape, each
// one refused at the last step.
const STOP_FOR_TODAY = /quotaExceeded|dailyLimitExceeded|uploadLimitExceeded/

const argv = process.argv.slice(2)
const args = new Set(argv)
const dryRun = args.has('--dry-run')

/**
 * --shard i/n restricts a run to every n-th pending tape, so several CI runners can drain the
 * backlog at once without colliding. Sharding is by POSITION in the pending list, not by show: the
 * list is deterministic (discovery sorts, and every runner computes the same one), and a show's
 * tapes therefore spread across shards instead of one runner drawing the 16-tape show and the
 * rest finishing early.
 *
 * Shards never write the same youtube.csv row, but two shards CAN write the same show's csv at
 * roughly the same time, and the loser's rows would be lost -- rclone copyto is a whole-file
 * replace. That is why the workflow runs --adopt once at the end, single-threaded: it re-reads the
 * channel and re-records anything a clobbered write dropped. The upload itself is never repeated,
 * because --adopt matches on title.
 */
function parseShard() {
  const flag = argv.find(a => a.startsWith('--shard'))
  if (!flag) return null
  const value = flag.includes('=') ? flag.split('=')[1] : argv[argv.indexOf(flag) + 1]
  const m = /^(\d+)\/(\d+)$/.exec(value || '')
  if (!m) throw new Error(`--shard wants i/n, e.g. --shard 1/6 (got ${value ?? 'nothing'})`)
  const [i, n] = [Number(m[1]), Number(m[2])]
  if (i < 1 || i > n) throw new Error(`--shard ${i}/${n}: i must be between 1 and n`)
  return { i, n }
}
const shard = parseShard()

/** Value of a `--flag value` / `--flag=value` option, or null. Same shape as parseShard's. */
function argValue(name) {
  const flag = argv.find(a => a === name || a.startsWith(`${name}=`))
  if (!flag) return null
  const value = flag.includes('=') ? flag.split('=').slice(1).join('=') : argv[argv.indexOf(flag) + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} wants a value`)
  return value
}

const DRAG_DIR = join(STAGE_DIR, 'DRAG-ME')
const titleFor = (tape, show) => `${tape.performer} — ${show.label}`
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
const log = (...a) => console.log(`[${ts()}]`, ...a)

// ----------------------------------------------------------------------------- oauth --

/**
 * The OAuth client, from the environment if it is there and from ~/.config/nsds otherwise.
 *
 * CI has no home directory worth writing secrets into, and putting them on disk just to read them
 * back is a way to leak them into a log or an artifact. So the three values that matter can each
 * come from an env var; the file stays the path of least resistance on the laptop.
 */
async function loadClient() {
  if (process.env.NSDS_YT_CLIENT_ID && process.env.NSDS_YT_CLIENT_SECRET) {
    return { id: process.env.NSDS_YT_CLIENT_ID, secret: process.env.NSDS_YT_CLIENT_SECRET }
  }
  let raw
  try { raw = JSON.parse(await readFile(CLIENT_FILE, 'utf8')) }
  catch { throw new Error(`no OAuth client at ${CLIENT_FILE} and no NSDS_YT_CLIENT_ID/SECRET — see the header of this file`) }
  const c = raw.installed || raw.web || raw
  if (!c.client_id || !c.client_secret) throw new Error(`${CLIENT_FILE} has no client_id/client_secret`)
  return { id: c.client_id, secret: c.client_secret }
}

/** The refresh token, from the environment in CI or ~/.config/nsds on the laptop. */
async function loadRefreshToken() {
  if (process.env.NSDS_YT_REFRESH_TOKEN) return process.env.NSDS_YT_REFRESH_TOKEN.trim()
  let saved
  try { saved = JSON.parse(await readFile(TOKEN_FILE, 'utf8')) }
  catch { throw new Error(`not authorised yet and no NSDS_YT_REFRESH_TOKEN — run: node tools/youtube-sync.mjs --auth`) }
  return saved.refresh_token
}

async function authorize() {
  const client = await loadClient()
  const port = 8765 + Math.floor(Math.random() * 1000)
  const redirect = `http://127.0.0.1:${port}/`
  const state = randomBytes(12).toString('hex')

  const code = await new Promise((resolve, reject) => {
    const srv = createServer((req, res) => {
      const u = new URL(req.url, redirect)
      if (u.searchParams.get('state') !== state) { res.writeHead(400).end('bad state'); return }
      if (u.searchParams.get('error')) { res.writeHead(200).end('Denied. You can close this tab.'); srv.close(); return reject(new Error(u.searchParams.get('error'))) }
      res.writeHead(200, { 'content-type': 'text/html' }).end('<h2>Connected. You can close this tab.</h2>')
      srv.close(); resolve(u.searchParams.get('code'))
    })
    srv.listen(port, '127.0.0.1', () => {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      url.search = new URLSearchParams({
        client_id: client.id, redirect_uri: redirect, response_type: 'code', scope: SCOPE,
        access_type: 'offline', prompt: 'consent', state,
        login_hint: CHANNEL_ACCOUNT,
      })
      console.log(`\nOpen this and sign in as ${CHANNEL_HINT}:\n\n  ${url}\n`)
      spawn('open', [url.toString()], { stdio: 'ignore', detached: true }).unref()
    })
    setTimeout(() => { srv.close(); reject(new Error('timed out waiting for consent')) }, 10 * 60 * 1000)
  })

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: client.id, client_secret: client.secret, redirect_uri: redirect, grant_type: 'authorization_code' }),
  })
  const tok = await res.json()
  if (!tok.refresh_token) throw new Error(`no refresh_token in response: ${JSON.stringify(tok)}`)

  // Check the consent actually landed on the account that owns the channel BEFORE saving it.
  // Signing in as the wrong Google account still produces a perfectly valid token -- it just has
  // no channel behind it, and the failure surfaces hours later as a confusing upload error. That
  // happened at least twice here; the dead ends are still sitting in ~/.config/nsds as
  // youtube-token.wrong-account.json and youtube-token.no-channel-2.json. One cheap call (1 quota
  // unit) turns a silent wrong turn into an error at the moment you can still fix it.
  const who = await (await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
    headers: { authorization: `Bearer ${tok.access_token}` },
  })).json()
  const channel = who.items?.[0]?.snippet?.title
  if (!channel) {
    throw new Error(
      `this identity has no YouTube channel, so nothing could be uploaded to it — not saving the token.\n` +
      `\n` +
      `  The likeliest cause is NOT the wrong Google account. "Tech Comedy Show" is a BRAND ACCOUNT,\n` +
      `  and a brand account is a separate YouTube identity owned by a Google account. Consenting as\n` +
      `  the person (Neal Paresh Patel) yields a perfectly valid token whose channel list is empty;\n` +
      `  only consenting AS THE BRAND uploads anywhere.\n` +
      `\n` +
      `  So on the consent screen there are two pickers, and the second is the one that matters:\n` +
      `    1. "Choose an account"  -> ${CHANNEL_ACCOUNT}\n` +
      `    2. "Choose a channel"   -> Tech Comedy Show     <-- NOT your own name\n` +
      `\n` +
      `  Google only shows the second picker when the account has a brand channel, and it defaults to\n` +
      `  the personal identity. Re-run --auth and pick the brand.`)
  }

  await mkdir(CFG_DIR, { recursive: true })
  await writeFile(TOKEN_FILE, JSON.stringify({ refresh_token: tok.refresh_token, obtained: ts(), channel }, null, 2), { mode: 0o600 })
  log(`saved ${TOKEN_FILE} — channel: ${channel}`)
}

async function accessToken() {
  const client = await loadClient()
  const refresh = await loadRefreshToken()
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: refresh, client_id: client.id, client_secret: client.secret, grant_type: 'refresh_token' }),
  })
  const tok = await res.json()
  if (!tok.access_token) {
    throw new Error(`token refresh failed (${tok.error || res.status}: ${tok.error_description || ''}). ` +
      `If it says invalid_grant the refresh token expired — the OAuth app is probably still in "Testing"; publish it, then --auth again.`)
  }
  return tok.access_token
}

// ----------------------------------------------------------------------------- csv --

const csvEsc = s => /[",\n]/.test(String(s ?? '')) ? `"${String(s).replace(/"/g, '""')}"` : String(s ?? '')
function parseCsv(text) {
  const rows = []
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue
    const cells = []; let cur = ''; let q = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ } else if (ch === '"') q = false; else cur += ch }
      else if (ch === '"') q = true
      else if (ch === ',') { cells.push(cur); cur = '' }
      else cur += ch
    }
    cells.push(cur)
    const [file_id, filename, performer, youtube_id, youtube_url, title, uploaded_at] = cells
    rows.push({ file_id, filename, performer, youtube_id, youtube_url, title, uploaded_at })
  }
  return rows
}

async function readShowCsv(show) {
  try {
    const text = await rclone(['cat', ...inFolder(show.folderId), `${REMOTE}:${CSV_NAME}`], { quiet: true })
    return parseCsv(text)
  } catch { return [] }
}

async function writeShowCsv(show, rows) {
  const body = [CSV_HEADER, ...rows.map(r => [r.file_id, r.filename, r.performer, r.youtube_id, r.youtube_url, r.title, r.uploaded_at].map(csvEsc).join(','))].join('\n') + '\n'
  const tmp = join(tmpdir(), `nsds-${show.folderId}-${CSV_NAME}`)
  await writeFile(tmp, body)
  await rclone(['copyto', ...inFolder(show.folderId), tmp, `${REMOTE}:${CSV_NAME}`], { quiet: true })
  await unlink(tmp).catch(() => {})
}

// ----------------------------------------------------------------------------- youtube --

/**
 * Open a resumable upload session. Done BEFORE transcoding: it's one cheap request, and it is where
 * YouTube says no (the channel's upload cap, quota, a dead token), so a refusal costs seconds
 * instead of a ten-minute transcode — STOP_FOR_TODAY alone still let each run transcode one tape
 * it could never upload. The size isn't known yet; the final chunk's Content-Range carries it.
 */
async function openUpload(token, { title, description }) {
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-type': 'video/mp4',
    },
    body: JSON.stringify({
      snippet: { title: title.slice(0, 100), description, categoryId: '23' },   // 23 = Comedy
      status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false },
    }),
  })
  if (!init.ok) {
    const body = await init.text()
    const err = new Error(`upload init ${init.status}: ${body.slice(0, 300)}`)
    err.quota = STOP_FOR_TODAY.test(body)
    throw err
  }
  return init.headers.get('location')
}

/** Send a file into an open resumable session. Returns the video id. */
async function uploadVideo(session, filePath) {
  const size = (await stat(filePath)).size

  // Send in 64 MB chunks so a dropped connection resumes from the last acked byte.
  //
  // A chunk PUT can fail outright — `fetch failed` when the socket dies mid-body, or a 5xx. Left
  // unhandled that abandoned the whole tape and burned one of the run's upload slots, which is how
  // three May 2026 sets failed the same way on three consecutive nights (2026-09-16). The
  // resumable protocol is built for exactly this: ask the session how much it actually has and
  // carry on from there. Only a quota rejection is worth giving up on.
  const CHUNK = 64 * 1024 * 1024
  const MAX_CHUNK_TRIES = 5
  const fh = await open(filePath, 'r')
  try {
    let offset = 0
    let tries = 0
    while (offset < size) {
      const end = Math.min(offset + CHUNK, size)
      const buf = Buffer.alloc(end - offset)
      await fh.read(buf, 0, end - offset, offset)
      let res
      try {
        res = await fetch(session, {
          method: 'PUT',
          headers: { 'content-length': String(end - offset), 'content-range': `bytes ${offset}-${end - 1}/${size}` },
          body: buf,
        })
      } catch (e) {                                            // network-level: retry from wherever it got to
        if (++tries >= MAX_CHUNK_TRIES) throw new Error(`upload failed after ${tries} tries at byte ${offset}: ${e.message}`)
        log(`    ${e.message} at byte ${offset} — retry ${tries}/${MAX_CHUNK_TRIES - 1}`)
        await sleep(2000 * tries)
        const at = await resumeOffset(session, size, offset)
        if (at.id) return at.id                                // it had actually finished
        offset = at.offset
        continue
      }
      if (res.status === 308) {
        const range = res.headers.get('range')                 // "bytes=0-N"
        offset = range ? Number(range.split('-')[1]) + 1 : end
        tries = 0
        continue
      }
      if (res.ok) {
        const json = await res.json()
        return json.id
      }
      const body = (await res.text()).slice(0, 300)
      if (STOP_FOR_TODAY.test(body)) {
        const err = new Error(`upload chunk ${res.status}: ${body}`)
        err.quota = true
        throw err
      }
      if (res.status >= 500 || res.status === 429) {
        if (++tries >= MAX_CHUNK_TRIES) throw new Error(`upload failed after ${tries} tries at byte ${offset}: ${res.status} ${body}`)
        log(`    HTTP ${res.status} at byte ${offset} — retry ${tries}/${MAX_CHUNK_TRIES - 1}`)
        await sleep(2000 * tries)
        const at = await resumeOffset(session, size, offset)
        if (at.id) return at.id
        offset = at.offset
        continue
      }
      throw new Error(`upload chunk ${res.status}: ${body}`)
    }
  } finally { await fh.close() }
  throw new Error('upload ended without a video id')
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * Ask a resumable session how many bytes it holds, per the protocol: an empty PUT with a
 * `content-range` of `bytes *` over the size answers 308 plus `Range: bytes=0-N`. A 2xx instead
 * means the upload actually completed while we thought it had failed, and the body is the video —
 * return its id so the caller doesn't re-upload it. If the query itself fails, keep the offset we
 * had: re-sending a chunk the server already holds is harmless.
 *
 * Returns { offset } or { id }.
 */
async function resumeOffset(session, size, current) {
  try {
    const res = await fetch(session, { method: 'PUT', headers: { 'content-length': '0', 'content-range': `bytes */${size}` } })
    if (res.status === 308) {
      const range = res.headers.get('range')
      return { offset: range ? Number(range.split('-')[1]) + 1 : current }
    }
    if (res.ok) {
      const json = await res.json().catch(() => null)
      if (json?.id) return { id: json.id }
    }
  } catch { /* fall through and retry the same chunk */ }
  return { offset: current }
}

// ----------------------------------------------------------------------------- main --

/**
 * The nightly job runs from a COPY under ~/Library/Application Support/nsds/, not from the
 * checkout: launchd agents do not inherit Terminal's TCC grant for ~/Documents, so running the
 * repo file directly fails with EPERM.
 *
 * That copy used to be made by hand, and it silently rotted — on 2026-09-18 the deployed file was
 * several commits behind the repo (no discoverYearRoots, no isFullShowTape), so fixes that had
 * been merged for weeks had never actually run. Editing the repo did nothing. So --install-cron
 * now deploys as well as schedules: it copies the whole import closure, preserving the repo's
 * relative layout so every import resolves unchanged, and repoints the plist at the copy.
 *
 * Adding an import to this file or to lib/tapes.mjs means adding it to DEPLOY_FILES.
 */
const DEPLOY_DIR = join(homedir(), 'Library', 'Application Support', 'nsds', 'youtube-sync')
const DEPLOY_FILES = [
  'tools/youtube-sync.mjs',
  'tools/lib/tapes.mjs',
  'videoreview/shows.js',      // MEDIA_ROOT_ID, imported by this file
  'videoreview/tapes.js',      // EXCLUDED_TAPE_RE, imported by shows.js
]

async function installCron() {
  const { copyFile } = await import('node:fs/promises')
  const { dirname, resolve } = await import('node:path')
  const repo = resolve(dirname(new URL(import.meta.url).pathname), '..')

  for (const rel of DEPLOY_FILES) {
    const dest = join(DEPLOY_DIR, rel)
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(join(repo, rel), dest)
    log(`  deployed ${rel}`)
  }

  const plist = join(homedir(), 'Library', 'LaunchAgents', 'com.nsds.youtube-sync.plist')
  await mkdir(LOG_DIR, { recursive: true })
  const node = process.execPath
  const script = join(DEPLOY_DIR, 'tools', 'youtube-sync.mjs')
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.nsds.youtube-sync</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${script}</string></array>
  <key>WorkingDirectory</key><string>${DEPLOY_DIR}</string>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>${LOG_DIR}/youtube-sync.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/youtube-sync.log</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string><key>HOME</key><string>${homedir()}</string></dict>
</dict></plist>
`
  await writeFile(plist, xml)
  await new Promise(r => spawn('launchctl', ['unload', plist], { stdio: 'ignore' }).on('close', r))
  await new Promise((res, rej) => spawn('launchctl', ['load', plist], { stdio: 'inherit' }).on('close', c => c === 0 ? res() : rej(new Error(`launchctl load exited ${c}`))))
  log(`installed ${plist} — runs daily 03:30, logs to ${LOG_DIR}/youtube-sync.log`)
  log(`running from ${script} — re-run --install-cron after every change to this file`)
  log('launchd does not run while the Mac sleeps. If a run is missed it simply runs at the next 03:30 the Mac is awake.')
}

/**
 * Transcode every not-yet-uploaded tape and hardlink it into DRAG-ME/ under its YouTube title,
 * so dragging that folder into youtube.com/upload gives correctly titled videos with zero API
 * quota. Follow with --adopt once they're processed.
 */
async function stageAll() {
  const shows = await discoverShows(await roots())
  await mkdir(DRAG_DIR, { recursive: true })
  const { link } = await import('node:fs/promises')
  let made = 0, had = 0
  for (const show of shows) {
    const done = new Map((await readShowCsv(show)).filter(r => r.youtube_id).map(r => [r.file_id, r]))
    for (const tape of show.tapes) {
      if (done.has(tape.id)) continue
      // Same rule as the API path: a whole-show recording is never mirrored to YouTube, so it must
      // not be transcoded and hardlinked into DRAG-ME either — that folder is a drag-and-drop
      // upload queue, and a 34.9 GB full show sitting in it is the same mistake by hand.
      if (isFullShowTape(tape.name)) continue
      const staged = join(STAGE_DIR, show.folderId, `${tape.id}.mp4`)
      const pretty = join(DRAG_DIR, `${titleFor(tape, show).replace(/[/\\:*?"<>|]/g, '-')}.mp4`)
      await mkdir(join(STAGE_DIR, show.folderId), { recursive: true })
      let have = false
      try { have = (await stat(staged)).size > 0 } catch {}
      if (!have) {
        log(`▶ ${titleFor(tape, show)}  (${(tape.size / 1e9).toFixed(1)} GB)`)
        const t0 = Date.now()
        try {
          await transcode(tape, show.rootId, staged, { log })
          log(`  staged in ${((Date.now() - t0) / 60000).toFixed(1)} min`)
          made++
        } catch (err) { log(`  ✗ ${err.message}`); continue }
      } else had++
      try { await link(staged, pretty) } catch (e) { if (e.code !== 'EEXIST') throw e }
    }
  }
  log(`ready: ${made} transcoded now, ${had} already staged → ${DRAG_DIR}`)
  log('drag that folder into https://youtube.com/upload, set Visibility = Unlisted for all, then run --adopt')
}

/** Uploads playlist of the channel, all pages. 1 unit per page. */
async function channelUploads(token) {
  const h = { authorization: `Bearer ${token}` }
  const ch = await (await fetch('https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true', { headers: h })).json()
  const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads
  if (!uploads) throw new Error('no channel on this identity')
  const out = []
  let pageToken = ''
  do {
    const u = new URL('https://www.googleapis.com/youtube/v3/playlistItems')
    u.search = new URLSearchParams({ part: 'snippet', playlistId: uploads, maxResults: '50', pageToken })
    const r = await (await fetch(u, { headers: h })).json()
    if (r.error) throw new Error(r.error.message)
    for (const it of r.items || []) out.push({ id: it.snippet.resourceId.videoId, title: it.snippet.title })
    pageToken = r.nextPageToken || ''
  } while (pageToken)
  return out
}

/**
 * Bring already-uploaded videos' titles in line with the current tape filenames — tapes were
 * renamed to "<Performer> Set.mp4" ("Albberta_4-23-26.mp4" -> "Alberta Set.mp4"), and the titles
 * on YouTube still say the old thing. videos.update costs ~50 quota units, so this is cheap.
 */
async function retitle() {
  const shows = await discoverShows(await roots())
  const token = dryRun ? null : await accessToken()
  let changed = 0
  for (const show of shows) {
    const rows = await readShowCsv(show)
    let dirty = false
    for (const r of rows) {
      const tape = show.tapes.find(t => t.id === r.file_id)
      if (!tape || !r.youtube_id) continue
      const want = titleFor(tape, show)
      if (r.title === want) continue
      log(`${r.title}  ->  ${want}`)
      if (!dryRun) {
        const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet`, {
          method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: r.youtube_id, snippet: { title: want.slice(0, 100), categoryId: '23', description: `Artificially Unintelligent — ${show.label}. Proof tape for clip requests.` } }),
        })
        if (!res.ok) { log(`  ✗ ${res.status} ${(await res.text()).slice(0, 200)}`); continue }
        r.title = want; r.performer = tape.performer; r.filename = tape.name; dirty = true
      }
      changed++
    }
    if (dirty) await writeShowCsv(show, rows)
  }
  log(`${dryRun ? 'would retitle' : 'retitled'} ${changed}`)
}

/** Match hand-uploaded videos to tapes by exact title and record them. Idempotent. */
async function adopt() {
  const token = await accessToken()
  const videos = await channelUploads(token)
  const byTitle = new Map(videos.map(v => [v.title.trim(), v]))
  log(`channel has ${videos.length} uploads`)
  const shows = await discoverShows(await roots())
  let adopted = 0, missing = []
  for (const show of shows) {
    const rows = await readShowCsv(show)
    const done = new Set(rows.filter(r => r.youtube_id).map(r => r.file_id))
    let changed = false
    for (const tape of show.tapes) {
      if (done.has(tape.id)) continue
      const title = titleFor(tape, show)
      const v = byTitle.get(title)
      if (!v) { missing.push(title); continue }
      rows.push({ file_id: tape.id, filename: tape.name, performer: tape.performer, youtube_id: v.id,
                  youtube_url: `https://youtu.be/${v.id}`, title, uploaded_at: ts() })
      log(`  ✓ ${title} → https://youtu.be/${v.id}`)
      changed = true; adopted++
      await unlink(join(STAGE_DIR, show.folderId, `${tape.id}.mp4`)).catch(() => {})
      await unlink(join(DRAG_DIR, `${title.replace(/[/\\:*?"<>|]/g, '-')}.mp4`)).catch(() => {})
    }
    if (changed) await writeShowCsv(show, rows)
  }
  log(`adopted ${adopted}; ${missing.length} tape(s) still have no matching upload`)
  for (const m of missing) log(`    not on channel yet: ${m}`)
}

/**
 * Walk every show once and classify its tapes. The uploader and --status both start here, so the
 * page cannot report a backlog the uploader disagrees with.
 *
 * Costs no YouTube quota: done-ness comes from each show's youtube.csv, not from listing the
 * channel. That is what lets --status produce a correct report while uploads are broken.
 */
async function inventory() {
  const shows = await discoverShows(await roots())
  const out = []
  for (const show of shows) {
    const rows = await readShowCsv(show)
    out.push({ show, rows, classified: classifyTapes(show, rows) })
  }
  return out
}

/**
 * Write the inventory to data/upload-status.json for the internal status page.
 *
 * Read-only against Drive and the channel both -- it uploads nothing, needs no YouTube credential,
 * and is safe to run at any time.
 */
async function status() {
  const outPath = argValue('--out') || join(import.meta.dirname, '..', 'data', 'upload-status.json')
  const inv = await inventory()
  for (const { show, classified } of inv) log(summaryLine(show, classified))

  // Whatever CI knows about the run that produced this, so the page can say "the last sync failed"
  // instead of quietly showing a backlog that is not moving. Absent when run from a laptop.
  const run = process.env.GITHUB_RUN_ID ? {
    id: process.env.GITHUB_RUN_ID,
    url: `https://github.com/${process.env.GITHUB_REPOSITORY || 'Desitrain22/nsds-site'}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    sync: process.env.NSDS_SYNC_RESULT || 'unknown',
    adopt: process.env.NSDS_ADOPT_RESULT || 'unknown',
  } : null

  // A real ISO timestamp, unlike ts(), which is the human log format the csv's uploaded_at uses.
  const payload = statusPayload(inv.map(({ show, rows }) => showStatus(show, rows)), { generatedAt: new Date().toISOString(), run })
  await mkdir(join(outPath, '..'), { recursive: true })
  await writeFile(outPath, JSON.stringify(payload, null, 2) + '\n')
  const t = payload.totals
  log(`wrote ${outPath}: ${t.shows} shows, ${t.tapes} tapes, ${t.uploaded} uploaded, ${t.pending} pending, ${t.heldBack} held back`)
}

/** The per-show inventory line, identical for a sync run and a status run. */
function summaryLine(show, classified) {
  const n = state => classified.filter(c => c.state === state).length
  const held = n('held-back')
  return `${show.label}: ${show.tapes.length} tapes, ${n('uploaded')} on YouTube, ${n('pending')} to go`
       + (held ? `, ${held} full-show tape${held === 1 ? '' : 's'} not uploaded` : '')
}

async function main() {
  if (args.has('--auth')) return authorize()
  if (args.has('--install-cron')) return installCron()
  if (args.has('--stage-all')) return stageAll()
  if (args.has('--adopt')) return adopt()
  if (args.has('--retitle')) return retitle()
  if (args.has('--status')) return status()

  const inv = await inventory()
  const pending = []
  for (const { show, rows, classified } of inv) {
    log(summaryLine(show, classified))
    for (const c of classified) if (c.state === 'pending') pending.push({ show, tape: c.tape, rows })
  }
  if (!pending.length) { log('nothing to do'); return }

  // Applied AFTER the inventory above is logged, so every shard's log still shows the whole
  // backlog and not just its own slice — otherwise six runners each report "9 to go" and nobody
  // can tell what the real remaining count is.
  const mine = shard ? pending.filter((_, idx) => idx % shard.n === shard.i - 1) : pending
  if (shard) log(`shard ${shard.i}/${shard.n}: ${mine.length} of ${pending.length} pending tapes`)
  if (!mine.length) { log('nothing in this shard'); return }

  if (dryRun) { for (const p of mine) console.log(`  would upload  ${p.show.label} / ${p.tape.name}  (${(p.tape.size / 1e9).toFixed(1)} GB)`); return }

  // A preflight, so a dead refresh token fails in seconds instead of after the first ten-minute
  // transcode. The token each upload actually uses is fetched fresh, below.
  await accessToken()
  await mkdir(STAGE_DIR, { recursive: true })
  let uploaded = 0
  let failed = 0
  let limited = false   // stopped by YouTube's daily caps: how a backlog drains, not a failure
  const deadline = Date.now() + MAX_HOURS * 3600_000

  for (const { show, tape, rows } of mine) {
    if (uploaded >= MAX_PER_RUN) { log(`reached ${MAX_PER_RUN} uploads for today; ${mine.length - uploaded} remain in this shard`); break }
    // Checked between tapes, never during one: a tape that has started is always finished or
    // failed on its own terms, so the deadline can't strand a half-transcoded file.
    if (Date.now() >= deadline) { log(`hit the ${MAX_HOURS}h budget for this run; ${mine.length - uploaded} remain in this shard`); break }
    const title = `${tape.performer} — ${show.label}`
    const staged = join(STAGE_DIR, show.folderId, `${tape.id}.mp4`)
    await mkdir(join(STAGE_DIR, show.folderId), { recursive: true })
    log(`▶ ${title}  (${tape.name}, ${(tape.size / 1e9).toFixed(1)} GB)`)

    try {
      // A fresh access token per upload, not one per run. They last an hour, and this used to
      // fetch a single one up front, so every upload after the first hour got a 401: on
      // 2026-10-15 a one-shard run transcoded 40 tapes over five hours and all 40 were refused.
      // A refresh is one cheap call and costs no YouTube quota.
      const session = await openUpload(await accessToken(), {
        title,
        description: `Artificially Unintelligent — ${show.label}. Proof tape for clip requests.`,
      })
      let have = false
      try { have = (await stat(staged)).size > 0 } catch {}
      if (!have) {
        const t0 = Date.now()
        const info = await transcode(tape, show.rootId, staged, { log })
        log(`  transcoded ${info.width}x${info.height} ${(await stat(staged)).size / 1e6 | 0} MB in ${((Date.now() - t0) / 60000).toFixed(1)} min`)
      } else log('  using staged file')

      const id = await uploadVideo(session, staged)
      const url = `https://youtu.be/${id}`
      log(`  ✓ ${url}`)
      rows.push({ file_id: tape.id, filename: tape.name, performer: tape.performer, youtube_id: id, youtube_url: url, title, uploaded_at: ts() })
      await writeShowCsv(show, rows)
      await unlink(staged).catch(() => {})
      uploaded++
    } catch (err) {
      log(`  ✗ ${err.message}`)
      failed++
      if (err.quota) { limited = true; log('  YouTube will take no more uploads today — stopping; the rest goes tomorrow'); break }
    }
  }
  log(`done: ${uploaded} uploaded this run` + (failed ? `, ${failed} failed` : ''))

  // A run that had work and completed none of it is a FAILURE, even though every individual error
  // above was caught and logged. The first CI backfill exited 0 with six green shards and zero
  // uploads -- ffmpeg was being asked for h264_videotoolbox, an encoder that exists only on macOS
  // -- and the only reason anyone noticed is that someone counted the tapes in Drive afterwards.
  // Catching per-tape errors is right, because one bad tape must not strand the rest; reporting
  // success when the count is zero is not.
  // Reaching the cap first thing (zero uploads, one refusal) is a normal night while the backlog is
  // bigger than the cap — not red. Anything else failing still is.
  if (uploaded === 0 && failed > (limited ? 1 : 0)) {
    process.exitCode = 1
    log(`FAILED: ${failed} tape(s) attempted, none uploaded — see the ✗ lines above`)
  }
}

main().catch(err => { console.error(`[${ts()}] FATAL ${err.message}`); process.exit(1) })
