/**
 * NSDS Tape Review — Apps Script backend.
 *
 * Deploy: script.google.com -> new project -> paste this -> Deploy -> New deployment
 *   -> type "Web app", Execute as **Me**, Who has access **Anyone** -> copy the /exec URL.
 * Then Project Settings -> Script properties -> add `PASSWORD` (the phrase the page asks for).
 *
 * Runs as Neal, so it needs no OAuth client, stores no token on disk, and is immune to the
 * 7-day refresh-token expiry that hits GCP OAuth apps left in "Testing" status.
 *
 * ------------------------------------------------------------------------------------
 * CALLING CONVENTION — this bit is load-bearing.
 * Apps Script cannot answer a CORS preflight (it never sees the OPTIONS request). A fetch
 * POST with `Content-Type: application/json` triggers a preflight and therefore always
 * fails from a browser. The client must send `Content-Type: text/plain` with a
 * JSON.stringify'd body, which is a CORS "simple request" and skips the preflight. We read
 * it back out of e.postData.contents.
 * ------------------------------------------------------------------------------------
 */

// ---------------------------------------------------------------- sheet layout --

var HEADER_ROW = 3;
var FIRST_DATA_ROW = 5;   // row 4 is the "(sample)" row, kept for the editing team

// Columns A-G are the contract with the editing team and must stay byte-identical in
// spirit to the sheets they already read. H-L are ours.
var HUMAN_HEADERS = [
  'Name',
  'Start Time',
  'End Time',
  '(Optional) granular time stamps',
  '(Optional) Notes',
  'Links (if you want to pic some of your own images to pop up etc)',
  'Thumbnail notes'
];

// H3 doubles as a schema fingerprint: if it doesn't match exactly, refuse to write.
var MACHINE_HEADERS = [
  '⚙ clip_id (v1 — do not edit)',
  '⚙ ranges_json',
  '⚙ rev',
  '⚙ video_file_id',
  '⚙ updated_at'
];

var COL = { NAME: 1, START: 2, END: 3, GRANULAR: 4, NOTES: 5, LINKS: 6, THUMB: 7,
            CLIP_ID: 8, RANGES: 9, REV: 10, VIDEO_ID: 11, UPDATED: 12 };
var LAST_COL = 12;

// Column M: where the editing team pastes the finished clip's Drive link once a request has been
// cut. getClips reads it (the card shows "Finished clip"); it is written by hand or by
// adminSetClipLinks, never by saveClip — it sits outside the A–L row write so a performer's save
// can never clobber the editor's link.
var LINK_COL = 13;
var LINK_HEADER = 'Finished clip (Drive link)';

var PREAMBLE_1 = [
  'tapes are here',
  "Feel free to be as granular or loose with edits as you'd like -- note our editing team " +
    'works with many a-list comics and have a good knack for pop ups, jump cuts, zooms, etc. ' +
    'Though the more notes you give, the easier it will be to create the content you want',
  'They\'ll look like this after editing!'
];
var PREAMBLE_2 = [
  'Q: "But Neal, why don\'t I just take the proof and edit it myself?',
  "A: Because then they'll suck! These are non-full res proofs + only 1 of our 3 angles. " +
    'We have a standard that we want to hold to. Editing it on your own undermines our ' +
    'video, editing, and design team look bad!'
];
var SAMPLE_ROW = [
  'Neal (sample)', "1:12'ish", '1:53', '1:12 - 1:19, 1:21 - 1:27',
  "Include a pop up image of the AWS logo when it's mentioned", '', '"AWS"'
];

// ---------------------------------------------------------------- entry point --

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    // One-time bootstrap so deployment is scriptable: the FIRST call to `setup` on a fresh
    // deployment claims the passphrase; every later one is refused. The window is the few
    // seconds between `clasp deploy` finishing and tools/deploy-backend.sh calling this, on a
    // URL nobody else has yet. After that the property can only be changed in Project Settings.
    if (body.action === 'setup') {
      var props = PropertiesService.getScriptProperties();
      if (props.getProperty('PASSWORD')) return json({ ok: false, error: 'already configured' });
      if (!body.password || String(body.password).length < 8) {
        return json({ ok: false, error: 'passphrase must be at least 8 characters' });
      }
      props.setProperty('PASSWORD', String(body.password));
      return json({ ok: true, configured: true });
    }

    // Migration/admin surface. Gated by a SEPARATE secret so the performer passphrase never
    // unlocks anything that can write to arbitrary rows. Claiming ADMIN_KEY requires the current
    // passphrase and only works once; afterwards it's changed in Project Settings like PASSWORD.
    if (body.action === 'setupAdmin') {
      var p2 = PropertiesService.getScriptProperties();
      if (!checkPassword(body.password)) return json({ ok: false, error: 'bad password' });
      if (p2.getProperty('ADMIN_KEY')) return json({ ok: false, error: 'already configured' });
      if (!body.adminKey || String(body.adminKey).length < 24) {
        return json({ ok: false, error: 'adminKey must be at least 24 characters' });
      }
      p2.setProperty('ADMIN_KEY', String(body.adminKey));
      return json({ ok: true, configured: true });
    }
    // Authenticated by a Drive nonce rather than a key — see rotateKeys. Deliberately ahead of
    // every secret check, because the secret it replaces may be the one that was lost.
    if (body.action === 'rotateChallenge') return json(withLock(function () { return rotateChallenge(); }));
    if (body.action === 'rotateKeys') return json(withLock(function () { return rotateKeys(body); }));
    if (body.action === 'keyStatus')  return json(keyStatus());

    // Same one-shot shape as setupAdmin: claiming UPLOAD_KEY needs the current passphrase and
    // only works while the property is unset. After that it changes in Project Settings.
    if (body.action === 'setupUpload') {
      var p3 = PropertiesService.getScriptProperties();
      if (!checkPassword(body.password)) return json({ ok: false, error: 'bad password' });
      if (p3.getProperty('UPLOAD_KEY')) return json({ ok: false, error: 'already configured' });
      if (!body.uploadKey || String(body.uploadKey).length < 24) {
        return json({ ok: false, error: 'uploadKey must be at least 24 characters' });
      }
      p3.setProperty('UPLOAD_KEY', String(body.uploadKey));
      return json({ ok: true, configured: true });
    }

    // The videographer surface. Gated by UPLOAD_KEY ALONE — deliberately not the performer
    // passphrase, so a videographer can file footage without being able to read anyone's clip
    // requests, and so rotating one does not disturb the other.
    if (/^upload/.test(String(body.action || ''))) {
      // Distinguish the two failures, the same way the performer gate already does for PASSWORD.
      // "upload key required" for both meant a backend with no key set looked identical to a typo,
      // which cost real time the first time this was configured.
      if (!checkUpload(body)) {
        return json({ ok: false, error: uploadConfigured()
          ? 'that upload key is wrong'
          : 'no UPLOAD_KEY is set on the backend yet — add it in Project Settings' });
      }
      if (body.action === 'uploadCreateShow') return json(withLock(function () { return uploadCreateShow(body); }));
      if (body.action === 'uploadShows')      return json(uploadShows(body));
      if (body.action === 'uploadPreview')    return json(uploadPreview(body));
      if (body.action === 'uploadStatus')     return json(uploadStatus(body));
      return json({ ok: false, error: 'unknown upload action: ' + body.action });
    }

    if (/^admin/.test(String(body.action || ''))) {
      // Both secrets: the admin key AND the performer passphrase.
      if (!checkAdmin(body) || !checkPassword(body.password)) return json({ ok: false, error: 'admin key required' });
      if (body.action === 'adminListFolder')  return json(adminListFolder(body));
      if (body.action === 'adminCreateFolder') return json(withLock(function () { return adminCreateFolder(body); }));
      if (body.action === 'adminMoveFile')     return json(withLock(function () { return adminMoveFile(body); }));
      if (body.action === 'adminRenameFile')   return json(withLock(function () { return adminRenameFile(body); }));
      if (body.action === 'adminCreateShortcut') return json(withLock(function () { return adminCreateShortcut(body); }));
      if (body.action === 'adminFixHeader')     return json(withLock(function () { return adminFixHeader(body); }));
      if (body.action === 'adminSheetInfo')   return json(adminSheetInfo(body));
      if (body.action === 'adminReadRows')    return json(adminReadRows(body));
      if (body.action === 'adminEnsureSheet') return json(withLock(function () { return adminEnsureSheet(body); }));
      if (body.action === 'adminAdoptRows')   return json(withLock(function () { return adminAdoptRows(body); }));
      if (body.action === 'adminImportLegacy') return json(withLock(function () { return adminImportLegacy(body); }));
      if (body.action === 'adminSetClipLinks') return json(withLock(function () { return adminSetClipLinks(body); }));
      return json({ ok: false, error: 'unknown admin action: ' + body.action });
    }

    if (!checkPassword(body.password)) {
      var configured = !!PropertiesService.getScriptProperties().getProperty('PASSWORD');
      return json({ ok: false, error: configured
        ? 'bad password'
        : 'backend has no PASSWORD script property set — add it in Project Settings' });
    }

    var action = body.action;
    // Nothing but "your passphrase is good" — the one action that touches no Drive at all.
    if (action === 'ping')       return json({ ok: true });
    if (action === 'listShows')  return json(listShows(body));
    if (action === 'listTapes')  return json(listTapes(body));
    if (action === 'getClips')   return json(getClips(body));
    if (action === 'saveClip')   return json(withLock(function () { return saveClip(body); }));
    if (action === 'deleteClip') return json(withLock(function () { return deleteClip(body); }));
    return json({ ok: false, error: 'unknown action: ' + action });
  } catch (err) {
    return json({ ok: false, error: String(err && err.stack || err) });
  }
}

// A GET is handy for a browser smoke test without building a request.
function doGet() {
  return json({ ok: true, service: 'nsds-tape-review', now: new Date().toISOString() });
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Fails CLOSED. The deploy steps add the script property after the first deployment, so an
 * "unset means open" rule leaves a real window where an Anyone-access endpoint accepts
 * saveClip and deleteClip against live sheets with no credential at all.
 */
function checkPassword(supplied) {
  var expected = PropertiesService.getScriptProperties().getProperty('PASSWORD');
  if (!expected) return false;
  return String(supplied || '') === expected;
}

/**
 * Serialize every mutation. Two browser tabs, or a retry racing its original request,
 * would otherwise both read "no such clip_id" and both append — producing duplicate rows
 * that are invisible in the UI because the id column is off to the right.
 */
function withLock(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, error: 'busy, try again' };
  try { return fn(); } finally { lock.releaseLock(); }
}

// ---------------------------------------------------------------- shows --
// The ONE Drive id the app knows: NSDS/Media. Everything else is discovered from the folder layout
//   Media/<year>/<Month YYYY (City)>/{tapes, photos, completed_clips, extras, <Show> Tape Requests}
// so a new show is a new folder in Drive, with nothing to pin in the repo.
var MEDIA_ROOT_ID = '1nD-5TFDv5cFnriCdTOBC1JlF709A9eLD';
// Keep byte-identical with SHOW_FOLDER_RE in videoreview/shows.js (test.mjs asserts it).
var SHOW_FOLDER_RE = /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})(?:\s*\((.+)\))?$/i;
var MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
var SHOWS_CACHE_KEY = 'shows:v2';
var SHOWS_CACHE_SECONDS = 21600;   // six hours, the CacheService maximum; body.refresh bypasses

/**
 * Every show folder under Media/<year>/, newest first, with its standard subfolders and request
 * sheet resolved by NAME. Uses the Drive advanced service so the whole tree is five list calls
 * (~2 s) instead of ~150 DriveApp iterator round-trips (~30 s). Cached; a new show folder shows up
 * within six hours, or at once with { refresh: true }. Folders that don't look like
 * "<Month> <YYYY> (City)" are ignored — that is how "_deprecated (review)" stays out of the picker.
 */
function listShows(body) {
  var cache = CacheService.getScriptCache();
  if (!body.refresh) {
    var hit = cache.get(SHOWS_CACHE_KEY);
    if (hit) { var cached = JSON.parse(hit); cached.cached = true; return cached; }
  }
  var FOLDER = 'application/vnd.google-apps.folder';
  var SHEET = 'application/vnd.google-apps.spreadsheet';
  var years = driveChildren([MEDIA_ROOT_ID], FOLDER).filter(function (f) { return /^\d{4}$/.test(f.name); });
  var showFolders = driveChildren(years.map(function (y) { return y.id; }), FOLDER)
    .map(function (f) { return { f: f, m: f.name.match(SHOW_FOLDER_RE) }; })
    .filter(function (x) { return x.m; });
  var showIds = showFolders.map(function (x) { return x.f.id; });
  var subs = driveChildren(showIds, FOLDER);
  var rootSheets = driveChildren(showIds, SHEET);
  var extrasIds = subs.filter(function (s) { return /^extras?$/i.test(s.name); }).map(function (s) { return s.id; });
  var extrasSheets = driveChildren(extrasIds, SHEET);

  var shows = showFolders.map(function (x) {
    var f = x.f, m = x.m;
    var rec = {
      folderId: f.id, name: f.name,
      label: m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() + ' ' + m[2],
      month: MONTHS.indexOf(m[1].toLowerCase()) + 1, year: Number(m[2]), city: m[3] ? m[3].trim() : null,
      tapesFolderId: null, photosFolderId: null, completedClipsFolderId: null, extrasFolderId: null,
      sheetId: null, legacySheetId: null
    };
    var mine = subs.filter(function (s) { return s.parents.indexOf(f.id) !== -1; });
    var byKey = { tapes: [], photos: [], completed_clips: [], extras: [] };
    mine.forEach(function (s) { var n = s.name.toLowerCase().replace(/[\s-]+/g, '_'); if (byKey[n]) byKey[n].push(s); });
    rec.tapesFolderId = pickFolder(byKey.tapes);
    rec.photosFolderId = pickFolder(byKey.photos);
    rec.completedClipsFolderId = pickFolder(byKey.completed_clips);
    rec.extrasFolderId = pickFolder(byKey.extras);
    // Same rule as getShowSheet: the spreadsheet in the show root whose name says "request".
    var sheet = rootSheets.filter(function (s) { return s.parents.indexOf(f.id) !== -1 && /request/i.test(s.name); })[0];
    if (sheet) rec.sheetId = sheet.id;
    if (rec.extrasFolderId) {
      var old = extrasSheets.filter(function (s) { return s.parents.indexOf(rec.extrasFolderId) !== -1 && /request|clips/i.test(s.name); })[0];
      if (old) rec.legacySheetId = old.id;
    }
    return rec;
  });
  shows.sort(function (a, b) { return (b.year - a.year) || (b.month - a.month) || a.name.localeCompare(b.name); });
  var out = { ok: true, shows: shows, scannedAt: new Date().toISOString() };
  try { cache.put(SHOWS_CACHE_KEY, JSON.stringify(out), SHOWS_CACHE_SECONDS); } catch (e) { /* over 100KB — just don't cache */ }
  return out;
}

