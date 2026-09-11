#!/usr/bin/env node
// Zero-dep checks for the pure logic — the parts that can silently corrupt a performer's
// notes. Every fixture here is a real value read out of the live Feb / Mar / Jul sheets or
// the real April tape filenames.
//
//   node videoreview/test.mjs

import {
  parseTime, TIME_TOKEN_RE, formatTime, formatTimePrecise, parseGranular, legacyRanges,
  previewRow, playableRanges, validate, totalDuration, newClip, addRange,
} from './clips.js'
import {
  performerName, isExcluded, showLinks, showNotes, sameName, uniqueTapeFor, clipBelongsTo, clipTopic,
  parseShowFolderName, sortShows, showsByYear, getShow, matchShowArg, showShortId, showLabel, showTitle,
  SHOW_FOLDER_RE, MEDIA_ROOT_ID,
} from './shows.js'
import { toImageUrl } from './api.js'
import { pickTapes, pickTapesRoot, TAPES_FOLDER_RE, SKIP_FOLDER_RE, EXCLUDED_TAPE_RE, MAX_DEPTH } from './tapes.js'
import { readFileSync } from 'node:fs'

let pass = 0
let fail = 0
const eq = (label, got, want) => {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) { pass++; return }
  fail++
  console.log(`  FAIL ${label}\n         got  ${g}\n         want ${w}`)
}
const group = name => console.log(`\n${name}`)

group('parseTime — including the sloppy values that are really in the sheets')
eq('1:14', parseTime('1:14'), 74)
eq("1:12'ish  (live Feb B4)", parseTime("1:12'ish"), 72)
eq('10:28', parseTime('10:28'), 628)
eq('1:02:03', parseTime('1:02:03'), 3723)
eq('bare seconds', parseTime('72'), 72)
eq('sub-second', parseTime('1:12.5'), 72.5)
eq('empty', parseTime(''), null)
eq('prose (live Jul B6)', parseTime('Data Center Individual Clip'), null)
eq('two times in one cell (live Jul C13 "3:15 or 5:33") -> null, not 5h35m', parseTime('3:15 or 5:33'), null)
eq('two times, prose between (live Oct B23)', parseTime('3:16ish OR 3:34 (see notes)'), null)
eq('a range pasted into a time cell -> null', parseTime('1:12 - 1:19'), null)
eq('leading-colon seconds (live Jul B24)', parseTime(':38'), 38)
eq('bare zero (live Jul B25)', parseTime('0'), 0)
eq('trailing colon salvages the minutes', parseTime('1:'), 1)

group('formatTime')
eq('74', formatTime(74), '1:14')
eq('628', formatTime(628), '10:28')
eq('rounds 158.4', formatTime(158.4), '2:38')
eq('precise', formatTimePrecise(158.44), '2:38.4')

group('column D means three different things in the live data')
eq('additive (all three sheets, D4)',
  parseGranular('1:12 - 1:19, 1:21 - 1:27'),
  { kind: 'additive', ranges: [{ s: 72, e: 79 }, { s: 81, e: 87 }], raw: '1:12 - 1:19, 1:21 - 1:27' })
eq('subtractive "remove" (Feb)', parseGranular('remove 4:23-4:26').kind, 'subtractive')
eq('subtractive "cut" (Mar)', parseGranular('cut 9:45 - 9:52').kind, 'subtractive')
eq('advice, no stamps (Feb)', parseGranular('cut pauses').kind, 'advice')
eq('empty', parseGranular('').kind, 'empty')

group('legacyRanges on real rows')
eq('Peter 3:05-5:13 remove 4:23-4:26',
  legacyRanges({ start: '3:05', end: '5:13', granular: 'remove 4:23-4:26' }),
  [{ s: 185, e: 263 }, { s: 266, e: 313 }])
// The sample row's D is a SUBSET of its span. Widening or truncating it would misdirect the edit.
eq('sample row additive subset',
  legacyRanges({ start: "1:12'ish", end: '1:53', granular: '1:12 - 1:19, 1:21 - 1:27' }),
  [{ s: 72, e: 79 }, { s: 81, e: 87 }])
eq('advice leaves the span intact',
  legacyRanges({ start: '1:59', end: '2:30', granular: 'cut pauses' }),
  [{ s: 119, e: 150 }])
