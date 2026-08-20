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

/** Non-set files that live in the tape folders and should never appear as reviewable. */
function isExcludedTape(name) {
  return /sizzle|highlight|update|recap|^tech sizzle/i.test(name);
}

var PROXY_DIR = 'Proxies';
var PROXY_SUFFIX = '__480p.mp4';
var MAX_DEPTH = 2;   // show folder, plus one level of "Set Tapes" / "Footage" / "Sets"

/**
 * Collect video files from a show folder AND its subfolders.
 * Recursion is not optional: measured against live Drive, only April and July keep their
 * tapes at the top level. NYTW's live in `Set Tapes/`, March SF in `Sets/`, May in `Footage/`.
 * A flat listing returns zero tapes for seven of the nine shows.
 */
function collectVideos(folder, depth, out) {
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (f.getMimeType().indexOf('video/') !== 0) continue;
    var name = f.getName();
    if (isExcludedTape(name)) continue;
    out.push({ file: f, name: name, folderName: folder.getName() });
  }
  if (depth >= MAX_DEPTH) return out;
  var subs = folder.getFolders();
  while (subs.hasNext()) {
    var sub = subs.next();
    // Photos and our own generated proxies are not reviewable tapes.
    if (/^(flicks|photos?|proxies|stills)$/i.test(sub.getName())) continue;
    collectVideos(sub, depth + 1, out);
  }
  return out;
}

function listTapes(body) {
  var folder = DriveApp.getFolderById(body.folderId);
  var proxies = listProxies(folder);

  var found = collectVideos(folder, 0, []);
  var tapes = [];
  for (var i = 0; i < found.length; i++) {
    var f = found[i].file;
    var name = found[i].name;
    var base = name.replace(/\.[^.]+$/, '');
    var proxy = proxies[base + PROXY_SUFFIX] || null;

    tapes.push({
      fileId: f.getId(),
      name: name,
      folderName: found[i].folderName,
      size: f.getSize(),
      // One call, not two: getSharingAccess is a full Drive round trip (~0.3-1s) and this
      // loop is already serial.
      isPublic: isAnyoneWithLink(f),
      // The 480p review copy, if tools/make-proxies.mjs has been run for this show.
      // The 4K masters cannot stream: Drive throttles anonymous reads to ~1 MB/s while a
      // 76 Mbps master needs ~9.5 MB/s, so every seek stalls. The proxy is the playable one.
      proxyFileId: proxy ? proxy.id : null,
      proxySize: proxy ? proxy.size : null
    });
  }
  tapes.sort(function (a, b) { return a.name.localeCompare(b.name); });
  return { ok: true, tapes: tapes, proxyCount: Object.keys(proxies).length };
}

/** Proxies live in a `Proxies` subfolder of the show folder. */
function listProxies(folder) {
  var out = {};
  var dirs = folder.getFoldersByName(PROXY_DIR);
  if (!dirs.hasNext()) return out;
  var it = dirs.next().getFiles();
  while (it.hasNext()) {
    var f = it.next();
    out[f.getName()] = { id: f.getId(), size: f.getSize() };
  }
  return out;
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
function getShowSheet(folderId, showLabel, createIfMissing, sheetId) {
  if (sheetId) {
    try { return SpreadsheetApp.openById(sheetId); }
    catch (err) { throw new Error('Configured sheetId ' + sheetId + ' could not be opened: ' + err); }
  }

  var folder = DriveApp.getFolderById(folderId);
  var found = findRequestSheet(folder, 0);
  if (found) return SpreadsheetApp.openById(found.getId());

  if (!createIfMissing) return null;
  return createShowSheet(folder, showLabel);
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
function createShowSheet(folder, showLabel) {
  var ss = SpreadsheetApp.create(showLabel + ' Tape Requests');
  var sheet = ss.getSheets()[0];

  sheet.getRange(1, 1, 1, PREAMBLE_1.length).setValues([PREAMBLE_1]);
  sheet.getRange(2, 1, 1, PREAMBLE_2.length).setValues([PREAMBLE_2]);
  sheet.getRange(1, 1).setRichTextValue(
    SpreadsheetApp.newRichTextValue()
      .setText('tapes are here')
      .setLinkUrl('https://drive.google.com/drive/folders/' + folder.getId())
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
  var ss = getShowSheet(body.folderId, body.showLabel, true, body.sheetId);
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