/** Non-trashed children of any of `parentIds` with the given mime type, via Drive v3 (one call per 20 parents). */
function driveChildren(parentIds, mimeType) {
  var out = [];
  for (var i = 0; i < parentIds.length; i += 20) {
    var chunk = parentIds.slice(i, i + 20);
    var q = "trashed = false and mimeType = '" + mimeType + "' and (" +
      chunk.map(function (id) { return "'" + id + "' in parents"; }).join(' or ') + ')';
    var token = null;
    do {
      var res = Drive.Files.list({ q: q, fields: 'nextPageToken, files(id, name, parents)', pageSize: 1000, pageToken: token });
      (res.files || []).forEach(function (f) { out.push(f); });
      token = res.nextPageToken || null;
    } while (token);
  }
  return out;
}

/**
 * Two folders with the same name (February 2026 had an empty duplicate completed_clips/): the one
 * that actually holds files wins, then the first seen. The extra list call only happens for
 * duplicates, which are rare.
 */
function pickFolder(list) {
  if (!list.length) return null;
  if (list.length === 1) return list[0].id;
  for (var i = 0; i < list.length; i++) {
    try {
      var r = Drive.Files.list({ q: "trashed = false and '" + list[i].id + "' in parents", fields: 'files(id)', pageSize: 1 });
      if (r.files && r.files.length) return list[i].id;
    } catch (e) {}
  }
  return list[0].id;
}

// ---------------------------------------------------------------- tapes --

// ---------------------------------------------------------------- tape discovery --
// Keep these three literals byte-identical with videoreview/tapes.js — test.mjs checks that.
var TAPES_FOLDER_RE  = /^(tapes|set tapes|sets|footage)$/i;
var SKIP_FOLDER_RE   = /^(flicks|photos?|stills|proxies|clips|completed[ _-]?clips|extras?)$/i;
var EXCLUDED_TAPE_RE = /sizzle|highlight|update|recap|rough/i;
// Scan the tapes root plus ONE level of subfolders (an "Angle B" folder, say). Matches the
// rclone copies' --max-depth 2. Note collectVideos collects files BEFORE the depth check, so
// depth N means N+1 levels of files.
var MAX_DEPTH = 1;

/** Reels, sizzles and recaps live alongside the set tapes but aren't anyone's set. */
function isExcludedTape(name) {
  return EXCLUDED_TAPE_RE.test(name);
}

/**
 * Where to start scanning for tapes. A pinned folder wins; otherwise exactly one subfolder named
 * like a tapes folder (tapes / Set Tapes / Sets / Footage) is used; otherwise the show folder
 * itself. Starting from the tapes root means completed_clips/ is never entered even if someone
 * renames it later — the scan simply never leaves the tapes tree.
 */
function resolveTapesRoot(showFolder, tapesFolderId) {
  if (tapesFolderId) return { folder: DriveApp.getFolderById(tapesFolderId), mode: 'pinned' };
  var subs = showFolder.getFolders();
  var hit = null, n = 0;
  while (subs.hasNext()) {
    var sub = subs.next();
    if (TAPES_FOLDER_RE.test(sub.getName())) { hit = sub; n++; }
  }
  return n === 1 ? { folder: hit, mode: 'named' } : { folder: showFolder, mode: 'showFolder' };
}

/**
 * Collect video files from a folder and its subfolders, skipping photo/clip/proxy folders.
 * Finished clips are NOT catchable by name (BenClip_…, PeterClip1.mp4, Daycares.mp4 …), which is
 * why exclusion is by FOLDER. Measured before this rule existed: NYTW listed 18 "tapes", 15 of
 * them finished clips out of its Clips/ folder.
 */
function collectVideos(folder, depth, out) {
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    // A Drive shortcut reports the shortcut mime type, so it is skipped here on purpose: the
    // reorg moves real files, and a shortcut tape would be invisible to the app anyway.
    if (f.getMimeType().indexOf('video/') !== 0) continue;
    var name = f.getName();
    if (isExcludedTape(name)) continue;
    out.push({ file: f, name: name, folderName: folder.getName() });
  }
  if (depth >= MAX_DEPTH) return out;
  var subs = folder.getFolders();
  while (subs.hasNext()) {
    var sub = subs.next();
    if (SKIP_FOLDER_RE.test(sub.getName())) continue;
    collectVideos(sub, depth + 1, out);
  }
  return out;
}

/** Videos in a show's completed_clips/ folder, newest name-sorted. Read-only, one folder, no recursion. */
function listFinishedClips(folderId) {
  if (!folderId) return null;
  try {
    var out = [];
    var it = DriveApp.getFolderById(folderId).getFiles();
    while (it.hasNext()) {
      var f = it.next();
      if (f.getMimeType().indexOf('video/') !== 0) continue;
      out.push({ fileId: f.getId(), name: f.getName(), size: f.getSize(), url: 'https://drive.google.com/file/d/' + f.getId() + '/view' });
    }
    out.sort(function (a, b) { return a.name.localeCompare(b.name); });
    return out;
  } catch (err) { return null; }
}

var YT_CSV = 'youtube.csv';

/**
 * <show folder>/youtube.csv, written by tools/youtube-sync.mjs:
 *   file_id,filename,performer,youtube_id,youtube_url,title,uploaded_at
 * Keyed on Drive file id so it survives the folder reorganisation. Returns { fileId: youtubeId }.
 */
function readYoutubeCsv(folder) {
  var out = {};
  var it = folder.getFilesByName(YT_CSV);
  if (!it.hasNext()) return out;
  var lines = it.next().getBlob().getDataAsString().split(/\r?\n/);
  for (var i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    var cells = Utilities.parseCsv(lines[i])[0] || [];
    if (cells[0] && cells[3]) out[cells[0]] = cells[3];
  }
  return out;
}

// A folder listing only changes when tools/youtube-sync.mjs runs, so the same answer is good for
// minutes. This is what makes clicking back to a show you already opened instant.
var TAPES_CACHE_SEC = 300;

/**
 * List a show's reviewable tapes.
 *
 * This used to call file.getSharingAccess() once per tape to report an `isPublic` flag. That is a
 * SEPARATE Drive round trip each, run in series — 12-18 of them per show, which was the single
 * biggest cost in the whole app and made picking a show feel broken. The flag bought nothing: its
 * own comment conceded playback had moved to YouTube, and "you can't play this" is already
 * answered, correctly and for free, by youtubeId being null. Every other field here comes back
 * with the listing, so what's left is a couple of calls rather than a couple of dozen.
 */
function listTapes(body) {
  var cache = CacheService.getScriptCache();
  var key = 'tapes:' + body.folderId + ':' + (body.tapesFolderId || '');
  if (!body.refresh) {
    var cached = cache.get(key);
    if (cached) return JSON.parse(cached);
  }

  var show = DriveApp.getFolderById(body.folderId);
  var youtube = readYoutubeCsv(show);
  var root = resolveTapesRoot(show, body.tapesFolderId || null);
  var found = collectVideos(root.folder, 0, []);
  var tapes = [];
  for (var i = 0; i < found.length; i++) {
    var f = found[i].file;
    tapes.push({
      fileId: f.getId(),
      name: found[i].name,
      folderName: found[i].folderName,
      size: f.getSize(),
      // Unlisted YouTube id for this tape, from <show folder>/youtube.csv (tools/youtube-sync.mjs),
      // or null until the nightly sync has uploaded it.
      youtubeId: youtube[f.getId()] || null
    });
  }
  tapes.sort(function (a, b) { return a.name.localeCompare(b.name); });

  var out = {
    ok: true,
    tapes: tapes,
    // The show's finished clips (completed_clips/), so the page can offer "your finished clips"
    // even where nobody pasted the link into the sheet. null = folder not pinned or unreadable.
    finishedClips: listFinishedClips(body.completedClipsFolderId || null),
    // Surfaced so the UI can warn when a show hasn't been reorganised yet ("showFolder" mode).
    tapesRoot: { id: root.folder.getId(), name: root.folder.getName(), mode: root.mode }
  };
  // Cache entries are capped at 100KB; a show's worth of tapes is a few KB, but skip rather than
  // throw if one ever grows past it.
  var encoded = JSON.stringify(out);
  if (encoded.length < 90000) {
    try { cache.put(key, encoded, TAPES_CACHE_SEC); } catch (err) { /* cache is best-effort */ }
  }
  return out;
}

// ---------------------------------------------------------------- sheet plumbing --

/**
 * Resolve this show's request sheet.
 *
 * Order matters:
 *   1. An explicit sheetId from the client manifest — the only reliable answer. NYTW's real
 *      sheet lives in a `Set Tapes` SUBfolder, so folder-scanning alone would miss it and
 *      `createIfMissing` would helpfully create a SECOND sheet that the editing team never reads.
 *   2. A spreadsheet whose name mentions "request", searched in the folder and one level down.
 *      Names vary in the wild: "... Tape Requests" and "July 2026 Clip Requests".
 *   3. Create one — but only if asked to.
 *
 * Deliberately NOT step 4: "any spreadsheet in the folder". Show folders also hold run-of-show
 * and settlement sheets, and adopting one of those would write clip rows into the wrong document.
 */
function getShowSheet(folderId, showLabel, createIfMissing, sheetId, tapesFolderId) {
  if (sheetId) {
    try { return SpreadsheetApp.openById(sheetId); }
    catch (err) { throw new Error('Configured sheetId ' + sheetId + ' could not be opened: ' + err); }
  }

  var folder = DriveApp.getFolderById(folderId);
  var found = findRequestSheet(folder, 0);
  if (found) return SpreadsheetApp.openById(found.getId());

  if (!createIfMissing) return null;
  // A1 "tapes are here" should point at the TAPES folder, not the show folder.
  var tapesRootId = resolveTapesRoot(folder, tapesFolderId || null).folder.getId();
  return createShowSheet(folder, showLabel, tapesRootId);
}

function findRequestSheet(folder, depth) {
  var it = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  while (it.hasNext()) {
    var f = it.next();
    if (/request/i.test(f.getName())) return f;
  }
  if (depth >= MAX_DEPTH) return null;
  var subs = folder.getFolders();
  while (subs.hasNext()) {
    var hit = findRequestSheet(subs.next(), depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * Pick the tab holding the A-G layout, rather than assuming tab 1 — a leading "Instructions"
 * tab would otherwise send every read and write to the wrong sheet.
 */
function requestTab(ss) {
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var a = String(sheets[i].getRange(HEADER_ROW, 1).getDisplayValue()).trim();
    var b = String(sheets[i].getRange(HEADER_ROW, 2).getDisplayValue()).trim();
    if (a === HUMAN_HEADERS[0] && b === HUMAN_HEADERS[1]) return sheets[i];
  }
  return sheets[0];
}

/**
 * Build a fresh sheet rather than copying February's.
 * Copying carries over two defects found in the live data: February's A1 "tapes are here"
 * hyperlink points at NYTW's "Set Tapes" folder (wrong show), and its F5 holds a stray
 * United-Airlines logo link behind unrelated prose.
 */
function createShowSheet(folder, showLabel, tapesRootId) {
  var ss = SpreadsheetApp.create(showLabel + ' Tape Requests');
  var sheet = ss.getSheets()[0];

  sheet.getRange(1, 1, 1, PREAMBLE_1.length).setValues([PREAMBLE_1]);
  sheet.getRange(2, 1, 1, PREAMBLE_2.length).setValues([PREAMBLE_2]);
  sheet.getRange(1, 1).setRichTextValue(
    SpreadsheetApp.newRichTextValue()
      .setText('tapes are here')
      .setLinkUrl('https://drive.google.com/drive/folders/' + (tapesRootId || folder.getId()))
      .build()
  );

  sheet.getRange(HEADER_ROW, 1, 1, HUMAN_HEADERS.length).setValues([HUMAN_HEADERS]);
  sheet.getRange(HEADER_ROW, COL.CLIP_ID, 1, MACHINE_HEADERS.length).setValues([MACHINE_HEADERS]);
  sheet.getRange(HEADER_ROW, LINK_COL).setValue(LINK_HEADER);
  sheet.getRange(HEADER_ROW, 1, 1, LINK_COL).setFontWeight('bold');
  sheet.getRange(4, LINK_COL, sheet.getMaxRows() - 3, 1).setNumberFormat('@');

  // Timestamps must stay text. Sheets otherwise reads "1:53" as a duration and stores a
  // serial, so a later read gets 0.0784... instead of the string a human typed.
  sheet.getRange(4, COL.START, sheet.getMaxRows() - 3, 3).setNumberFormat('@');
  sheet.getRange(4, 1, 1, SAMPLE_ROW.length).setValues([SAMPLE_ROW]);

  sheet.setColumnWidth(COL.NAME, 140);
  sheet.setColumnWidth(COL.NOTES, 320);
  sheet.setFrozenRows(HEADER_ROW);
  sheet.getRange(HEADER_ROW, COL.CLIP_ID, sheet.getMaxRows() - HEADER_ROW + 1, 5)
    .setFontColor('#999999');

  // Park it in the show folder instead of My Drive root.
  DriveApp.getFileById(ss.getId()).moveTo(folder);
  return ss;
}

/**
 * Add H-L headers to a pre-existing sheet without touching existing data.
 * Only ever called from the WRITE path, and only after assertHumanLayout has confirmed A-G.
 * Calling it on a read would mean opening a tape mutates the editing team's spreadsheet.
 *
 * The grid is widened FIRST: a sheet trimmed to fewer than 12 columns would otherwise throw
 * "coordinates or dimensions of the range are invalid" on the read below, before the widen ran.
 */
function ensureMachineHeaders(sheet) {
  if (sheet.getMaxColumns() < LAST_COL) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), LAST_COL - sheet.getMaxColumns());
  }
  var have = sheet.getRange(HEADER_ROW, COL.CLIP_ID, 1, MACHINE_HEADERS.length).getDisplayValues()[0];
  if (have[0] === MACHINE_HEADERS[0]) return;
  sheet.getRange(HEADER_ROW, COL.CLIP_ID, 1, MACHINE_HEADERS.length).setValues([MACHINE_HEADERS]);
  sheet.getRange(HEADER_ROW, COL.CLIP_ID, sheet.getMaxRows() - HEADER_ROW + 1, MACHINE_HEADERS.length)
    .setFontColor('#999999');
}