eq('prose in Start Time invents nothing',
  legacyRanges({ start: 'Data Center Individual Clip', end: 'At 1:01 …', granular: '' }), [])

group('one clip, two ranges — the jump-cut story')
const clip2 = { ranges: [{ s: 158.4, e: 176.0 }, { s: 195.2, e: 210.0 }], granular: '', notes: '', links: [], thumb: '' }
eq('renders B/C/D', previewRow(clip2),
  { start: '2:38', end: '3:30', granular: '2:38 - 2:56, 3:15 - 3:30' })
eq('kept time', formatTime(totalDuration(playableRanges(clip2))), '0:32')

group('validate — the duration bound is the cheap safety net')
eq('good clip', validate(clip2, 453.82), null)
eq('inverted', validate({ ranges: [{ s: 100, e: 50 }] }, 453.82), 'The range ends at or before it starts.')
eq('missing end', validate({ ranges: [{ s: 100, e: null }] }, 453.82), 'The range is missing an end time.')
// A Sheets time-serial misread as 60x too large is exactly what this catches.
eq('past end of tape', validate({ ranges: [{ s: 100, e: 13860 }] }, 453.82),
  'The range ends at 231:00, past the end of the tape (7:34).')
eq('names the offending range', validate({ ranges: [{ s: 10, e: 20 }, { s: 30, e: 25 }] }, 453.82),
  'Range 2 ends at or before it starts.')

group('a new clip seeds one range and can grow')
const fresh = newClip({ name: 'DavidS', videoFileId: 'x' })
eq('starts with one range', fresh.ranges.length, 1)
eq('has an id', typeof fresh.clipId === 'string' && fresh.clipId.length > 5, true)
addRange(fresh)
eq('grows', fresh.ranges.length, 2)
eq('incomplete ranges are not playable', playableRanges(fresh).length, 0)

group('tape filenames -> performer (tapes are "<Performer> Set.mp4" everywhere now)')
for (const [file, want] of [
  ['Alberta Set.mp4', 'Alberta'],
  ['S. Set.mp4', 'S.'],
  ['Neal (Top) Set.mp4', 'Neal (Top)'],
  ['DavidS Set.mp4', 'DavidS'],
  ['Full Show.mp4', 'Full Show'],
  ['Sponsor Sketch.mp4', 'Sponsor Sketch'],
  // not-yet-renamed shapes still resolve
  ['DavidS_4-23-26.mp4', 'DavidS'],
  ['Neal (Top) 4-23-26.mp4', 'Neal (Top)'],
  ['Copy of Aakash Set.mp4', 'Aakash'],
  ['PeteSet.mp4', 'Pete'],
  ['Peter Set.mp4', 'Peter'],
  ['AUJan31BetsyFullSet.mp4', 'AUJan31Betsy'],
  ['AustinPROOF.mp4', 'Austin'],
  ['NealP_5-27-26 TOP.mp4', 'NealP (Top)'],
  ['Neal Set & Sponor Plug.mp4', 'Neal'],
  ['FullShowTape.mp4', 'Full Show'],
  ['AU_LATW_MicAudio.mp4', 'Full Show'],
  ['SF_FULL_TAPE.MP4', 'Full Show'],
]) eq(file, performerName(file), want)
for (const f of ['AI_4-23 SIZZLE.mp4', 'April UPDATE.mp4', 'April2026_HighlightReel_maybern.mp4', 'Tech Sizzle.mp4', 'AUFeb2026HighlightV2.mp4']) {
  eq(`excluded: ${f}`, isExcluded(f), true)
}
eq('a set tape is not excluded', isExcluded('Alberta Set.mp4'), false)

group('image links')
eq('Drive share link -> thumbnail endpoint',
  toImageUrl('https://drive.google.com/file/d/1abcDEF_ghi123/view?usp=sharing'),
  'https://drive.google.com/thumbnail?id=1abcDEF_ghi123&sz=w1200')
eq('schemeless Drive link still resolves',
  toImageUrl('drive.google.com/file/d/1abcDEF_ghi123/view'),
  'https://drive.google.com/thumbnail?id=1abcDEF_ghi123&sz=w1200')
eq('plain image url', toImageUrl('https://example.com/logo.png'), 'https://example.com/logo.png')
eq('junk', toImageUrl('not a url'), null)

