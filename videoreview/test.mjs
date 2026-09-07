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
import { SHOWS, getShow, performerName, isExcluded, showLinks, sameName, uniqueTapeFor } from './shows.js'
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

group('April 2026 — the 12 real files')
const apr = getShow('apr2026')
for (const [file, want] of [
  ['DavidS_4-23-26.mp4', 'DavidS'],
  ['Simren_4-23-26.mp4', 'Simren'],
  ['Neal (Top) 4-23-26.mp4', 'Neal (Top)'],
  ['SarahB_4-23-26.mp4', 'SarahB'],
  ['Albberta_4-23-26.mp4', 'Alberta'],          // typo fixed by override
  ['S_4-23-26.mp4', 'S.'],                      // one-letter name disambiguated
  ['Hayden_4-23-26.mp4', 'Hayden'],
  ['James_4-23-26.mp4', 'James'],
  ['Maybr-Intro (4-23-26).mp4', 'Mayberry (intro)'],
]) eq(file, performerName(apr, file), want)
for (const f of ['AI_4-23 SIZZLE.mp4', 'April UPDATE.mp4', 'April2026_HighlightReel_maybern.mp4']) {
  eq(`excluded: ${f}`, isExcluded(apr, f), true)
}

group('Drive "Copy of" prefix is dropped for every show')
eq('Copy of Aakash Set.mp4 (live Mar SF)', performerName(getShow('mar2026sf'), 'Copy of Aakash Set.mp4'), 'Aakash')
eq('Copy of Sponsor Sketch.mp4 (live Mar SF)', performerName(getShow('mar2026sf'), 'Copy of Sponsor Sketch.mp4'), 'Sponsor Sketch')
eq('FullShowTape.mp4 (live Mar 2025 SF)', performerName(getShow('mar2025sf'), 'FullShowTape.mp4'), 'Full show')

group('February "<Name> Set.mp4" and March "<Name>Set.mp4"')
const feb = getShow('feb2026')
const mar = getShow('mar2026nyc')
eq('Peter Set.mp4', performerName(feb, 'Peter Set.mp4'), 'Peter')
eq('Tatiana Set.mp4', performerName(feb, 'Tatiana Set.mp4'), 'Tatiana')
eq('PeteSet.mp4', performerName(mar, 'PeteSet.mp4'), 'Pete')
eq('YanjaaSet.mp4', performerName(mar, 'YanjaaSet.mp4'), 'Yanjaa')
for (const f of ['PeteRequest_Crypto.mp4', 'Neal Hosting A.U (March 2026).mp4', 'Tech Sizzle.mp4']) {
  eq(`excluded: ${f}`, isExcluded(mar, f), true)
}

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

group('manifest sanity')
const ids = SHOWS.map(s => s.id)
eq('unique ids', new Set(ids).size, ids.length)
eq('years plausible', SHOWS.every(s => [2024, 2025, 2026].includes(s.year)), true)
const idOk = v => v === null || v === undefined || /^[\w-]{25,}$/.test(v)
eq('folder ids well-formed', SHOWS.every(s => idOk(s.folderId) && idOk(s.tapesFolderId) && idOk(s.photosFolderId) && idOk(s.completedClipsFolderId) && idOk(s.sheetId)), true)
eq('sub-folders never equal the show folder', SHOWS.every(s => [s.tapesFolderId, s.photosFolderId, s.completedClipsFolderId].every(x => !x || x !== s.folderId)), true)
eq('showLinks with no photos', showLinks({ folderId: 'x'.repeat(28) }).photos, null)
eq('showLinks tapes falls back to show folder', showLinks({ folderId: 'x'.repeat(28) }).tapes, `https://drive.google.com/drive/folders/${'x'.repeat(28)}`)
eq('showLinks legacy sheet', showLinks({ folderId: 'x'.repeat(28), legacySheetId: 'y'.repeat(28) }).legacySheet, `https://docs.google.com/spreadsheets/d/${'y'.repeat(28)}/edit`)
eq('showLinks legacy sheet absent', showLinks({ folderId: 'x'.repeat(28) }).legacySheet, null)
eq('legacy sheet ids well-formed', SHOWS.every(s => idOk(s.legacySheetId)), true)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