/**
 * Make sure M3 carries the "Finished clip" header. Only ever called from a WRITE path. Returns
 * false (and changes nothing) when M3 already holds something else — someone's own column is
 * never overwritten, the app simply won't read links from it.
 */
function ensureLinkHeader(sheet) {
  if (sheet.getMaxColumns() < LINK_COL) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), LINK_COL - sheet.getMaxColumns());
  }
  var have = String(sheet.getRange(HEADER_ROW, LINK_COL).getDisplayValue()).trim();
  if (have === LINK_HEADER) return true;
  if (have) return false;
  sheet.getRange(HEADER_ROW, LINK_COL).setValue(LINK_HEADER).setFontWeight('bold');
  sheet.getRange(FIRST_DATA_ROW, LINK_COL, sheet.getMaxRows() - FIRST_DATA_ROW + 1, 1).setNumberFormat('@');
  return true;
}

/** Does M3 say what we expect? Links are only read from a column that is labelled as ours. */
function hasLinkColumn(sheet) {
  return sheet.getMaxColumns() >= LINK_COL &&
    String(sheet.getRange(HEADER_ROW, LINK_COL).getDisplayValue()).trim() === LINK_HEADER;
}

/**
 * Refuse to write into a sheet whose human layout we don't recognise. Fails closed: if row 3
 * isn't the seven expected headers, something has been re-arranged and no automatic repair is
 * safe. Verified byte-for-byte against the live February and March sheets, original typo
 * ("pic some of your own images") included.
 */
function assertHumanLayout(sheet) {
  var human = sheet.getRange(HEADER_ROW, 1, 1, HUMAN_HEADERS.length).getDisplayValues()[0];
  for (var i = 0; i < HUMAN_HEADERS.length; i++) {
    if (String(human[i]).trim() !== HUMAN_HEADERS[i]) {
      throw new Error('sheet layout unrecognized at header column ' + (i + 1) +
        ' (found "' + human[i] + '", expected "' + HUMAN_HEADERS[i] + '") — repair by hand');
    }
  }
}

// ---------------------------------------------------------------- clips --

function getClips(body) {
  var ss = getShowSheet(body.folderId, body.showLabel, false, body.sheetId);
  if (!ss) return { ok: true, clips: [], sheetUrl: null, sheetExists: false };

  // Read-only path: no ensureMachineHeaders, no formatting, no writes of any kind.
  var sheet = requestTab(ss);
  // An older-format sheet (2024/early 2025: "Name | Timestamp | Quote | Notes") must not be read as
  // if it were the A–G layout — its columns mean different things. Say so instead of showing nothing.
  try { assertHumanLayout(sheet); }
  catch (err) { return { ok: true, clips: [], legacy: [], sheetUrl: ss.getUrl(), sheetExists: true, layoutError: String(err.message || err) }; }
  var last = sheet.getLastRow();
  var clips = [];
  var legacy = [];
  if (last >= FIRST_DATA_ROW) {
    var n = last - FIRST_DATA_ROW + 1;
    // getDisplayValues, not getValues: it returns what the human sees regardless of
    // whether the cell holds text or a coerced time serial.
    var shown = sheet.getRange(FIRST_DATA_ROW, 1, n, LAST_COL).getDisplayValues();
    var rich = sheet.getRange(FIRST_DATA_ROW, COL.LINKS, n, 1).getRichTextValues();
    // Finished-clip links (column M), when the sheet has that column.
    var linkRich = null, linkShown = null;
    if (hasLinkColumn(sheet)) {
      linkRich = sheet.getRange(FIRST_DATA_ROW, LINK_COL, n, 1).getRichTextValues();
      linkShown = sheet.getRange(FIRST_DATA_ROW, LINK_COL, n, 1).getDisplayValues();
    }

    var seen = {};
    var lastLegacyName = '';
    for (var i = 0; i < n; i++) {
      var row = shown[i];
      // A blank row is a separator. But performers routinely write their name once and leave
      // column A blank on their 2nd/3rd request row, so "no name" alone must not drop a row.
      var hasAnything = String(row[COL.NAME - 1]).trim() || String(row[COL.CLIP_ID - 1]).trim() ||
                        String(row[COL.START - 1]).trim() || String(row[COL.END - 1]).trim() ||
                        (linkShown && String(linkShown[i][0]).trim());
      if (!hasAnything) { lastLegacyName = ''; continue; }

      var clipId = String(row[COL.CLIP_ID - 1]).trim();
      var rec = {
        row: FIRST_DATA_ROW + i,
        name: row[COL.NAME - 1],
        start: row[COL.START - 1],
        end: row[COL.END - 1],
        granular: row[COL.GRANULAR - 1],
        notes: row[COL.NOTES - 1],
        links: extractLinks(rich[i][0], row[COL.LINKS - 1]),
        thumb: row[COL.THUMB - 1],
        videoFileId: String(row[COL.VIDEO_ID - 1]).trim(),
        clipLinks: linkRich ? extractLinks(linkRich[i][0], linkShown[i][0]) : []
      };

      if (!clipId) {
        // Inherit the performer name from the row above when this row leaves A blank,
        // so the client can tell whose tape a legacy row belongs to.
        if (rec.name) lastLegacyName = rec.name; else rec.name = lastLegacyName;
        legacy.push(rec);
        continue;
      }

      seen[clipId] = (seen[clipId] || 0) + 1;
      rec.clipId = clipId;
      rec.rev = Number(row[COL.REV - 1] || 0);
      try { rec.ranges = JSON.parse(row[COL.RANGES - 1] || '[]'); }
      catch (err) { rec.ranges = []; rec.parseError = true; }
      clips.push(rec);
    }
    // A pasted duplicate of an app row means two rows share an id. Surface it rather
    // than silently updating whichever one happens to come first.
    for (var k = 0; k < clips.length; k++) {
      if (seen[clips[k].clipId] > 1) clips[k].duplicate = true;
    }
  }

  var wanted = body.videoFileId;
  return {
    ok: true,
    sheetExists: true,
    sheetUrl: ss.getUrl(),
    clips: wanted ? clips.filter(function (c) { return c.videoFileId === wanted; }) : clips,
    // Legacy/human rows are returned for display and playback only — never rewritten.
    legacy: legacy
  };
}

/** Column F holds real cell hyperlinks whose display text is often unrelated prose. */
function extractLinks(richValue, displayText) {
  var urls = [];
  try {
    var runs = richValue.getRuns();
    for (var i = 0; i < runs.length; i++) {
      var u = runs[i].getLinkUrl();
      if (u && urls.indexOf(u) === -1) urls.push(u);
    }
  } catch (err) { /* fall through to text scan */ }
  // Also accept schemeless links. The app writes column F as plain text, and the client
  // happily previews "drive.google.com/file/d/<id>/view" — without this, reloading the tape
  // returns [] and the next save erases the image reference.
  var text = String(displayText || '');
  var m = text.match(/(?:https?:\/\/|www\.|drive\.google\.com|docs\.google\.com|lh\d\.googleusercontent\.com)\S+/gi) || [];
  for (var j = 0; j < m.length; j++) if (urls.indexOf(m[j]) === -1) urls.push(m[j]);
  return urls;
}

function saveClip(body) {
  var ss = getShowSheet(body.folderId, body.showLabel, true, body.sheetId, body.tapesFolderId || null);
  var sheet = requestTab(ss);
  // Validate the human layout BEFORE adding our own columns, so a re-arranged sheet is
  // refused rather than stamped.
  assertHumanLayout(sheet);
  ensureMachineHeaders(sheet);
  ensureLinkHeader(sheet);

  var clip = body.clip || {};
  if (!clip.clipId) return { ok: false, error: 'clip.clipId is required' };
  var ranges = (clip.ranges || []).slice();
  if (!ranges.length) return { ok: false, error: 'a clip needs at least one range' };

  // Sort chronologically. Nothing upstream guarantees order, and noticing a later beat first
  // then adding an earlier one is the natural way to use the tool — unsorted, that writes
  // B=3:15 / C=2:56, an inverted span in the two columns the editors actually cut from.
  ranges.sort(function (a, b) { return a.s - b.s; });

  for (var i = 0; i < ranges.length; i++) {
    if (!(ranges[i].e > ranges[i].s)) {
      return { ok: false, error: 'range ' + (i + 1) + ' ends at or before it starts' };
    }
    if (clip.duration && ranges[i].e > Number(clip.duration) + 1) {
      return { ok: false, error: 'range ' + (i + 1) + ' runs past the end of the tape' };
    }
  }

  // Re-scan for the id inside the lock every time. Never trust a row index carried over
  // from a previous request — a human inserting a row above would make it point elsewhere.
  var found = findRowsByClipId(sheet, clip.clipId);
  if (found.length > 1) {
    return { ok: false, error: 'clip id appears on ' + found.length + ' rows — repair the sheet by hand' };
  }

  var values = renderRow(clip, ranges);
  var targetRow;
  if (found.length === 1) {
    targetRow = found[0];
    var currentRev = Number(sheet.getRange(targetRow, COL.REV).getDisplayValue() || 0);
    if (clip.rev !== undefined && Number(clip.rev) !== currentRev) {
      // Before crying conflict, check whether the row ALREADY holds exactly what is being
      // posted. That happens when the previous attempt committed but its response was lost
      // (Apps Script 302s via script.googleusercontent.com) and the client retried with a
      // now-stale rev. The write is idempotent; the rev check must not un-do that.
      var onRow = String(sheet.getRange(targetRow, COL.RANGES).getDisplayValue() || '');
      if (onRow === JSON.stringify(ranges)) {
        return { ok: true, row: targetRow, rev: currentRev, sheetUrl: ss.getUrl(), alreadyApplied: true };
      }
      return { ok: false, error: 'conflict', conflict: true, currentRev: currentRev };
    }
  } else {
    targetRow = Math.max(sheet.getLastRow() + 1, FIRST_DATA_ROW);
    if (targetRow > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 10);
    // Text format across A-G on rows we create, never on existing ones (re-formatting an
    // existing cell changes what an already-typed value displays as). This covers two things:
    // Sheets coercing "1:53" into a time serial, and a note that begins with "=" being stored
    // as a formula, which renders #NAME? and destroys what the performer wrote.
    sheet.getRange(targetRow, 1, 1, HUMAN_HEADERS.length).setNumberFormat('@');
  }

  var nextRev = (found.length === 1 ? Number(sheet.getRange(targetRow, COL.REV).getDisplayValue() || 0) : 0) + 1;
  // One atomic write of the whole row, so the human columns and the machine columns can
  // never disagree because only half of a two-range update landed.
  sheet.getRange(targetRow, 1, 1, LAST_COL).setValues([
    values.concat([clip.clipId, JSON.stringify(ranges), nextRev, clip.videoFileId || '', new Date().toISOString()])
  ]);
  SpreadsheetApp.flush();

  return { ok: true, row: targetRow, rev: nextRev, sheetUrl: ss.getUrl() };
}

function deleteClip(body) {
  var ss = getShowSheet(body.folderId, body.showLabel, false, body.sheetId);
  if (!ss) return { ok: false, error: 'no sheet for this show' };
  var sheet = requestTab(ss);
  assertHumanLayout(sheet);

  var found = findRowsByClipId(sheet, body.clipId);
  if (!found.length) return { ok: true, alreadyGone: true };
  if (found.length > 1) return { ok: false, error: 'clip id appears on multiple rows — repair by hand' };
  sheet.deleteRow(found[0]);
  SpreadsheetApp.flush();
  return { ok: true };
}