group('tape discovery — pickTapes on rclone entries relative to the tapes root')
const V = 'video/mp4'
const entries = [
  { Path: 'DavidS_4-23-26.mp4', Name: 'DavidS_4-23-26.mp4', MimeType: V },
  { Path: 'Set Tapes/Ben.mp4', Name: 'Ben.mp4', MimeType: V },
  { Path: 'Footage/DivyaG_5-27-26.mp4', Name: 'DivyaG_5-27-26.mp4', MimeType: V },
  { Path: 'tapes/PeteSet.mp4', Name: 'PeteSet.mp4', MimeType: V },
  { Path: 'Angle B/x.mp4', Name: 'x.mp4', MimeType: V },                       // depth 1 under the root: kept
  { Path: 'Clips/BenClip_DataCenterWater.mp4', Name: 'BenClip_DataCenterWater.mp4', MimeType: V }, // live NYTW
  { Path: 'completed_clips/PeterClip1.mp4', Name: 'PeterClip1.mp4', MimeType: V },
  { Path: 'Completed Clips/x.mp4', Name: 'x.mp4', MimeType: V },
  { Path: 'extras/x.mp4', Name: 'x.mp4', MimeType: V },
  { Path: 'Proxies/DavidS_4-23-26__480p.mp4', Name: 'DavidS_4-23-26__480p.mp4', MimeType: V },
  { Path: 'Flicks/IMG_0001.jpg', Name: 'IMG_0001.jpg', MimeType: 'image/jpeg' },
  { Path: 'photos/x.mp4', Name: 'x.mp4', MimeType: V },
  { Path: 'a/b/c.mp4', Name: 'c.mp4', MimeType: V },                             // depth 2: dropped
  { Path: 'AI_4-23 SIZZLE.mp4', Name: 'AI_4-23 SIZZLE.mp4', MimeType: V },
  { Path: 'Tech Sizzle.mp4', Name: 'Tech Sizzle.mp4', MimeType: V },
  { Path: 'tapes', Name: 'tapes', IsDir: true },
]
eq('keeps only real set tapes',
  pickTapes(entries).map(e => e.Path),
  ['DavidS_4-23-26.mp4', 'Set Tapes/Ben.mp4', 'Footage/DivyaG_5-27-26.mp4', 'tapes/PeteSet.mp4', 'Angle B/x.mp4'])
eq('per-show exclusion applies', pickTapes(entries, n => /^Pete/.test(n)).map(e => e.Name).includes('PeteSet.mp4'), false)

group('tape discovery — pickTapesRoot')
eq('single tapes/ subfolder', pickTapesRoot([{ Name: 'tapes', IsDir: true, ID: 'T' }, { Name: 'photos', IsDir: true, ID: 'P' }]), { id: 'T', mode: 'named' })
eq('legacy "Set Tapes"', pickTapesRoot([{ Name: 'Set Tapes', IsDir: true, ID: 'ST' }]), { id: 'ST', mode: 'named' })
eq('two candidates -> whole show folder', pickTapesRoot([{ Name: 'Sets', IsDir: true, ID: 'A' }, { Name: 'Footage', IsDir: true, ID: 'B' }]), { id: null, mode: 'showFolder' })
eq('nothing -> show folder', pickTapesRoot([]), { id: null, mode: 'showFolder' })
eq('pin wins', pickTapesRoot([{ Name: 'tapes', IsDir: true, ID: 'T' }], 'PINNED'), { id: 'PINNED', mode: 'pinned' })
eq('followed shortcut id -> target', pickTapesRoot([{ Name: 'tapes', IsDir: true, ID: 'target\tshortcut' }]), { id: 'target', mode: 'named' })

