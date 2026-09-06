#!/usr/bin/env node
// Zero-dep checks for the pure logic — the parts that can silently corrupt a performer's
// notes. Every fixture here is a real value read out of the live Feb / Mar / Jul sheets or
// the real April tape filenames.
//
//   node videoreview/test.mjs

import {
  parseTime, formatTime, formatTimePrecise, parseGranular, legacyRanges,
  previewRow, playableRanges, validate, totalDuration, newClip, addRange,
} from './clips.js'
import { getShow, performerName, isExcluded } from './shows.js'
import { toImageUrl } from './api.js'

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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