function findRowsByClipId(sheet, clipId) {
  var last = sheet.getLastRow();
  if (last < FIRST_DATA_ROW) return [];
  var ids = sheet.getRange(FIRST_DATA_ROW, COL.CLIP_ID, last - FIRST_DATA_ROW + 1, 1).getDisplayValues();
  var rows = [];
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === clipId) rows.push(FIRST_DATA_ROW + i);
  }
  return rows;
}

/** Does this free text contain an actual "m:ss - m:ss" range? */
function hasTimeRange(text) {
  return /\d{1,2}(?::\d{1,2}){0,2}\s*[-\u2013\u2014]\s*\d{1,2}(?::\d{1,2}){0,2}/.test(String(text || ''));
}

/**
 * Render the human-facing A-G cells from the app's structured clip.
 * B/C are the outer span and D enumerates the kept ranges — matching the shape of the sample
 * row the editing team already reads ("1:12'ish | 1:53 | 1:12 - 1:19, 1:21 - 1:27").
 *
 * `ranges` must already be sorted; the caller does that.
 */
function renderRow(clip, ranges) {
  var granular;
  if (ranges.length > 1) {
    granular = ranges.map(function (r) { return fmt(r.s) + ' - ' + fmt(r.e); }).join(', ');
  } else if (hasTimeRange(clip.granular)) {
    // The incoming granular came from a PREVIOUS multi-range render of this same clip and is
    // now stale. Keeping it would tell the editor to cut a segment the performer just deleted.
    granular = '';
  } else {
    // Free-text advice with no timestamps ("cut pauses") is the performer's, so preserve it.
    granular = clip.granular || '';
  }

  return [
    clip.name || '',
    fmt(ranges[0].s),
    fmt(ranges[ranges.length - 1].e),
    granular,
    clip.notes || '',
    (clip.links || []).join('\n'),
    clip.thumb || ''
  ];
}

/** Whole-second m:ss, the format already in the sheets. Sub-second precision lives in ranges_json. */
function fmt(seconds) {
  var total = Math.round(Number(seconds) || 0);
  var m = Math.floor(total / 60);
  var s = total % 60;
  return m + ':' + (s < 10 ? '0' + s : String(s));
}


// ---------------------------------------------------------------- upload portal --
//
// The videographer-facing half. Deliberately behind its OWN secret (UPLOAD_KEY) rather than the
// performer passphrase, for two reasons that only became clear after auditing what the passphrase
// already reaches:
//
//   1. Least privilege. A videographer needs to create one show folder and file a submission. They
//      have no business reading any performer's clip requests, and UPLOAD_KEY cannot.
//   2. Blast radius. This endpoint is anonymous-access and executes with the owner's full Drive
//      rights, and these actions CREATE things. Handing that to the same phrase that is already
//      shared with every performer would mean one leak costs both. Rotating one property now
//      revokes upload access without disturbing review access.
//
// Everything here is additive: create a folder, create a sheet, write a submission file. There is
// no delete, move, rename or share path, and assertUnderMediaRoot keeps all of it inside
// NSDS/Media no matter what the caller sends.

/**
 * The show list the portal needs, and nothing else.
 *
 * The portal has to know which shows exist — to offer them, and to stop a videographer creating a
 * second "October 2025 (NYC)" beside the one already there. It does NOT need sheet ids, clip
 * folders or tape counts, so this projects listShows down to names and ids. Least privilege is
 * the whole reason UPLOAD_KEY exists; handing it the full record would undo that.
 *
 * Doubles as the key check for the gate, the same way listShows does for the review page.
 */
function uploadShows(body) {
  var full = listShows(body);
  return {
    ok: true,
    shows: (full.shows || []).map(function (s) {
      return {
        folderId: s.folderId, name: s.name, label: s.label,
        month: s.month, year: s.year, city: s.city,
        tapesFolderId: s.tapesFolderId
      };
    })
  };
}

/** The name the portal asks for, from its parts. Inverse of SHOW_FOLDER_RE; mirrors shows.js. */
function showFolderNameGs(month, year, city) {
  var name = MONTHS[Number(month) - 1];
  if (!name || !year) return null;
  var label = name.charAt(0).toUpperCase() + name.slice(1) + ' ' + year;
  var trimmed = String(city || '').trim();
  return trimmed ? label + ' (' + trimmed + ')' : label;
}

/**
 * Refuse to touch anything that is not inside NSDS/Media.
 *
 * A caller-supplied folder id is a pointer we then act on with the owner's whole Drive. Being
 * well-formed is not the same as being ours, so walk the parent chain and require the media root
 * to be on it. Bounded depth: Drive parents terminate, but a malformed graph must not spin.
 */
function assertUnderMediaRoot(folderId) {
  var id = String(folderId || '');
  if (!id) throw new Error('folderId is required');
  if (id === MEDIA_ROOT_ID) return true;
  var seen = {};
  for (var hop = 0; hop < 12; hop++) {
    if (seen[id]) break;
    seen[id] = true;
    var parents;
    try { parents = Drive.Files.get(id, { fields: 'parents' }).parents || []; }
    catch (err) { throw new Error('folder ' + id + ' is not readable'); }
    if (!parents.length) break;
    if (parents.indexOf(MEDIA_ROOT_ID) !== -1) return true;
    id = parents[0];
  }
  throw new Error('folder ' + folderId + ' is outside NSDS/Media — refusing');
}

/**
 * Trimmed on BOTH sides. The key is a 48-character hex string that a human pastes — into the gate,
 * or into a text field in Project Settings — so a trailing newline or space on either end is a
 * likelier failure than a genuinely wrong key, and an exact comparison turns that into an
 * indistinguishable "upload key required". Whitespace carries no entropy, so trimming costs
 * nothing and removes a whole class of "the passcode isn't working".
 */
function checkUpload(body) {
  var key = String(PropertiesService.getScriptProperties().getProperty('UPLOAD_KEY') || '').trim();
  return !!key && String(body.uploadKey || '').trim() === key;
}

/** Is the property set at all? Lets the gate say which of the two problems it is. */
function uploadConfigured() {
  return !!String(PropertiesService.getScriptProperties().getProperty('UPLOAD_KEY') || '').trim();
}

/** `_uploads`, a sibling of the year folders. Its id is remembered so a partial listing can
 *  never conclude "no such folder" and create a second one. */
function uploadsFolder() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('UPLOADS_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (err) { /* recreate below */ } }
  var root = DriveApp.getFolderById(MEDIA_ROOT_ID);
  var it = root.getFoldersByName('_uploads');
  var folder = it.hasNext() ? it.next() : root.createFolder('_uploads');
  props.setProperty('UPLOADS_FOLDER_ID', folder.getId());
  return folder;
}

function childFolderByName(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : null;
}

function ensureChildFolder(parent, name) {
  return childFolderByName(parent, name) || parent.createFolder(name);
}

var UPLOAD_BUCKETS = ['tapes', 'photos', 'extras'];

/**
 * Validate the manifest the videographer confirmed.
 *
 * The client proposes every destination and the human can edit them, so this is the point where
 * none of that is trusted any more. A duplicate destination is refused rather than silently
 * numbered: two sources landing on one name means one master overwrites the other with nothing in
 * any log to say so.
 */
function assertManifest(manifest) {
  if (!manifest || !manifest.length) throw new Error('manifest is empty');
  var seen = {};
  var tapes = 0;
  for (var i = 0; i < manifest.length; i++) {
    var row = manifest[i] || {};
    var dest = String(row.dest || '');
    if (!row.src) throw new Error('manifest row ' + i + ' has no src');
    if (!dest) throw new Error('manifest row ' + i + ' has no dest');
    if (dest.indexOf('..') !== -1) throw new Error('manifest row ' + i + ' escapes its folder');
    var bucket = dest.split('/')[0];
    if (UPLOAD_BUCKETS.indexOf(bucket) === -1) {
      throw new Error('manifest row ' + i + ' targets "' + bucket + '"; allowed: ' + UPLOAD_BUCKETS.join(', '));
    }
    if (bucket === 'tapes') tapes++;
    if (seen[dest]) throw new Error('two files both land on ' + dest);
    seen[dest] = true;
  }
  if (!tapes) throw new Error('no video files — nothing would be reviewable');
}

/**
 * Create (or adopt) a show folder, give it the standard request sheet, and file the submission.
 *
 * Idempotent on purpose. The portal mints submissionKey in the browser before sending, exactly as
 * it mints clipId, so the two automatic retries in the client and a double-click cannot produce
 * two Drive folders and two multi-hour transfers.
 */
function uploadCreateShow(body) {
  var year = Number(body.year);
  if (!(year >= 2020 && year <= 2100)) throw new Error('year ' + body.year + ' is out of range');
  var folderName = showFolderNameGs(body.month, year, body.city);
  if (!folderName) throw new Error('month/year did not make a folder name');
  if (!SHOW_FOLDER_RE.test(folderName)) throw new Error(folderName + ' is not a show folder name');
  if (body.folderName && String(body.folderName) !== folderName) {
    throw new Error('folderName disagrees with month/year/city');
  }
  assertManifest(body.manifest);

  var key = String(body.submissionKey || '');
  if (key.length < 8) throw new Error('submissionKey is required');

  var uploads = uploadsFolder();

  // Already filed? Hand back the same answer rather than building a second copy of everything.
  var existingIt = uploads.getFoldersByName(key);
  if (existingIt.hasNext()) {
    var prior = readSubmission(existingIt.next());
    if (prior) { prior.duplicate = true; return prior; }
  }

  // The year folder must already exist. Creating one is a bigger decision than a show folder and
  // is left to a human — a typo'd year would otherwise quietly start a new archive.
  var root = DriveApp.getFolderById(MEDIA_ROOT_ID);
  var yearFolder = childFolderByName(root, String(year));
  if (!yearFolder) throw new Error('no ' + year + ' folder under NSDS/Media — create it first');

  var show = childFolderByName(yearFolder, folderName);
  var created = false;
  if (!show) { show = yearFolder.createFolder(folderName); created = true; }
  assertUnderMediaRoot(show.getId());

  var buckets = {
    tapes: ensureChildFolder(show, 'tapes'),
    photos: ensureChildFolder(show, 'photos'),
    extras: ensureChildFolder(show, 'extras'),
    completed_clips: ensureChildFolder(show, 'completed_clips')
  };

  var ss = getShowSheet(show.getId(), folderName, true, null, buckets.tapes.getId());

  // What is already there, so the portal can say "11 of your 14 are present at the same size and
  // will be skipped" BEFORE anyone commits to hours of transfer.
  var already = [];
  for (var b = 0; b < UPLOAD_BUCKETS.length; b++) {
    var name = UPLOAD_BUCKETS[b];
    var files = buckets[name].getFiles();
    while (files.hasNext()) {
      var f = files.next();
      already.push({ dest: name + '/' + f.getName(), size: f.getSize() });
    }
  }

  var submissionId = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z-' + key.slice(0, 12);
  var record = {
    ok: true,
    submissionId: submissionId,
    submissionKey: key,
    createdAt: new Date().toISOString(),
    source: { kind: String(body.source || ''), link: String(body.link || '') },
    show: {
      folderId: show.getId(), folderName: folderName, year: year, month: Number(body.month),
      city: String(body.city || '').trim() || null, created: created,
      tapesFolderId: buckets.tapes.getId(), photosFolderId: buckets.photos.getId(),
      extrasFolderId: buckets.extras.getId(), completedClipsFolderId: buckets.completed_clips.getId(),
      sheetId: ss ? ss.getId() : null, sheetUrl: ss ? ss.getUrl() : null
    },
    manifest: body.manifest,
    existing: already,
    status: 'pending'
  };

  // One immutable input file per submission, in its own folder so the worker can add status.json
  // and log.txt beside it without ever writing to this one.
  var dir = uploads.createFolder(key);
  dir.createFile('submission.json', JSON.stringify(record, null, 2), 'application/json');
  return record;
}

function readSubmission(dir) {
  var it = dir.getFilesByName('submission.json');
  if (!it.hasNext()) return null;
  var rec;
  try { rec = JSON.parse(it.next().getBlob().getDataAsString()); } catch (err) { return null; }
  var st = dir.getFilesByName('status.json');
  if (st.hasNext()) {
    try { rec.worker = JSON.parse(st.next().getBlob().getDataAsString()); } catch (err) { /* worker mid-write */ }
  }
  return rec;
}

/** Progress for the portal's own page. Read-only; the worker owns status.json. */
function uploadStatus(body) {
  var uploads = uploadsFolder();
  if (body.submissionKey) {
    var it = uploads.getFoldersByName(String(body.submissionKey));
    if (!it.hasNext()) return { ok: true, found: false };
    var rec = readSubmission(it.next());
    return rec ? { ok: true, found: true, submission: rec } : { ok: true, found: false };
  }
  var out = [];
  var dirs = uploads.getFolders();
  while (dirs.hasNext()) {
    var rec2 = readSubmission(dirs.next());
    if (rec2) {
      out.push({
        submissionId: rec2.submissionId, submissionKey: rec2.submissionKey, createdAt: rec2.createdAt,
        folderName: rec2.show && rec2.show.folderName, status: (rec2.worker && rec2.worker.state) || rec2.status,
        files: (rec2.manifest || []).length
      });
    }
  }
  out.sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
  return { ok: true, submissions: out.slice(0, 25) };
}

// ---------------------------------------------------------------- upload: preview --

var DROPBOX_ENDPOINT = 'https://www.dropbox.com/list_shared_link_folder_entries';
var PREVIEW_MAX_ENTRIES = 600;   // a show is ~130 files; this is a runaway guard, not a limit