group('Code.gs carries the same rule (byte-identical literals)')
const gs = readFileSync(new URL('./apps-script/Code.gs', import.meta.url), 'utf8')
const lit = name => (gs.match(new RegExp(`var ${name}\\s*=\\s*(\\/.*?\\/[a-z]*);`)) || [])[1]
eq('TAPES_FOLDER_RE', lit('TAPES_FOLDER_RE'), String(TAPES_FOLDER_RE))
eq('SKIP_FOLDER_RE', lit('SKIP_FOLDER_RE'), String(SKIP_FOLDER_RE))
eq('EXCLUDED_TAPE_RE', lit('EXCLUDED_TAPE_RE'), String(EXCLUDED_TAPE_RE))
eq('MAX_DEPTH', Number((gs.match(/var MAX_DEPTH = (\d+);/) || [])[1]), MAX_DEPTH)
eq('TIME_TOKEN_RE', lit('TIME_TOKEN_RE'), String(TIME_TOKEN_RE))
eq('parseTimeGs refuses a cell with two tokens', /tokens\.length !== 1\) return null/.test(gs), true)
eq('adminAdoptRows adopts blank B/C with ranges in D', /!start && !end && g\.kind === 'additive'/.test(gs), true)
const adopt = gs.slice(gs.indexOf('function adminAdoptRows'), gs.indexOf('\n}\n', gs.indexOf('function adminAdoptRows')))
eq('adminAdoptRows writes only through machineRange()', (adopt.match(/\.setValues\(/g) || []).length === 1 && /machineRange\(sheet, r\.row\)\.setValues\(/.test(adopt), true)
eq('adminAdoptRows never touches A..G or rows', /setNumberFormat|deleteRow|insertRows|getRange\(rowNum, 1/.test(adopt), false)
eq('adminAdoptRows bounds the span by the tape duration before ADOPT', /SKIP-OUT-OF-RANGE/.test(adopt) && adopt.indexOf('SKIP-OUT-OF-RANGE') < adopt.indexOf("rec.verdict = 'ADOPT'"), true)
const imp = gs.slice(gs.indexOf('function adminImportLegacy'), gs.indexOf('\n}\n', gs.indexOf('function adminImportLegacy')))
eq('adminImportLegacy exists', imp.length > 100, true)
eq('adminImportLegacy never writes to the source sheet', /srcSheet\.(setValue|setValues|setNumberFormat|deleteRow|insertRow|clear|setRichTextValue)/.test(imp), false)
eq('adminImportLegacy writes the target in one block', (imp.match(/\.setValues\(/g) || []).length, 1)
eq('adminImportLegacy refuses a target that already has app rows', /countAppRows\(tgtSheet\)/.test(imp) && /body\.append/.test(imp), true)
eq('adminImportLegacy bounds by tape duration', /SKIP-OUT-OF-RANGE/.test(imp), true)
eq('doPost routes adminImportLegacy under the lock', /adminImportLegacy'\)\s*return json\(withLock/.test(gs), true)
eq('getClips refuses to misread an old-format sheet', /function getClips[\s\S]*?assertHumanLayout\(sheet\)[\s\S]*?layoutError/.test(gs), true)

group('sameName / uniqueTapeFor — April\'s real performer list')
const april = ['DavidS', 'Simren', 'Neal (Top)', 'SarahB', 'Alberta', 'S.', 'Hayden', 'James', 'Mayberry (intro)'].map(p => ({ fileId: 'id-' + p, performer: p }))
eq('Pete ~ Peter', sameName('Pete', 'Peter'), true)
eq('empty never matches', sameName('', 'Peter'), false)
eq('Simren -> Simren (exact beats S.)', uniqueTapeFor('Simren', april).tape?.performer, 'Simren')
eq('S. -> S.', uniqueTapeFor('S.', april).tape?.performer, 'S.')
eq('Sarah -> ambiguous (SarahB, S.)', uniqueTapeFor('Sarah', april).why, 'ambiguous')
eq('David -> DavidS', uniqueTapeFor('David', april).tape?.performer, 'DavidS')
eq('Dave -> no tape', uniqueTapeFor('Dave', april).why, 'no tape')
eq('Neal -> Neal (Top)', uniqueTapeFor('Neal', april).tape?.performer, 'Neal (Top)')
const may = ['Neal3', 'Neal4', 'NealP TOP'].map(p => ({ fileId: p, performer: p }))
eq('Neal vs three Neals -> ambiguous', uniqueTapeFor('Neal', may).why, 'ambiguous')

group('show discovery — folder names are the manifest')
eq('June 2025 (NYC Tech Week)', parseShowFolderName('June 2025 (NYC Tech Week)'), { label: 'June 2025', month: 6, year: 2025, city: 'NYC Tech Week' })
eq('November 2024 (NYC - Immigrant Founders Roast)', parseShowFolderName('November 2024 (NYC - Immigrant Founders Roast)').city, 'NYC - Immigrant Founders Roast')
eq('no city', parseShowFolderName('July 2024'), { label: 'July 2024', month: 7, year: 2024, city: null })
eq('case-insensitive month', parseShowFolderName('march 2026 (SF)').label, 'March 2026')
eq('_deprecated (review) is not a show', parseShowFolderName('_deprecated (review)'), null)
eq('a year folder is not a show', parseShowFolderName('2025'), null)
eq('Photo kit is not a show', parseShowFolderName('Photo kit (select photos)'), null)
const fake = (name, id) => ({ folderId: id, name, ...parseShowFolderName(name), sheetId: null })
const disc = [fake('March 2025 (NYC)', 'A'.repeat(28)), fake('July 2025 (NYC)', 'B'.repeat(28)), fake('March 2025 (SF)', 'C'.repeat(28)), fake('June 2026 (NY Tech Week)', 'D'.repeat(28)), fake('October 2025 (SF + LA Tech Week)', 'E'.repeat(28))]
eq('sortShows newest first', sortShows(disc).map(s => s.name)[0], 'June 2026 (NY Tech Week)')
eq('showsByYear groups', [...showsByYear(disc).keys()], [2026, 2025])
eq('getShow by folder id', getShow(disc, 'B'.repeat(28)).name, 'July 2025 (NYC)')
eq('getShow unknown', getShow(disc, 'nope'), null)
eq('showLabel', showLabel(disc[0]), 'March 2025 · NYC')
eq('showTitle (sheet name)', showTitle(disc[0]), 'March 2025 (NYC)')
eq('showShortId', showShortId(disc[4]), 'oct2025-sflatechweek')
eq('matchShowArg old id jul2025', matchShowArg(disc, 'jul2025').show.name, 'July 2025 (NYC)')
eq('matchShowArg mar2025 is ambiguous', matchShowArg(disc, 'mar2025').why, 'ambiguous')
eq('matchShowArg mar2025sf', matchShowArg(disc, 'mar2025sf').show.name, 'March 2025 (SF)')
eq('matchShowArg mar2026-sf style', matchShowArg(disc, 'mar2025-sf').show.name, 'March 2025 (SF)')
eq('matchShowArg oct2025techweek', matchShowArg(disc, 'oct2025techweek').show.name, 'October 2025 (SF + LA Tech Week)')
eq('matchShowArg jun2026nytw -> substring of city', matchShowArg(disc, 'jun2026nytechweek').show.name, 'June 2026 (NY Tech Week)')
eq('matchShowArg by folder id', matchShowArg(disc, 'C'.repeat(28)).show.name, 'March 2025 (SF)')
eq('matchShowArg by words', matchShowArg(disc, 'tech week 2026').show.name, 'June 2026 (NY Tech Week)')
eq('matchShowArg no match', matchShowArg(disc, 'dec2031').why, 'no match')
eq('showLinks with no photos', showLinks({ folderId: 'x'.repeat(28) }).photos, null)
eq('showLinks tapes falls back to show folder', showLinks({ folderId: 'x'.repeat(28) }).tapes, `https://drive.google.com/drive/folders/${'x'.repeat(28)}`)
eq('showLinks legacy sheet', showLinks({ folderId: 'x'.repeat(28), legacySheetId: 'y'.repeat(28) }).legacySheet, `https://docs.google.com/spreadsheets/d/${'y'.repeat(28)}/edit`)
eq('showLinks legacy sheet absent', showLinks({ folderId: 'x'.repeat(28) }).legacySheet, null)
eq('showNotes: tapes present, nothing to say', showNotes({}, [{ name: 'Alberta Set.mp4' }, { name: 'S. Set.mp4' }]), [])
eq('showNotes: no tapes', showNotes({}, [])[0].startsWith('No set tapes were saved'), true)
eq('showNotes: one full-show tape', showNotes({}, [{ name: 'Full Show.mp4' }])[0].startsWith('One full-show tape'), true)
eq('showNotes: one performer tape is not a full show', showNotes({}, [{ name: 'Brook Set.mp4' }]), [])
eq('showNotes: before tapes load', showNotes({}, null), [])
eq('Code.gs SHOW_FOLDER_RE is byte-identical', lit('SHOW_FOLDER_RE'), String(SHOW_FOLDER_RE))
eq('Code.gs MEDIA_ROOT_ID matches', (gs.match(/var MEDIA_ROOT_ID = '([\w-]+)';/) || [])[1], MEDIA_ROOT_ID)
eq('doPost routes listShows behind the passphrase', /if \(action === 'listShows'\)\s*return json\(listShows\(body\)\)/.test(gs), true)
eq('listShows caches', /CacheService\.getScriptCache\(\)/.test(gs), true)
eq('pickFolder prefers the non-empty duplicate folder', /function pickFolder[\s\S]*?pageSize: 1[\s\S]*?return list\[i\]\.id/.test(gs), true)
eq('listShows is five list calls, not iterators', /function listShows[\s\S]*?driveChildren\(/.test(gs) && !/function listShows[\s\S]*?getFolders\(\)[\s\S]*?function driveChildren/.test(gs), true)

group('renamed tapes: "<Performer> Set.mp4" everywhere, old names still work')
eq('Annette Set.mp4', performerName('Annette Set.mp4'), 'Annette')
eq('Neal (Top) Set.mp4', performerName('Neal (Top) Set.mp4'), 'Neal (Top)')
eq('Full Show.mp4 is not stripped to nothing', performerName('Full Show.mp4'), 'Full Show')
eq('S. Set.mp4', performerName('S. Set.mp4'), 'S.')
eq('Doordash Set.mp4', performerName('Doordash Set.mp4'), 'Doordash')

group('finished clips: which belong to the open tape')
eq('new naming', clipBelongsTo('Kaz Khadem — VC Charity.mp4', 'Kaz'), true)
eq('new naming, other performer', clipBelongsTo('Kaz Khadem — VC Charity.mp4', 'Sarah Barnitt'), false)
eq('old naming KazAUClip1', clipBelongsTo('KazAUClip1.mp4', 'Kaz Khadem'), true)
eq('old naming BenRequest_', clipBelongsTo('BenRequest_MetaMonitoring.mp4', 'Ben'), true)
eq('Neal vs NealP TOP', clipBelongsTo('Neal Patel — Replaced With AI.mp4', 'Neal'), true)
eq('S. never matches Simren\'s clip', clipBelongsTo('Simren — Something.mp4', 'S.'), false)
eq('topic from new name', clipTopic('Kaz Khadem — VC Charity (v2).mp4'), 'VC Charity (v2)')
eq('topic from old name is the stem', clipTopic('KazAUClip1.mp4'), 'KazAUClip1')

group('Code.gs: the Finished clip column stays outside the A–L contract')
eq('LINK_COL is M', /var LINK_COL = 13;/.test(gs), true)
eq('saveClip still writes A–L atomically, never M', /sheet\.getRange\(targetRow, 1, 1, LAST_COL\)\.setValues/.test(gs) && !/getRange\(targetRow, 1, 1, LINK_COL\)/.test(gs), true)
eq('getClips only reads M when M3 is our header', /if \(hasLinkColumn\(sheet\)\) \{[\s\S]*?LINK_COL, n, 1\)\.getRichTextValues/.test(gs), true)
const scl = gs.slice(gs.indexOf('function adminSetClipLinks'), gs.indexOf('// ---------------------------------------------------------------- admin: Drive layout ops --'))
eq('adminSetClipLinks writes existing rows in column M only', (scl.match(/getRange\(writes\[w\]\.row, LINK_COL\)/g) || []).length === 1 && !/getRange\(writes\[w\]\.row, 1/.test(scl), true)
eq('adminSetClipLinks checks the name before linking', /SKIP-NAME-MISMATCH/.test(scl), true)
eq('adminSetClipLinks never overwrites a different link', /SKIP-ALREADY-LINKED/.test(scl), true)
eq('doPost routes adminSetClipLinks under the lock', /adminSetClipLinks'\)\s*return json\(withLock/.test(gs), true)
eq('listTapes returns finished clips', /finishedClips: listFinishedClips\(body\.completedClipsFolderId/.test(gs), true)
eq('no settings UI left in index.html', !/open-settings|gate-settings|id="settings"/.test(readFileSync(new URL('./index.html', import.meta.url), 'utf8')), true)
eq('no filename or GB shown on tape buttons', !/toFixed\(2\)\} GB/.test(readFileSync(new URL('./app.js', import.meta.url), 'utf8')), true)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
