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
      return json({ ok: false, error: 'unknown admin action: ' + body.action });
    }

    if (!checkPassword(body.password)) {
      var configured = !!PropertiesService.getScriptProperties().getProperty('PASSWORD');
      return json({ ok: false, error: configured
        ? 'bad password'
        : 'backend has no PASSWORD script property set — add it in Project Settings' });
    }

    var action = body.action;
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

function listTapes(body) {
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
      // Not needed for playback (that's YouTube's job), but a tape nobody can open in Drive is
      // usually a sign something went wrong on upload.
      isPublic: isAnyoneWithLink(f),
      // Unlisted YouTube id for this tape, from <show folder>/youtube.csv (tools/youtube-sync.mjs),
      // or null until the nightly sync has uploaded it.
      youtubeId: youtube[f.getId()] || null
    });
  }
  tapes.sort(function (a, b) { return a.name.localeCompare(b.name); });
  return {
    ok: true,
    tapes: tapes,
    // Surfaced so the UI can warn when a show hasn't been reorganised yet ("showFolder" mode).
    tapesRoot: { id: root.folder.getId(), name: root.folder.getName(), mode: root.mode }
  };
}

function isAnyoneWithLink(file) {
  try {
    var access = file.getSharingAccess();
    return access === DriveApp.Access.ANYONE_WITH_LINK || access === DriveApp.Access.ANYONE;
  } catch (err) { return false; }
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
  sheet.getRange(HEADER_ROW, 1, 1, LAST_COL).setFontWeight('bold');

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
  var last = sheet.getLastRow();
  var clips = [];
  var legacy = [];
  if (last >= FIRST_DATA_ROW) {
    var n = last - FIRST_DATA_ROW + 1;
    // getDisplayValues, not getValues: it returns what the human sees regardless of
    // whether the cell holds text or a coerced time serial.
    var shown = sheet.getRange(FIRST_DATA_ROW, 1, n, LAST_COL).getDisplayValues();
    var rich = sheet.getRange(FIRST_DATA_ROW, COL.LINKS, n, 1).getRichTextValues();

    var seen = {};
    var lastLegacyName = '';
    for (var i = 0; i < n; i++) {
      var row = shown[i];
      // A blank row is a separator. But performers routinely write their name once and leave
      // column A blank on their 2nd/3rd request row, so "no name" alone must not drop a row.
      var hasAnything = String(row[COL.NAME - 1]).trim() || String(row[COL.CLIP_ID - 1]).trim() ||
                        String(row[COL.START - 1]).trim() || String(row[COL.END - 1]).trim();
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
        videoFileId: String(row[COL.VIDEO_ID - 1]).trim()
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
  if (body.fixA1Link && /tapes are here/i.test(a1.getDisplayValue()) && (a1Link || '').indexOf(tapesRootId) === -1) {
    actions.push('fixA1Link');
    if (!dryRun) {
      a1.setRichTextValue(SpreadsheetApp.newRichTextValue().setText(a1.getDisplayValue()).setLinkUrl(wantLink).build());
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

  // Tape durations from Drive, so a mis-typed "31:5" cannot be adopted as 31 minutes into an
  // 8-minute tape. Missing metadata means no bound — the one-token rule in parseTimeGs still applies.
  var durations = {};
  function tapeDuration(fileId) {
    if (Object.prototype.hasOwnProperty.call(durations, fileId)) return durations[fileId];
    var d = null;
    try {
      var meta = Drive.Files.get(fileId, { fields: 'videoMediaMetadata/durationMillis' });
      var ms = meta && meta.videoMediaMetadata && meta.videoMediaMetadata.durationMillis;
      if (ms) d = Number(ms) / 1000;
    } catch (err) { d = null; }
    durations[fileId] = d;
    return d;
  }

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
    if (s0 === null || e0 === null) { rec.verdict = 'SKIP-UNPARSEABLE'; rec.why = 'start/end'; report.push(rec); continue; }
    if (e0 <= s0) { rec.verdict = 'SKIP-UNPARSEABLE'; rec.why = 'end <= start'; report.push(rec); continue; }

    var g = parseGranularGs(gran);
    var ranges;
    if (g.kind === 'empty' || g.kind === 'advice') {
      ranges = [{ s: s0, e: e0 }];
    } else if (g.kind === 'subtractive') {
      var inside = g.ranges.every(function (c) { return c.s >= s0 && c.e <= e0; });
      if (!inside) { rec.verdict = 'SKIP-UNPARSEABLE'; rec.why = 'cut outside span'; report.push(rec); continue; }
      ranges = subtractRangesGs([{ s: s0, e: e0 }], g.ranges);
    } else {
      rec.verdict = 'SKIP-ADDITIVE'; report.push(rec); continue;
    }
    if (!ranges.length) { rec.verdict = 'SKIP-UNPARSEABLE'; rec.why = 'cuts consumed the whole span'; report.push(rec); continue; }
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
    if (dur !== null && e0 > dur + 1) {
      rec.verdict = 'SKIP-OUT-OF-RANGE';
      rec.why = 'end ' + e0 + 's is past the end of the tape (' + Math.round(dur) + 's)';
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