/**
 * List what is inside a pasted folder link, so the videographer confirms a real file list rather
 * than trusting that we read the right folder.
 *
 * Returns EVERY entry it saw, with no filtering, plus a hard `complete` boolean. Both matter:
 *
 *   - No filtering, because the client decides destinations and the human edits them. An API that
 *     quietly dropped the photos would make "confirm" a lie.
 *   - `complete` as a boolean rather than a warning string, because a warning is un-checkable and
 *     will eventually be treated as cosmetic. Partial listings are refused outright — silently
 *     transferring a subset of a show is the worst outcome available here.
 */
function uploadPreview(body) {
  var link = String(body.link || '');
  if (!link) throw new Error('link is required');
  if (/^https:\/\/(www\.)?dropbox\.com\/scl\/fo\//.test(link)) return previewDropbox(link);
  var m = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(link) || /[?&]id=([A-Za-z0-9_-]{10,})/.exec(link);
  if (m) return previewDrive(m[1]);
  throw new Error('only Dropbox and Drive folder links can be read');
}

/** A Drive source costs nothing to move later — it is a server-side copy, not a transfer. */
function previewDrive(folderId) {
  var root;
  try { root = DriveApp.getFolderById(folderId); }
  catch (err) { throw new Error('that Drive folder is not shared with this account'); }

  var entries = [];
  walkDrive(root, '', 0, entries);
  return {
    ok: true, source: 'drive', entries: entries,
    fileCount: entries.length, reportedCount: entries.length,
    totalBytes: entries.reduce(function (n, e) { return n + (e.bytes || 0); }, 0),
    complete: true, folderName: root.getName()
  };
}

function walkDrive(folder, prefix, depth, out) {
  var files = folder.getFiles();
  while (files.hasNext()) {
    if (out.length > PREVIEW_MAX_ENTRIES) throw new Error('that folder has more than ' + PREVIEW_MAX_ENTRIES + ' files');
    var f = files.next();
    out.push({ path: prefix + f.getName(), bytes: f.getSize() });
  }
  if (depth >= 2) return;
  var subs = folder.getFolders();
  while (subs.hasNext()) {
    var s = subs.next();
    walkDrive(s, prefix + s.getName() + '/', depth + 1, out);
  }
}

/**
 * Dropbox share folders are listed through the same private endpoint the Dropbox web app uses,
 * because the share page is entirely client-rendered — there is nothing in the HTML to scrape.
 * tools/nsds_fetch.py has done this for a while; three things about it are non-obvious and all
 * three were bugs there first, so they are restated here rather than rediscovered:
 *
 *   1. The `__Host-js_csrf` cookie must be echoed back as BOTH the `t` form field and the
 *      `X-CSRF-Token` header, or the endpoint answers 403.
 *   2. Recursing needs each subfolder's OWN `secure_hash`, parsed out of that entry's href, AND
 *      the sub_path. Passing sub_path against the root hash answers 404.
 *   3. It pages at 30 entries and the parameter is `voucher`. Using the name
 *      `next_request_voucher` silently re-returns page one forever, which once cut 264 files to 92.
 *
 * UrlFetchApp has no cookie jar, so the cookie is pulled out of Set-Cookie and re-sent by hand.
 *
 * Unverified in production: whether Dropbox answers this from a Google datacenter IP at all. If
 * it does not, this returns complete:false with the reason rather than a short list, and the
 * transfer can still be filed and enumerated from a laptop.
 */
function previewDropbox(link) {
  var parsed = /\/scl\/fo\/([^\/]+)\/([^\/?]+)/.exec(link);
  var rlkey = (/[?&]rlkey=([^&]+)/.exec(link) || [])[1];
  if (!parsed || !rlkey) throw new Error('that Dropbox link is missing its rlkey');

  var token = dropboxCsrf(link);
  if (!token) {
    return { ok: true, source: 'dropbox', entries: [], fileCount: 0, totalBytes: 0,
             complete: false, incomplete: { reason: 'Dropbox would not issue a session to the server' } };
  }

  var entries = [];
  var problem = null;

  function listDir(secureHash, subPath) {
    var voucher = null, expected = null, guard = 0;
    while (true) {
      if (++guard > 40) { problem = 'pagination runaway'; return; }
      var form = { t: token, link_key: parsed[1], link_type: 's', secure_hash: secureHash, sub_path: subPath, rlkey: rlkey };
      if (voucher !== null) form.voucher = typeof voucher === 'string' ? voucher : JSON.stringify(voucher);
      var res = UrlFetchApp.fetch(DROPBOX_ENDPOINT, {
        method: 'post', payload: form, muteHttpExceptions: true,
        headers: { 'X-CSRF-Token': token, 'x-requested-with': 'XMLHttpRequest', Cookie: '__Host-js_csrf=' + token }
      });
      if (res.getResponseCode() !== 200) { problem = 'Dropbox answered ' + res.getResponseCode(); return; }
      var j;
      try { j = JSON.parse(res.getContentText()); } catch (e) { problem = 'Dropbox answered with something that is not JSON'; return; }
      if (!j.entries) { problem = 'Dropbox returned no entries for ' + (subPath || '/'); return; }
      if (expected === null) expected = j.total_num_entries;
      for (var i = 0; i < j.entries.length; i++) {
        var e = j.entries[i];
        var path = subPath + '/' + e.filename;
        if (e.is_dir) {
          var hm = /\/scl\/fo\/[^\/]+\/([^\/]+)\//.exec(e.href || '');
          if (!hm) { problem = 'could not read a subfolder link'; return; }
          listDir(hm[1], path);
          if (problem) return;
        } else {
          if (e.bytes === undefined) { problem = 'a file came back with no size'; return; }
          entries.push({ path: path, bytes: e.bytes, href: e.href });
        }
        if (entries.length > PREVIEW_MAX_ENTRIES) { problem = 'more than ' + PREVIEW_MAX_ENTRIES + ' files'; return; }
      }
      if (!j.has_more_entries) {
        // The reconciliation that makes `complete` mean something.
        if (expected !== null && expected !== undefined) {
          var here = 0;
          for (var k = 0; k < entries.length; k++) {
            var rest = entries[k].path.slice(subPath.length + 1);
            if (entries[k].path.indexOf(subPath + '/') === 0 && rest.indexOf('/') === -1) here++;
          }
          // Only counts files; a directory entry is expanded, not stored, so compare loosely.
          if (here > expected) { problem = 'listing disagreed with Dropbox at ' + (subPath || '/'); return; }
        }
        return;
      }
      voucher = j.next_request_voucher;
      if (voucher === null || voucher === undefined) { problem = 'Dropbox said there was more but sent no voucher'; return; }
      Utilities.sleep(250);
    }
  }

  listDir(parsed[2], '');

  if (problem) {
    return { ok: true, source: 'dropbox', entries: [], fileCount: 0, totalBytes: 0,
             complete: false, incomplete: { reason: problem } };
  }
  return {
    ok: true, source: 'dropbox', entries: entries, fileCount: entries.length,
    totalBytes: entries.reduce(function (n, e) { return n + (e.bytes || 0); }, 0),
    complete: true
  };
}

/** GET the share page and lift the CSRF cookie out of Set-Cookie; UrlFetchApp keeps no jar. */
function dropboxCsrf(link) {
  var res = UrlFetchApp.fetch(link, { muteHttpExceptions: true, followRedirects: true });
  var headers = res.getAllHeaders();
  var raw = headers['Set-Cookie'] || headers['set-cookie'] || [];
  var list = Array.isArray(raw) ? raw : [raw];
  for (var i = 0; i < list.length; i++) {
    var m = /__Host-js_csrf=([^;]+)/.exec(String(list[i]));
    if (m) return m[1];
  }
  return null;
}

// ---------------------------------------------------------------- key rotation --
//
// Script properties can only be written from inside the script, so rotating a key means calling
// this endpoint with something it already trusts. A shared secret is the obvious choice and the
// wrong one: lose the secret and you can never rotate it, which is exactly how UPLOAD_KEY ended up
// set to a value nobody had.
//
// So ownership is proved by WRITE ACCESS to the Drive folder this app serves — the same authority
// that could edit Project Settings by hand. The mechanism is a challenge the SERVER names:
//
//   1. rotateChallenge -> the server invents a filename and remembers it.
//   2. The caller CREATES a file with exactly that name in NSDS/Media/_ops/.
//   3. rotateKeys -> the server checks that file exists, rotates, then deletes it.
//
// The server naming the file is the load-bearing part. An earlier version had the CALLER write a
// random nonce and echo its contents back, which proves only that you could READ that file — and
// everything in this Drive is readable by anyone holding the id, so that was a weaker check than
// it looked. Here, satisfying the challenge requires CREATING a file whose name you could not have
// known in advance, and creating requires write access. Read access buys nothing.
//
// Both actions are deliberately unauthenticated. Knowing the challenge name is useless without
// write access, and an outstanding challenge is returned rather than replaced so an anonymous
// caller cannot cancel a rotation in progress by asking for a new one.

var OPS_FOLDER = '_ops';
var ROTATE_WINDOW_MS = 10 * 60 * 1000;
var ROTATE_PROP = 'ROTATE_CHALLENGE';
var ROTATABLE = { password: 'PASSWORD', uploadKey: 'UPLOAD_KEY', adminKey: 'ADMIN_KEY' };

function opsFolder(createIfMissing) {
  var root = DriveApp.getFolderById(MEDIA_ROOT_ID);
  var it = root.getFoldersByName(OPS_FOLDER);
  if (it.hasNext()) return it.next();
  return createIfMissing ? root.createFolder(OPS_FOLDER) : null;
}

/**
 * Issue (or re-issue) the challenge. Returns the filename the caller must create.
 *
 * An unexpired challenge is handed back unchanged rather than replaced: otherwise anyone who can
 * reach this endpoint could invalidate a rotation that is halfway through, just by asking.
 */
function rotateChallenge() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(ROTATE_PROP);
  if (raw) {
    var prior = null;
    try { prior = JSON.parse(raw); } catch (err) { prior = null; }
    if (prior && (Date.now() - prior.issuedAt) < ROTATE_WINDOW_MS) {
      return { ok: true, name: prior.name, reissued: true,
               expiresInSeconds: Math.round((ROTATE_WINDOW_MS - (Date.now() - prior.issuedAt)) / 1000) };
    }
  }
  var bytes = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  var name = 'claim-' + bytes + '.txt';
  props.setProperty(ROTATE_PROP, JSON.stringify({ name: name, issuedAt: Date.now() }));
  opsFolder(true);   // so the caller has somewhere to put it
  return { ok: true, name: name, reissued: false, expiresInSeconds: ROTATE_WINDOW_MS / 1000 };
}

/**
 * Rotate any subset of the three keys, once the challenge file is in place.
 *
 * Refuses to leave a key shorter than 12 characters: a typo that set PASSWORD to "" or "x" would
 * lock every performer out of a page whose only credential is that string.
 */
function rotateKeys(body) {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(ROTATE_PROP);
  if (!raw) throw new Error('no challenge outstanding — call rotateChallenge first');
  var challenge;
  try { challenge = JSON.parse(raw); } catch (err) { throw new Error('the stored challenge is unreadable'); }

  var age = Date.now() - challenge.issuedAt;
  if (age > ROTATE_WINDOW_MS) {
    props.deleteProperty(ROTATE_PROP);
    throw new Error('that challenge expired after ' + (ROTATE_WINDOW_MS / 60000) + ' minutes — start again');
  }

  var folder = opsFolder(false);
  if (!folder) throw new Error('no ' + OPS_FOLDER + ' folder under NSDS/Media');
  var it = folder.getFilesByName(challenge.name);
  if (!it.hasNext()) {
    throw new Error('create ' + OPS_FOLDER + '/' + challenge.name + ' to prove you can write here, then call again');
  }
  var proof = it.next();

  var changed = [];
  for (var field in ROTATABLE) {
    if (!Object.prototype.hasOwnProperty.call(ROTATABLE, field)) continue;
    if (body[field] === undefined || body[field] === null || body[field] === '') continue;
    var value = String(body[field]).trim();
    if (value.length < 12) throw new Error(field + ' must be at least 12 characters');
    props.setProperty(ROTATABLE[field], value);
    changed.push(ROTATABLE[field]);
  }
  if (!changed.length) throw new Error('nothing to set');

  // Single use, both halves: the proof file goes, and so does the challenge.
  proof.setTrashed(true);
  props.deleteProperty(ROTATE_PROP);
  return { ok: true, rotated: changed };
}

/** Which keys are set. No values, ever — this exists so a deploy can say what is configured. */
function keyStatus() {
  var props = PropertiesService.getScriptProperties();
  var out = {};
  for (var field in ROTATABLE) {
    if (!Object.prototype.hasOwnProperty.call(ROTATABLE, field)) continue;
    out[ROTATABLE[field]] = !!String(props.getProperty(ROTATABLE[field]) || '').trim();
  }
  return { ok: true, configured: out };
}

// ---------------------------------------------------------------- admin (migration) --

function checkAdmin(body) {
  var key = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
  return !!key && String(body.adminKey || '') === key;
}

/** Title, tabs, parent, and whether the human header + machine columns are in the expected state. */
function adminSheetInfo(body) {
  var ss = SpreadsheetApp.openById(body.sheetId);
  var sheet = requestTab(ss);
  var file = DriveApp.getFileById(ss.getId());
  var parents = [];
  var it = file.getParents();
  while (it.hasNext()) { var f = it.next(); parents.push({ id: f.getId(), title: f.getName() }); }

  var layoutError = null;
  try { assertHumanLayout(sheet); } catch (err) { layoutError = String(err.message || err); }

  var machine = sheet.getMaxColumns() >= LAST_COL
    ? sheet.getRange(HEADER_ROW, COL.CLIP_ID, 1, MACHINE_HEADERS.length).getDisplayValues()[0]
    : [];
  var machineDataCells = 0;
  if (sheet.getMaxColumns() >= LAST_COL && sheet.getLastRow() >= FIRST_DATA_ROW) {
    var mv = sheet.getRange(FIRST_DATA_ROW, COL.CLIP_ID, sheet.getLastRow() - FIRST_DATA_ROW + 1, MACHINE_HEADERS.length).getDisplayValues();
    for (var r = 0; r < mv.length; r++) for (var c = 0; c < mv[r].length; c++) if (String(mv[r][c]).trim()) machineDataCells++;
  }

  return {
    ok: true,
    sheetId: ss.getId(), title: ss.getName(), url: ss.getUrl(),
    tabs: ss.getSheets().map(function (t) { return t.getName(); }),
    tab: sheet.getName(),
    parents: parents,
    lastRow: sheet.getLastRow(), lastCol: sheet.getLastColumn(), maxCols: sheet.getMaxColumns(),
    humanLayoutOk: !layoutError, layoutError: layoutError,
    machineHeaders: machine, machineHeadersOk: machine[0] === MACHINE_HEADERS[0],
    machineDataCells: machineDataCells,
    a1: sheet.getRange(1, 1).getDisplayValue(),
    a1Link: (function () { try { return sheet.getRange(1, 1).getRichTextValue().getLinkUrl(); } catch (e) { return null; } })()
  };
}

/** Every row as displayed, plus the real hyperlink URLs hiding behind column F's prose. */
function adminReadRows(body) {
  var ss = SpreadsheetApp.openById(body.sheetId);
  var sheet = requestTab(ss);
  var last = sheet.getLastRow();
  // Clamp to the grid: a sheet trimmed to fewer than 12 columns would otherwise throw
  // "coordinates or dimensions of the range are invalid".
  var cols = Math.min(sheet.getMaxColumns(), Math.max(LAST_COL, sheet.getLastColumn()));
  if (!last) return { ok: true, rows: [] };
  var values = sheet.getRange(1, 1, last, cols).getDisplayValues();
  var rich = sheet.getRange(1, COL.LINKS, last, 1).getRichTextValues();
  var rows = [];
  var lastName = '';
  for (var i = 0; i < last; i++) {
    var rowNum = i + 1;
    var v = values[i];
    var kind;
    if (rowNum < HEADER_ROW) kind = 'preamble';
    else if (rowNum === HEADER_ROW) kind = 'header';
    else if (!String(v[COL.NAME - 1]).trim() && !String(v[COL.START - 1]).trim() && !String(v[COL.END - 1]).trim() && !String(v[COL.GRANULAR - 1]).trim()) { kind = 'blank'; lastName = ''; }
    else if (/sample/i.test(String(v[COL.NAME - 1]))) kind = 'sample';
    else if (v.length >= COL.CLIP_ID && String(v[COL.CLIP_ID - 1]).trim()) kind = 'app';
    else kind = 'legacy';
    var name = String(v[COL.NAME - 1]).trim();
    if (kind === 'legacy' || kind === 'app') { if (name) lastName = name; }
    rows.push({ row: rowNum, kind: kind, values: v, links: extractLinks(rich[i][0], v[COL.LINKS - 1]),
                inheritedName: (kind === 'legacy' && !name) ? lastName : null });
  }
  return { ok: true, title: ss.getName(), tab: sheet.getName(), rows: rows };
}

/**
 * Find or create the template sheet for a show. dryRun (default true) reports what would happen.
 * moveToRoot moves a found sheet into the show folder root; fixA1Link rewrites ONLY the A1
 * "tapes are here" hyperlink to the resolved tapes folder. Neither touches rows 3+.
 */
function adminEnsureSheet(body) {
  var dryRun = body.dryRun !== false;
  var showFolder = DriveApp.getFolderById(body.folderId);
  var tapesRootId = resolveTapesRoot(showFolder, body.tapesFolderId || null).folder.getId();
  // createNew: build a fresh canonical sheet even though the show already has one (an old-format
  // sheet that adminImportLegacy will read from). Idempotent on the title.
  if (body.createNew) {
    var title = body.showLabel + ' Tape Requests';
    var dup = showFolder.getFilesByName(title);
    while (dup.hasNext()) {
      var dupFile = dup.next();
      if (dupFile.getMimeType() === MimeType.GOOGLE_SHEETS) {
        return { ok: true, dryRun: dryRun, found: true, alreadyExists: true, sheetId: dupFile.getId(), url: dupFile.getUrl(), title: title, a1LinkTo: tapesRootId };
      }
    }
    if (dryRun) return { ok: true, dryRun: true, found: false, wouldCreate: true, createNew: true, title: title, parentId: body.folderId, a1LinkTo: tapesRootId };
    var fresh = createShowSheet(showFolder, body.showLabel, tapesRootId);
    return { ok: true, dryRun: false, found: false, created: true, sheetId: fresh.getId(), url: fresh.getUrl(), title: fresh.getName(), a1LinkTo: tapesRootId };
  }

  var existing = getShowSheet(body.folderId, body.showLabel, false, body.sheetId || null);

  if (!existing) {
    if (dryRun) return { ok: true, dryRun: true, found: false, wouldCreate: true, title: body.showLabel + ' Tape Requests', parentId: body.folderId, a1LinkTo: tapesRootId };
    var ss = createShowSheet(showFolder, body.showLabel, tapesRootId);
    return { ok: true, dryRun: false, found: false, created: true, sheetId: ss.getId(), url: ss.getUrl(), title: ss.getName(), a1LinkTo: tapesRootId };
  }

  var file = DriveApp.getFileById(existing.getId());
  var parents = [];
  var it = file.getParents();
  while (it.hasNext()) parents.push(it.next().getId());
  var inShowRoot = parents.indexOf(body.folderId) !== -1;
  var sheet = requestTab(existing);
  var a1 = sheet.getRange(1, 1);
  var a1Link = null;
  try { a1Link = a1.getRichTextValue().getLinkUrl(); } catch (e) {}
  var wantLink = 'https://drive.google.com/drive/folders/' + tapesRootId;
  var actions = [];

  if (body.moveToRoot && !inShowRoot) {
    actions.push('moveToRoot');
    if (!dryRun) { file.moveTo(showFolder); inShowRoot = true; }
  }
  // A1 is the "tapes are here" cell of the template. Repair it when it says so (any phrasing that
  // mentions tapes, e.g. "Link to tapes is here") or is empty — never when it names another show's
  // tapes ("SF Tapes Link" on the Tech Week tour sheet, whose SF tapes are not in Drive).
  var a1Text = String(a1.getDisplayValue() || '').trim();
  var a1Fixable = (!a1Text || /tapes/i.test(a1Text)) && !/\bSF\b[\s\S]*\bLA\b|\bLA\b[\s\S]*\bSF\b/.test(a1Text);
  if (body.fixA1Link && a1Fixable && (a1Link || '').indexOf(tapesRootId) === -1) {
    actions.push('fixA1Link');
    if (!dryRun) {
      a1.setRichTextValue(SpreadsheetApp.newRichTextValue().setText(a1Text || 'tapes are here').setLinkUrl(wantLink).build());
      a1Link = wantLink;
    }
  }
  var layoutError = null;
  try { assertHumanLayout(sheet); } catch (err) { layoutError = String(err.message || err); }
  return { ok: true, dryRun: dryRun, found: true, sheetId: existing.getId(), url: existing.getUrl(), title: existing.getName(),
           parents: parents, inShowRoot: inShowRoot, humanLayoutOk: !layoutError, layoutError: layoutError,
           a1Link: a1Link, a1LinkTo: tapesRootId, actions: actions };
}

// One time token; a cell holding two ("3:15 or 5:33", "1:12 - 1:19") is ambiguous and parses to
// null, never to the digits glued together. Keep byte-identical to TIME_TOKEN_RE in clips.js
// (test.mjs asserts it).
var TIME_TOKEN_RE = /\d*:\d{1,2}(?::\d{1,2})?(?:\.\d+)?|\d+(?:\.\d+)?/g;

function parseTimeGs(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return isFinite(input) ? input : null;
  var tokens = String(input).match(TIME_TOKEN_RE) || [];
  if (tokens.length !== 1) return null;
  var parts = tokens[0].split(':').map(function (p) { return p === '' ? 0 : Number(p); });
  for (var i = 0; i < parts.length; i++) if (!isFinite(parts[i])) return null;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function parseGranularGs(text) {
  var raw = String(text || '').trim();
  if (!raw) return { kind: 'empty', ranges: [], raw: raw };
  var re = /(\d{1,2}(?::\d{1,2}){0,2}(?:\.\d+)?)\s*[-–—]\s*(\d{1,2}(?::\d{1,2}){0,2}(?:\.\d+)?)/g;
  var pairs = [], m;
  while ((m = re.exec(raw)) !== null) {
    var a = parseTimeGs(m[1]), b = parseTimeGs(m[2]);
    if (a !== null && b !== null && b > a) pairs.push({ s: a, e: b });
  }
  if (!pairs.length) return { kind: 'advice', ranges: [], raw: raw };
  var subtractive = /\b(remove|cut|drop|skip|delete|omit)\b/i.test(raw);
  return { kind: subtractive ? 'subtractive' : 'additive', ranges: pairs, raw: raw };
}

function subtractRangesGs(spans, cuts) {
  var out = spans.slice();
  for (var i = 0; i < cuts.length; i++) {
    var cut = cuts[i], next = [];
    for (var j = 0; j < out.length; j++) {
      var r = out[j];
      if (cut.e <= r.s || cut.s >= r.e) { next.push(r); continue; }
      if (cut.s > r.s) next.push({ s: r.s, e: Math.min(cut.s, r.e) });
      if (cut.e < r.e) next.push({ s: Math.max(cut.e, r.s), e: r.e });
    }
    out = next;
  }
  return out.filter(function (r) { return r.e > r.s; });
}

/** "Peter" vs "Pete" vs "peter " — same rule as shows.js sameName(). */
function sameNameGs(a, b) {
  var norm = function (x) { return String(x || '').toLowerCase().replace(/[^a-z]/g, ''); };
  var x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return x === y || x.indexOf(y) === 0 || y.indexOf(x) === 0;
}

/**
 * Resolve a performer name to exactly ONE tape, or explain why not — same rule as shows.js
 * uniqueTapeFor(). Exact (letters-only) match beats fuzzy; any tie is "ambiguous", never a guess.
 * Measured on April: "S." fuzzy-matches Simren, SarahB and S., so first-match would be wrong.
 */
function uniqueTapeForGs(name, tapes) {
  var norm = function (x) { return String(x || '').toLowerCase().replace(/[^a-z]/g, ''); };
  var n = norm(name);
  if (!n) return { tape: null, why: 'no name' };
  var exact = tapes.filter(function (t) { return norm(t.performer) === n; });
  if (exact.length === 1) return { tape: exact[0] };
  if (exact.length > 1) return { tape: null, why: 'ambiguous', candidates: exact };
  var fuzzy = tapes.filter(function (t) { return sameNameGs(t.performer, name); });
  if (fuzzy.length === 1) return { tape: fuzzy[0] };
  return { tape: null, why: fuzzy.length ? 'ambiguous' : 'no tape', candidates: fuzzy };
}

/** The ONLY range the admin code may write: H..L of one data row. */
function machineRange(sheet, row) {
  if (COL.CLIP_ID !== 8 || MACHINE_HEADERS.length !== 5) throw new Error('machine column map changed');
  if (row < FIRST_DATA_ROW) throw new Error('refusing to write above the data rows');
  return sheet.getRange(row, COL.CLIP_ID, 1, MACHINE_HEADERS.length);
}

/** What DriveApp actually sees in a folder — including shortcuts, which the tape scan ignores. */
function adminListFolder(body) {
  var folder = DriveApp.getFolderById(body.folderId);
  var folders = [], files = [];
  var fi = folder.getFolders();
  while (fi.hasNext()) { var d = fi.next(); folders.push({ id: d.getId(), name: d.getName(), owner: safeOwner(d) }); }
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    var mime = f.getMimeType();
    var rec = { id: f.getId(), name: f.getName(), mimeType: mime, size: f.getSize(), owner: safeOwner(f) };
    if (mime === 'application/vnd.google-apps.shortcut') {
      rec.isShortcut = true;
      try { rec.targetId = f.getTargetId(); rec.targetMimeType = f.getTargetMimeType(); } catch (e) {}
    }
    files.push(rec);
  }
  return { ok: true, id: folder.getId(), name: folder.getName(), folders: folders, files: files };
}

function safeOwner(x) {
  try { var o = x.getOwner(); return o ? o.getEmail() : null; } catch (e) { return null; }
}

/**
 * Adopt hand-typed rows into app-editable clips by writing ONLY the machine columns H..L.
 * A..G are never touched — and a fingerprint of A..G is taken before and re-read after, so a
 * concurrent human edit trips an error instead of going unnoticed. A row is adopted only when its
 * meaning is unambiguous:
 *   - Start and End parse, End > Start
 *   - D is empty, timestamp-free advice, or removals that all fall inside [Start, End]
 *   - the performer resolves to exactly ONE tape (video_file_id must be set, because getClips
 *     filters app rows by tape — an adopted row without it would be invisible)
 * ADDITIVE sub-ranges in D are refused: re-rendering would re-derive End from D and could shorten it.
 * Rows named like the sample are skipped. Explicit `assignments` [{row, videoFileId}] override the
 * name match for that row but pass every other guard. dryRun (default true) writes nothing.
 *
 * What the performer's first Save will do afterwards: rewrite A..G from the structured clip —
 * canonical m:ss, a subtractive D re-expressed as the kept pieces, F as plain URLs.
 *
 * body: { sheetId, dryRun, tapes: [{ fileId, performer }], assignments?: [{ row, videoFileId }], onlyRows?: [n] }
 */
/**
 * Memoised tape duration from Drive (videoMediaMetadata), so a mis-typed "31:5" cannot be adopted
 * as 31 minutes into an 8-minute tape. null when Drive has no metadata — then only the one-token
 * rule in parseTimeGs applies.
 */
function durationLookup() {
  var durations = {};
  return function (fileId) {
    if (!fileId) return null;
    if (Object.prototype.hasOwnProperty.call(durations, fileId)) return durations[fileId];
    var d = null;
    try {
      var meta = Drive.Files.get(fileId, { fields: 'videoMediaMetadata/durationMillis' });
      var ms = meta && meta.videoMediaMetadata && meta.videoMediaMetadata.durationMillis;
      if (ms) d = Number(ms) / 1000;
    } catch (err) { d = null; }
    durations[fileId] = d;
    return d;
  };
}

function adminAdoptRows(body) {
  var ss = SpreadsheetApp.openById(body.sheetId);
  var sheet = requestTab(ss);
  assertHumanLayout(sheet);
  var dryRun = body.dryRun !== false;
  var tapes = body.tapes || [];
  var assignments = {};
  (body.assignments || []).forEach(function (a) { assignments[Number(a.row)] = String(a.videoFileId); });
  var only = body.onlyRows ? body.onlyRows.map(Number) : null;
  var knownIds = {};
  tapes.forEach(function (t) { knownIds[t.fileId] = true; });
  if (!tapes.length && !Object.keys(assignments).length) return { ok: false, error: 'nothing to match against: pass tapes or assignments' };

  if (!dryRun) ensureMachineHeaders(sheet);

  var tapeDuration = durationLookup();

  var last = sheet.getLastRow();
  var report = [];
  if (last < FIRST_DATA_ROW) return { ok: true, dryRun: dryRun, adopted: 0, report: report };

  var n = last - FIRST_DATA_ROW + 1;
  var cols = Math.min(sheet.getMaxColumns(), Math.max(LAST_COL, sheet.getLastColumn()));
  var rows = sheet.getRange(FIRST_DATA_ROW, 1, n, cols).getDisplayValues();
  var lastName = '';
  var plan = [];

  for (var i = 0; i < n; i++) {
    var row = rows[i];
    var rowNum = FIRST_DATA_ROW + i;
    var name = String(row[COL.NAME - 1]).trim();
    var start = String(row[COL.START - 1]).trim();
    var end = String(row[COL.END - 1]).trim();
    var gran = String(row[COL.GRANULAR - 1]).trim();
    var clipId = cols >= COL.CLIP_ID ? String(row[COL.CLIP_ID - 1] || '').trim() : '';

    if (!name && !start && !end && !gran) { lastName = ''; continue; }
    if (name) lastName = name; else name = lastName;
    if (only && only.indexOf(rowNum) === -1) continue;

    var rec = { row: rowNum, name: name, start: start, end: end, granular: gran, verdict: '', ranges: null, fileId: null };

    if (clipId) { rec.verdict = 'ALREADY-APP-ROW'; report.push(rec); continue; }
    if (/sample/i.test(name)) { rec.verdict = 'SKIP-SAMPLE'; report.push(rec); continue; }

    var s0 = parseTimeGs(start), e0 = parseTimeGs(end);
    var g = parseGranularGs(gran);
    var ranges;
    if (!start && !end && g.kind === 'additive') {
      // B and C blank, D lists the pieces ("1:29 - 1:36, 1:38 - 1:44"): the ranges ARE the clip.
      // Every time in D must belong to a pair, and the pairs must not overlap.
      var toks = gran.match(TIME_TOKEN_RE) || [];
      if (toks.length !== g.ranges.length * 2) { rec.verdict = 'SKIP-UNPARSEABLE'; rec.why = 'times outside the ranges in D'; report.push(rec); continue; }
      ranges = g.ranges.slice().sort(function (a, b) { return a.s - b.s; });
      var overlaps = false;
      for (var k = 1; k < ranges.length; k++) if (ranges[k].s < ranges[k - 1].e) overlaps = true;
      if (overlaps) { rec.verdict = 'SKIP-UNPARSEABLE'; rec.why = 'overlapping ranges in D'; report.push(rec); continue; }
    } else {
      if (s0 === null || e0 === null) { rec.verdict = 'SKIP-UNPARSEABLE'; rec.why = 'start/end'; report.push(rec); continue; }
      if (e0 <= s0) { rec.verdict = 'SKIP-UNPARSEABLE'; rec.why = 'end <= start'; report.push(rec); continue; }
      if (g.kind === 'empty' || g.kind === 'advice') {
        ranges = [{ s: s0, e: e0 }];
      } else if (g.kind === 'subtractive') {
        var inside = g.ranges.every(function (c) { return c.s >= s0 && c.e <= e0; });
        if (!inside) { rec.verdict = 'SKIP-UNPARSEABLE'; rec.why = 'cut outside span'; report.push(rec); continue; }
        ranges = subtractRangesGs([{ s: s0, e: e0 }], g.ranges);
      } else {
        // B/C give a span AND D lists ranges: is D a keep-list or extra clips? Not ours to guess.
        rec.verdict = 'SKIP-ADDITIVE'; report.push(rec); continue;
      }
      if (!ranges.length) { rec.verdict = 'SKIP-UNPARSEABLE'; rec.why = 'cuts consumed the whole span'; report.push(rec); continue; }
    }
    rec.ranges = ranges;

    var fileId = null;
    if (assignments[rowNum]) {
      if (!knownIds[assignments[rowNum]]) { rec.verdict = 'SKIP-UNKNOWN-TAPE'; report.push(rec); continue; }
      fileId = assignments[rowNum];
    } else {
      var res = uniqueTapeForGs(name, tapes);
      if (!res.tape) {
        rec.verdict = res.why === 'ambiguous' ? 'SKIP-AMBIGUOUS' : 'SKIP-NO-TAPE';
        if (res.candidates) rec.candidates = res.candidates.map(function (t) { return t.performer; });
        report.push(rec); continue;
      }
      fileId = res.tape.fileId;
    }
    var dur = tapeDuration(fileId);
    rec.tapeDuration = dur;
    var spanEnd = ranges[ranges.length - 1].e;
    if (dur !== null && spanEnd > dur + 1) {
      rec.verdict = 'SKIP-OUT-OF-RANGE';
      rec.why = 'end ' + spanEnd + 's is past the end of the tape (' + Math.round(dur) + 's)';
      report.push(rec); continue;
    }
    rec.verdict = 'ADOPT';
    rec.fileId = fileId;
    report.push(rec);
    plan.push({ rec: rec, humanBefore: row.slice(0, HUMAN_HEADERS.length) });
  }

  if (dryRun || !plan.length) return { ok: true, dryRun: dryRun, adopted: 0, report: report, sheetUrl: ss.getUrl() };

  for (var k = 0; k < plan.length; k++) {
    var r = plan[k].rec;
    r.clipId = Utilities.getUuid();
    machineRange(sheet, r.row).setValues([[r.clipId, JSON.stringify(r.ranges), 1, r.fileId, new Date().toISOString()]]);
  }
  SpreadsheetApp.flush();

  // Tripwire: A..G must be byte-identical to what we planned against.
  var changed = [];
  for (var q = 0; q < plan.length; q++) {
    var after = sheet.getRange(plan[q].rec.row, 1, 1, HUMAN_HEADERS.length).getDisplayValues()[0];
    if (JSON.stringify(after) !== JSON.stringify(plan[q].humanBefore)) changed.push(plan[q].rec.row);
  }
  if (changed.length) return { ok: false, error: 'human columns changed during adopt', rows: changed, adopted: plan.length, report: report };
  return { ok: true, dryRun: false, adopted: plan.length, report: report, sheetUrl: ss.getUrl() };
}



/**
 * Backfill finished-clip links (column M) from the master clip tracker.
 *   links:   [{ row, expectName, urls: [] }]  — write M on an EXISTING row. The row's column A must
 *            equal expectName and M must be empty (or already hold exactly these urls); anything
 *            else is reported and skipped. A–L are never touched.
 *   newRows: [{ name, notes, urls: [] }]     — finished clips with no request row: appended as
 *            hand-typed rows (A, E, M only; no clip id, so the app shows them read-only).
 * dryRun (default true) reports the plan and writes nothing.
 */
function adminSetClipLinks(body) {
  var ss = SpreadsheetApp.openById(body.sheetId);
  var sheet = requestTab(ss);
  assertHumanLayout(sheet);
  var dryRun = body.dryRun !== false;
  var report = [];
  var links = body.links || [];
  var newRows = body.newRows || [];
  if (!dryRun && !ensureLinkHeader(sheet)) return { ok: false, error: 'M3 holds something other than "' + LINK_HEADER + '" — not writing links' };
  var lastRow = sheet.getLastRow();
  var names = lastRow >= FIRST_DATA_ROW ? sheet.getRange(FIRST_DATA_ROW, 1, lastRow - FIRST_DATA_ROW + 1, 1).getDisplayValues() : [];
  var current = (lastRow >= FIRST_DATA_ROW && sheet.getMaxColumns() >= LINK_COL)
    ? sheet.getRange(FIRST_DATA_ROW, LINK_COL, lastRow - FIRST_DATA_ROW + 1, 1).getDisplayValues() : [];
  var writes = [];
  for (var i = 0; i < links.length; i++) {
    var l = links[i], row = Number(l.row);
    var rec = { row: row, name: l.expectName, urls: l.urls };
    if (!(row >= FIRST_DATA_ROW && row <= lastRow)) { rec.verdict = 'SKIP-NO-SUCH-ROW'; report.push(rec); continue; }
    var have = String(names[row - FIRST_DATA_ROW][0]).trim();
    if (have !== String(l.expectName || '').trim()) { rec.verdict = 'SKIP-NAME-MISMATCH'; rec.found = have; report.push(rec); continue; }
    var value = (l.urls || []).join('\n');
    var cur = current.length ? String(current[row - FIRST_DATA_ROW][0]).trim() : '';
    if (cur && cur !== value) { rec.verdict = 'SKIP-ALREADY-LINKED'; rec.found = cur; report.push(rec); continue; }
    rec.verdict = cur === value ? 'ALREADY' : 'LINK';
    if (rec.verdict === 'LINK') writes.push({ row: row, value: value });
    report.push(rec);
  }
  var appended = 0;
  if (!dryRun) {
    for (var w = 0; w < writes.length; w++) sheet.getRange(writes[w].row, LINK_COL).setNumberFormat('@').setValue(writes[w].value);
    var at = Math.max(sheet.getLastRow() + 1, FIRST_DATA_ROW);
    for (var k = 0; k < newRows.length; k++) {
      var nr = newRows[k];
      if (at > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 10);
      sheet.getRange(at, 1, 1, LINK_COL).setNumberFormat('@');
      var vals = [nr.name || '', '', '', '', nr.notes || '', '', '', '', '', '', '', '', (nr.urls || []).join('\n')];
      sheet.getRange(at, 1, 1, LINK_COL).setValues([vals]);
      report.push({ row: at, name: nr.name, urls: nr.urls, verdict: 'APPENDED' });
      at++; appended++;
    }
    SpreadsheetApp.flush();
  } else {
    for (var d = 0; d < newRows.length; d++) report.push({ name: newRows[d].name, notes: newRows[d].notes, urls: newRows[d].urls, verdict: 'WOULD-APPEND' });
  }
  return { ok: true, dryRun: dryRun, linked: writes.length, appended: appended, report: report, sheetUrl: ss.getUrl() };
}

// ---------------------------------------------------------------- admin: Drive layout ops --
// Run as the OWNER (nealpareshpatel@gmail.com), so moves work regardless of who else has access.
// Nothing here deletes. Every op returns before/after so the caller can log an undo.

function fileOrFolder(id) {
  try { return { kind: 'folder', obj: DriveApp.getFolderById(id) }; }
  catch (e) { return { kind: 'file', obj: DriveApp.getFileById(id) }; }
}

function parentIds(obj) {
  var out = [], it = obj.getParents();
  while (it.hasNext()) out.push(it.next().getId());
  return out;
}

/** Create a subfolder, or return the existing one with that exact name (idempotent). */
function adminCreateFolder(body) {
  var parent = DriveApp.getFolderById(body.parentId);
  var it = parent.getFoldersByName(body.title);
  if (it.hasNext()) { var f = it.next(); return { ok: true, created: false, id: f.getId(), title: f.getName(), parentId: parent.getId() }; }
  if (body.dryRun) return { ok: true, dryRun: true, wouldCreate: true, title: body.title, parentId: parent.getId() };
  var made = parent.createFolder(body.title);
  return { ok: true, created: true, id: made.getId(), title: made.getName(), parentId: parent.getId() };
}

/** Move a file OR folder into a new parent. Refuses shortcuts (move the target instead). */
function adminMoveFile(body) {
  var t = fileOrFolder(body.fileId);
  if (!body.allowShortcut && t.kind === 'file' && t.obj.getMimeType() === 'application/vnd.google-apps.shortcut') {
    return { ok: false, error: 'refusing to move a shortcut — move its target ' + t.obj.getTargetId() + ' (or pass allowShortcut)' };
  }
  var before = parentIds(t.obj);
  var dest = DriveApp.getFolderById(body.newParentId);
  if (before.indexOf(dest.getId()) !== -1) return { ok: true, moved: false, id: body.fileId, title: t.obj.getName(), parents: before, note: 'already there' };
  if (body.dryRun) return { ok: true, dryRun: true, id: body.fileId, title: t.obj.getName(), from: before, to: dest.getId() };
  t.obj.moveTo(dest);
  return { ok: true, moved: true, id: body.fileId, title: t.obj.getName(), from: before, to: dest.getId() };
}

function adminRenameFile(body) {
  var t = fileOrFolder(body.fileId);
  var before = t.obj.getName();
  if (before === body.title) return { ok: true, renamed: false, id: body.fileId, title: before };
  if (body.dryRun) return { ok: true, dryRun: true, id: body.fileId, from: before, to: body.title };
  t.obj.setName(body.title);
  return { ok: true, renamed: true, id: body.fileId, from: before, to: body.title };
}

/**
 * Create a Drive shortcut to targetId inside parentId (needs the Drive advanced service, enabled
 * in appsscript.json). Idempotent on (parent, title). Used for the "all request sheets in one
 * folder" view without moving anyone's real files.
 */
function adminCreateShortcut(body) {
  var parent = DriveApp.getFolderById(body.parentId);
  var title = body.title || DriveApp.getFileById(body.targetId).getName();
  var it = parent.getFilesByName(title);
  while (it.hasNext()) {
    var f = it.next();
    if (f.getMimeType() === 'application/vnd.google-apps.shortcut') {
      return { ok: true, created: false, id: f.getId(), title: title, targetId: body.targetId };
    }
  }
  if (body.dryRun) return { ok: true, dryRun: true, wouldCreate: true, title: title, targetId: body.targetId, parentId: parent.getId() };
  var made = Drive.Files.create({
    name: title,
    mimeType: 'application/vnd.google-apps.shortcut',
    parents: [parent.getId()],
    shortcutDetails: { targetId: body.targetId }
  });
  return { ok: true, created: true, id: made.id, title: title, targetId: body.targetId, parentId: parent.getId() };
}


/**
 * The 2025 sheets are the seven-column contract minus one cell: G3 is blank instead of
 * "Thumbnail notes". Fill exactly that cell, and only when A3..F3 already match — the one edit
 * that turns a read-only sheet into one the app can write to, touching no performer data.
 */
function adminFixHeader(body) {
  var ss = SpreadsheetApp.openById(body.sheetId);
  var sheet = requestTab(ss);
  var row = sheet.getRange(HEADER_ROW, 1, 1, HUMAN_HEADERS.length).getDisplayValues()[0];
  for (var i = 0; i < HUMAN_HEADERS.length - 1; i++) {
    if (String(row[i]).trim() !== HUMAN_HEADERS[i]) {
      return { ok: false, error: 'A3..F3 do not match the contract at column ' + (i + 1) + ' ("' + row[i] + '") — not a one-cell fix' };
    }
  }
  var g3 = String(row[HUMAN_HEADERS.length - 1]).trim();
  if (g3 === HUMAN_HEADERS[6]) return { ok: true, fixed: false, note: 'already correct' };
  if (g3) return { ok: false, error: 'G3 holds "' + g3 + '" — refusing to overwrite a non-empty header cell' };
  if (body.dryRun !== false) return { ok: true, dryRun: true, wouldSet: { cell: 'G3', value: HUMAN_HEADERS[6] } };
  sheet.getRange(HEADER_ROW, HUMAN_HEADERS.length).setValue(HUMAN_HEADERS[6]);
  return { ok: true, fixed: true, cell: 'G3', value: HUMAN_HEADERS[6], sheetUrl: ss.getUrl() };
}

// ------------------------------------------------------- importing old-format sheets --

/**
 * 2024 and early-2025 request sheets predate the A–G layout: "Name | Timestamp | Quote | Notes",
 * "Your name | Start time | Lines | Notes", "Performer | Starting Time | Ending Time |
 * Notes/Direction". Their header row is wherever the author put it (row 1, 3 or 5), so the
 * header is recognised by wording and the columns are mapped from it — never assumed by position.
 */
var LEGACY_HEADERS = {
  name:  /^(name|yourname|performer|performername)$/,
  range: /^(timestamp|timestamps|timestamprange|prooftimestamp|prooftimestamps)$/,
  start: /^(start|starttime|startingtime|starttimestamp|startingtimestamp)$/,
  end:   /^(end|endtime|endingtime|endtimestamp|endingtimestamp)$/,
  quote: /^(quote|lines|subtitle)/,
  notes: /^notes/
};

function normHeaderGs(s) { return String(s || '').toLowerCase().replace(/[^a-z]/g, ''); }

function detectLegacyLayout(sheet) {
  var scan = Math.min(sheet.getLastRow(), 12);
  var width = Math.min(sheet.getLastColumn(), 10);
  if (!scan || !width) return null;
  var rows = sheet.getRange(1, 1, scan, width).getDisplayValues();
  for (var r = 0; r < rows.length; r++) {
    var cols = {};
    for (var c = 0; c < rows[r].length; c++) {
      var h = normHeaderGs(rows[r][c]);
      if (!h) continue;
      for (var key in LEGACY_HEADERS) {
        if (cols[key] === undefined && LEGACY_HEADERS[key].test(h)) { cols[key] = c + 1; break; }
      }
    }
    if (cols.name === 1 && (cols.range || cols.start)) return { headerRow: r + 1, cols: cols, headers: rows[r] };
  }
  return null;
}

/**
 * The kept segments for one old-format row. A "Timestamp" cell (or a "Start time" cell someone
 * typed ranges into) listing "a - b, c - d" is one clip with several ranges — the same shape the
 * app saves. Every time in the cell must belong to a pair ("3:15 or 5:33" is refused), the pairs
 * must not overlap, and each must run forwards. With no pairs, start and end come from their own
 * columns, one time each.
 */
function parseLegacyRanges(row, cols) {
  var get = function (k) { return cols[k] ? String(row[cols[k] - 1] || '').trim() : ''; };
  var rangeText = get('range') || get('start');
  var g = parseGranularGs(rangeText);
  if (g.ranges.length) {
    var toks = rangeText.match(TIME_TOKEN_RE) || [];
    if (toks.length !== g.ranges.length * 2) return { error: 'times outside the ranges' };
    var ranges = g.ranges.slice().sort(function (a, b) { return a.s - b.s; });
    for (var i = 1; i < ranges.length; i++) if (ranges[i].s < ranges[i - 1].e) return { error: 'overlapping ranges' };
    return { ranges: ranges };
  }
  var s1 = parseTimeGs(get('start') || get('range'));
  var e1 = parseTimeGs(get('end'));
  if (s1 === null && e1 === null) return { error: 'no times' };
  if (s1 === null) return { error: 'no start' };
  if (e1 === null) return { error: 'no end' };
  return e1 > s1 ? { ranges: [{ s: s1, e: e1 }] } : { error: 'end <= start' };
}

function countAppRows(sheet) {
  var last = sheet.getLastRow();
  if (last < FIRST_DATA_ROW || sheet.getMaxColumns() < COL.CLIP_ID) return 0;
  var ids = sheet.getRange(FIRST_DATA_ROW, COL.CLIP_ID, last - FIRST_DATA_ROW + 1, 1).getDisplayValues();
  var n = 0;
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]).trim()) n++;
  return n;
}

/**
 * Copy the parsable rows of an old-format sheet into a canonical sheet as app-owned clips.
 * The source is only ever read. The target must have the A–G layout and (unless body.append)
 * no app rows yet, so a re-run cannot double-import. Rows land in one block after the last used
 * row, written in a single setValues so a row can never be half-imported.
 */
function adminImportLegacy(body) {
  var dryRun = body.dryRun !== false;
  var src = SpreadsheetApp.openById(body.sourceSheetId);
  var srcSheet = body.sourceTab ? src.getSheetByName(body.sourceTab) : src.getSheets()[0];
  if (!srcSheet) return { ok: false, error: 'source tab not found' };
  var tgt = SpreadsheetApp.openById(body.targetSheetId);
  if (tgt.getId() === src.getId()) return { ok: false, error: 'source and target are the same spreadsheet' };
  var layout = detectLegacyLayout(srcSheet);
  if (!layout) return { ok: false, error: 'no header row found in the first 12 rows of the source (need Name/Performer in column A plus a Timestamp or Start column)' };

  var tgtSheet = requestTab(tgt);
  assertHumanLayout(tgtSheet);
  var already = countAppRows(tgtSheet);
  if (already && !body.append) return { ok: false, error: 'target already holds ' + already + ' app rows — pass append to add to it' };

  var tapes = body.tapes || [];
  var knownIds = {};
  tapes.forEach(function (t) { knownIds[t.fileId] = true; });
  var assignments = {};
  (body.assignments || []).forEach(function (a) { assignments[Number(a.row)] = String(a.videoFileId); });
  var defaultFileId = body.defaultFileId || null;
  if (defaultFileId && !knownIds[defaultFileId]) return { ok: false, error: 'defaultFileId is not one of the tapes' };
  var only = body.onlyRows && body.onlyRows.length ? body.onlyRows.map(Number) : null;
  var tapeDuration = durationLookup();

  var report = [], plan = [];
  var first = layout.headerRow + 1;
  var last = srcSheet.getLastRow();
  if (last >= first) {
    var width = Math.min(srcSheet.getLastColumn(), 12);
    var rows = srcSheet.getRange(first, 1, last - first + 1, width).getDisplayValues();
    var lastName = '';
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i], rowNum = first + i;
      var cell = function (k) { return layout.cols[k] ? String(row[layout.cols[k] - 1] || '').trim() : ''; };
      var anything = false;
      for (var c = 0; c < row.length; c++) if (String(row[c]).trim()) { anything = true; break; }
      if (!anything) { lastName = ''; continue; }
      var name = cell('name');
      if (name) lastName = name; else name = lastName;
      if (only && only.indexOf(rowNum) === -1) continue;
      var rec = { row: rowNum, name: name, times: cell('range') || (cell('start') + (cell('end') ? ' → ' + cell('end') : '')), verdict: '', ranges: null, fileId: null };
      if (!name) { rec.verdict = 'SKIP-NO-NAME'; report.push(rec); continue; }
      if (/sample|mcgee/i.test(name)) { rec.verdict = 'SKIP-SAMPLE'; report.push(rec); continue; }
      var t = parseLegacyRanges(row, layout.cols);
      if (t.error) { rec.verdict = 'SKIP-UNPARSEABLE'; rec.why = t.error; report.push(rec); continue; }

      var fileId = null;
      if (assignments[rowNum]) {
        if (!knownIds[assignments[rowNum]]) { rec.verdict = 'SKIP-UNKNOWN-TAPE'; report.push(rec); continue; }
        fileId = assignments[rowNum];
      } else if (defaultFileId) {
        fileId = defaultFileId;
      } else {
        var res = uniqueTapeForGs(name, tapes);
        if (!res.tape) {
          rec.verdict = res.why === 'ambiguous' ? 'SKIP-AMBIGUOUS' : 'SKIP-NO-TAPE';
          if (res.candidates) rec.candidates = res.candidates.map(function (x) { return x.performer; });
          report.push(rec); continue;
        }
        fileId = res.tape.fileId;
      }
      var dur = tapeDuration(fileId);
      rec.tapeDuration = dur;
      var lastEnd = t.ranges[t.ranges.length - 1].e;
      if (dur !== null && lastEnd > dur + 1) {
        rec.verdict = 'SKIP-OUT-OF-RANGE';
        rec.why = 'end ' + lastEnd + 's is past the end of the tape (' + Math.round(dur) + 's)';
        report.push(rec); continue;
      }
      rec.ranges = t.ranges;
      rec.fileId = fileId;
      rec.notes = [cell('quote') ? 'Quote: ' + cell('quote') : '', cell('notes')].filter(function (x) { return x; }).join('\n');
      rec.verdict = 'IMPORT';
      report.push(rec); plan.push(rec);
    }
  }

  var result = { ok: true, dryRun: dryRun, imported: 0, report: report, layout: layout,
                 sourceTitle: src.getName(), sourceTab: srcSheet.getName(), targetUrl: tgt.getUrl() };
  if (dryRun || !plan.length) return result;

  var startRow = Math.max(tgtSheet.getLastRow() + 1, FIRST_DATA_ROW);
  var need = startRow + plan.length - 1;
  if (need > tgtSheet.getMaxRows()) tgtSheet.insertRowsAfter(tgtSheet.getMaxRows(), need - tgtSheet.getMaxRows() + 10);
  // Text format first, so "1:53" stays text and a note starting with "=" is never a formula.
  tgtSheet.getRange(startRow, 1, plan.length, HUMAN_HEADERS.length).setNumberFormat('@');
  var now = new Date().toISOString();
  var values = plan.map(function (rec) {
    rec.clipId = Utilities.getUuid();
    return renderRow({ name: rec.name, notes: rec.notes, granular: '', links: [], thumb: '' }, rec.ranges)
      .concat([rec.clipId, JSON.stringify(rec.ranges), 1, rec.fileId, now]);
  });
  tgtSheet.getRange(startRow, 1, plan.length, LAST_COL).setValues(values);
  SpreadsheetApp.flush();
  plan.forEach(function (rec, i) { rec.targetRow = startRow + i; });
  result.imported = plan.length;
  return result;
}
