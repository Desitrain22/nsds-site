#!/usr/bin/env node
// Checks for the comedian roster and the rules that file every set tape under one person — the
// parts that decide whether a comedian's library is complete and whether a tape lands on the
// wrong person. The coverage fixtures are the real labels: Drive as scanned on 2026-10-22, and
// whatever data/upload-status.json says right now.
//
//   node videoreview/test-library.mjs

import { normLabel, splitPart, resolveComedian, buildLibrary, searchComedians, formatLength, requestsForTape, ROSTER } from './library.js'
import { parseShowFolderName } from './shows.js'
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
const ok = (label, cond) => eq(label, !!cond, true)
const group = name => console.log(`\n${name}`)

// Every set-tape label in Drive on 2026-10-22, per show (performerName of each file in tapes/).
// Drive moves on, so this is a snapshot — upload-status.json below is the live check.
const DRIVE_LABELS_2026_10_22 = {
  'April 2026 (NYC)': ['Alberta', 'DavidS', 'Hayden', 'James', 'Neal (Top)', 'SarahB', 'Shounak', 'Simren'],
  'August 2026 (Anime NYC)': ['Alex Kim', 'Bret Birnham', 'Christos', 'Dan Toomey', 'Kilara', 'Kyle Lewis', 'Marcus Cusic', 'Neal', 'Nore Davis', 'Sonia Dennis', 'Zoe Dixon'],
  'January 2025 (NYC)': ['Betsy', 'Dan', 'Jesse', 'Kaz', 'Neal', 'Sarah'],
  'July 2024 (NYC)': ['Full Show'],
  'July 2025 (NYC)': ['Alex', 'Annette', 'Daemin', 'Divya', 'Doordash', 'Nat', 'Neal', 'Sarah', 'Shounak', 'Srishti'],
  'July 2026 (NYC)': ['AndrewG', 'Karthik', 'NateM', 'Neal P', 'Neal2', 'PeterB', 'PeterL', 'Sristi', 'Victoria'],
  'June 2025 (NYC Tech Week)': ['Dan', 'Humzah', 'Naveed', 'Neal', 'Shounak', 'Srishti', 'Yanjaa'],
  'June 2025 (NYTW Community Show)': ['Aakash', 'Alex Kim', 'Dan Toomey', 'Humzah C', 'Neal', 'Sarah', 'Shounak', 'Tatiana', 'Yanjaa'],
  'June 2026 (NYTW)': ['Ben', 'NealPt2'],
  'June 2026 (SF)': ['Abhay', 'Dan', 'Ed', 'K Cheng', 'Neal', 'Priya', 'Tirumari'],
  'March 2025 (NYC)': ['Amanda', 'Lakshmi', 'Neal', 'Stacy', 'Tatiana', 'Victoria', 'Yanjaa'],
  'March 2025 (SF)': ['Full Show'],
  'March 2026 (SF)': ['Aakash', 'Annette', 'Dan', 'Denise', 'Elisha', 'Neal', 'Sponsor Sketch', 'Steven', 'Yi'],
  'May 2026 (Boston)': ['DivyaG', 'HaydenA', 'KazK', 'Naveed', 'Neal Additional', 'Neal3', 'Neal4', 'NealP (Top)', 'PeteB', 'PeterL', 'YanjaaW'],
  'November 2024 (NYC - Immigrant Founders Roast)': ['Divya', 'Naveed', 'Neal', 'Sristhi', 'Yanjaa'],
  'October 2024 (LA Tech Week)': ['Full Show'],
  'October 2024 (SF Tech Week)': ['Full Show'],
  'October 2025 (SF + LA Tech Week)': ['Akaash', 'Annette', 'Nat', 'Naveed', 'Neal', 'Pete', 'Sarah'],
  'September 2025 (NYC)': ['Akaash', 'Ali', 'Amanda', 'Austin', 'Betsy', 'Lakshmi', 'Neal', 'Salma', 'Sam'],
}

group('normLabel')
eq('case, spaces and punctuation go', normLabel(' Yanjaa  Westgate '), 'yanjaawestgate')
eq('digits stay', normLabel('NealPt3'), 'nealpt3')
eq('K. Cheng', normLabel('K. Cheng'), 'kcheng')
eq('accents fold, not drop', [normLabel('Zoë'), normLabel('José')], ['zoe', 'jose'])
eq('non-Latin letters stay letters', normLabel('Янжаа'), 'янжаа')

group('splitPart — one trailing part marker, nothing name-specific')
eq('NealP (Top)', splitPart('NealP (Top)'), { base: 'NealP', part: 'Top of show' })
eq('Neal (Top)', splitPart('Neal (Top)'), { base: 'Neal', part: 'Top of show' })
eq('Neal2', splitPart('Neal2'), { base: 'Neal', part: 'Part 2' })
eq('NealPt3', splitPart('NealPt3'), { base: 'Neal', part: 'Part 3' })
eq('Neal Part 4', splitPart('Neal Part 4'), { base: 'Neal', part: 'Part 4' })
eq('Neal Additional', splitPart('Neal Additional'), { base: 'Neal', part: 'Additional' })
eq('Yi has no part', splitPart('Yi'), { base: 'Yi', part: null })
eq('a bare marker is not a part of nobody', splitPart('2'), { base: '2', part: null })
eq('only one marker comes off', splitPart('Neal2 (Top)'), { base: 'Neal2', part: 'Top of show' })

group('resolveComedian — every spelling lands on one person')
eq('YanjaaW', resolveComedian('May 2026 (Boston)', 'YanjaaW'), 'yanjaa-westgate')
eq('yanjaa westgate', resolveComedian('May 2026 (Boston)', 'yanjaa westgate'), 'yanjaa-westgate')
eq('Pete anywhere is Ballmer', resolveComedian('December 2030 (Mars)', 'Pete'), 'pete-ballmer')
eq('Akaash is a misspelling of Aakash', resolveComedian('September 2025 (NYC)', 'Akaash'), 'aakash')
eq('Laxmi finds Lakshmi', resolveComedian('March 2025 (NYC)', 'Laxmi'), 'lakshmi-k')

group('resolveComedian — ambiguous labels resolve ONLY per show')
eq('Dan, January 2025 NYC', resolveComedian('January 2025 (NYC)', 'Dan'), 'dan-toomey')
eq('Dan, March 2026 SF', resolveComedian('March 2026 (SF)', 'Dan'), 'dan-guan')
eq('Dan, June 2026 SF', resolveComedian('June 2026 (SF)', 'Dan'), 'dan-guan')
eq('Dan at a show with no override -> null, never a guess', resolveComedian('December 2027 (NYC)', 'Dan'), null)
eq('Alex, July 2025', resolveComedian('July 2025 (NYC)', 'Alex'), 'alex-shklar')
eq('Alex, December 2025', resolveComedian('December 2025 (NYC)', 'Alex'), 'alex-kim')
eq('Alex at a show with no override -> null', resolveComedian('May 2026 (Boston)', 'Alex'), null)
eq('Doordash, July 2025', resolveComedian('July 2025 (NYC)', 'Doordash'), 'aakash')
eq('Doordash anywhere else -> null', resolveComedian('May 2026 (Boston)', 'Doordash'), null)
eq('a part of an ambiguous label is still ambiguous', resolveComedian('December 2027 (NYC)', 'Dan2'), null)
eq('the show override covers its parts', ['Dan2', 'Dan (Top)'].map(l => resolveComedian('March 2026 (SF)', l)), ['dan-guan', 'dan-guan'])
eq('… for Alex and Peter too', [resolveComedian('July 2025 (NYC)', 'Alex (Top)'), resolveComedian('February 2026 (NYC)', 'Peter2')], ['alex-shklar', 'peter-liu'])
eq('a show name differing only in case or spacing keeps its overrides',
  ['July 2025  (NYC)', 'July 2025 (NYC) ', 'july 2025 (nyc)'].map(show => resolveComedian(show, 'Alex')), ['alex-shklar', 'alex-shklar', 'alex-shklar'])
eq('S., April 2026 — renamed Shounak in Drive', resolveComedian('April 2026 (NYC)', 'S.'), 'shounak')
eq('S. anywhere else -> null', resolveComedian('May 2026 (Boston)', 'S.'), null)

group('resolveComedian — multi-part labels at a show nobody has seen yet')
eq('Neal4', resolveComedian('March 2030 (NYC)', 'Neal4'), 'neal-patel')
eq('NealPt3', resolveComedian('March 2030 (NYC)', 'NealPt3'), 'neal-patel')
eq('NealP (Top)', resolveComedian('March 2030 (NYC)', 'NealP (Top)'), 'neal-patel')
eq('Neal Additional', resolveComedian('March 2030 (NYC)', 'Neal Additional'), 'neal-patel')
eq('an unknown label', resolveComedian('March 2030 (NYC)', 'Zed'), null)
eq('an empty label', resolveComedian('March 2030 (NYC)', ''), null)

group('resolveComedian — two comedians sharing an alias is unmatched, not a pick')
const clash = {
  COMEDIANS: [{ key: 'a', name: 'A', aliases: ['x'] }, { key: 'b', name: 'B', aliases: ['X.'] }],
  SHOW_OVERRIDES: { s2: { x: 'b' } },
  AMBIGUOUS: [],
  NOT_PEOPLE: [],
}
eq('shared alias', resolveComedian('s', 'x', clash), null)
eq('shared alias after the part comes off', resolveComedian('s', 'x2', clash), null)
eq('an override still settles it', resolveComedian('s2', 'x', clash), 'b')
eq('an override to a key that is not in the roster is ignored',
  resolveComedian('s', 'q', { ...clash, SHOW_OVERRIDES: { s: { q: 'nobody' } } }), null)

group('buildLibrary')
const status = {
  shows: [
    // Status order is not date order (the live file lists April 2026 before July 2026).
    {
      label: 'March 2026 (SF)', year: 2026, folderId: 'F-MAR',
      items: [
        { performer: 'Neal', filename: 'Neal Set.mp4', state: 'uploaded', youtubeId: 'yt-mar-neal' },
        { performer: 'Dan', filename: 'Dan Set.mp4', state: 'uploaded', youtubeId: 'yt-mar-dan' },
        { performer: 'Sponsor Sketch', filename: 'Sponsor Sketch.mp4', state: 'uploaded', youtubeId: 'yt-sketch' },
      ],
    },
    {
      label: 'December 2027 (NYC)', year: 2027, folderId: 'F-DEC',
      items: [
        { performer: 'Full Show', filename: 'Full Show.mp4', state: 'uploaded', youtubeId: 'yt-full' },
        { performer: 'Neal2', filename: 'Neal2 Set.mp4', state: 'pending' },
        { performer: 'Neal (Top)', filename: 'Neal (Top) Set.mp4', state: 'uploaded', youtubeId: 'yt-dec-top', durationSec: 460.4 },
        { performer: 'Dan', filename: 'Dan Set.mp4', state: 'uploaded', youtubeId: 'yt-dec-dan' },
        { performer: 'Yanjaa', filename: 'Yanjaa Set.mp4', state: 'held-back' },
      ],
    },
  ],
}
const lib = buildLibrary(status)
eq('only comedians with a set, sorted by name', lib.comedians.map(c => c.key), ['dan-guan', 'neal-patel'])
const neal = lib.comedians.find(c => c.key === 'neal-patel')
eq('the comedian carries name and aliases', [neal.name, neal.aliases.includes('NealP')], ['Neal Patel', true])
eq('newest show first, then running order', neal.sets.map(s => `${s.show} / ${s.filename}`),
  ['December 2027 (NYC) / Neal (Top) Set.mp4', 'December 2027 (NYC) / Neal2 Set.mp4', 'March 2026 (SF) / Neal Set.mp4'])
eq('a set ref', neal.sets[0], {
  show: 'December 2027 (NYC)', year: 2027, folderId: 'F-DEC', filename: 'Neal (Top) Set.mp4',
  label: 'Neal (Top)', part: 'Top of show', state: 'uploaded', youtubeId: 'yt-dec-top', durationSec: 460.4,
})
eq('pending: part label, no YouTube id yet', [neal.sets[1].part, neal.sets[1].state, neal.sets[1].youtubeId], ['Part 2', 'pending', null])
eq('a plain set has no part', neal.sets[2].part, null)
eq('no durationSec in the status file -> null, not 0', [neal.sets[1].durationSec, neal.sets[2].durationSec], [null, null])
eq('a junk durationSec -> null', buildLibrary({ shows: [{ label: 'May 2026 (Boston)', year: 2026, folderId: 'F', items: [
  { performer: 'Neal', filename: 'Neal Set.mp4', state: 'pending', durationSec: 'abc' }] }] }).comedians[0].sets[0].durationSec, null)
eq('the overridden Dan lands on Guan', lib.comedians.find(c => c.key === 'dan-guan').sets.map(s => s.show), ['March 2026 (SF)'])
eq('the un-overridden Dan is unmatched, not filed under any Dan', lib.unmatched.map(s => `${s.show} / ${s.label}`), ['December 2027 (NYC) / Dan'])
ok('Full Show and Sponsor Sketch are nobody, not unmatched', ![...lib.unmatched, ...lib.comedians.flatMap(c => c.sets)].some(s => /Full Show|Sponsor/.test(s.label)))
ok('held-back tapes are skipped', !lib.comedians.some(c => c.key === 'yanjaa-westgate'))
eq('empty status', buildLibrary({}), { comedians: [], unmatched: [] })
const order = buildLibrary({ shows: [{ label: 'May 2026 (Boston)', year: 2026, folderId: 'F', items:
  ['Neal Additional', 'Neal10', 'Neal3', 'Neal4', 'NealP (Top)', 'Neal2'].map(p => ({ performer: p, filename: `${p} Set.mp4`, state: 'pending' })) }] })
eq('a show\'s parts in running order: top, 2, 3 … 10, additional',
  order.comedians[0].sets.map(s => s.label), ['NealP (Top)', 'Neal2', 'Neal3', 'Neal4', 'Neal10', 'Neal Additional'])

group('searchComedians')
eq('empty query returns all', searchComedians(lib.comedians, '  ').length, 2)
eq('by name, any case', searchComedians(lib.comedians, 'NEAL pa').map(c => c.key), ['neal-patel'])
eq('by alias', searchComedians(lib.comedians, 'dan guan').map(c => c.key), ['dan-guan'])
const all = buildLibrary({ shows: [{ label: 'May 2026 (Boston)', year: 2026, folderId: 'F', items: [
  { performer: 'YanjaaW', filename: 'YanjaaW Set.mp4', state: 'uploaded', youtubeId: 'y' },
  { performer: 'Lakshmi', filename: 'Lakshmi Set.mp4', state: 'uploaded', youtubeId: 'l' },
] }] }).comedians
eq('substring "yan"', searchComedians(all, 'yan').map(c => c.key), ['yanjaa-westgate'])
eq('an alias the name lacks ("laxmi")', searchComedians(all, 'laxmi').map(c => c.key), ['lakshmi-k'])
eq('no match', searchComedians(all, 'zzz'), [])

group('formatLength')
eq('m:ss under an hour', [formatLength(460.4), formatLength(59), formatLength(3599)], ['7:40', '0:59', '59:59'])
eq('h:mm:ss over an hour', [formatLength(3600), formatLength(3725)], ['1:00:00', '1:02:05'])
eq('unknown is empty', [formatLength(null), formatLength(0), formatLength(undefined)], ['', '', ''])

group('requestsForTape — what a card counts is what the review pane lists')
const tape = { fileId: 'FILE-NEAL', name: 'Neal (Top) Set.mp4' }
const sheet = {
  clips: [
    { clipId: 'a', videoFileId: 'FILE-NEAL', ranges: [{ s: 318, e: 330 }, { s: 131, e: 140.6 }], clipLinks: [] },
    { clipId: 'b', videoFileId: 'FILE-NEAL', ranges: [{ s: 302, e: 340 }], clipLinks: ['https://drive.google.com/file/d/x/view'] },
    { clipId: 'c', videoFileId: 'FILE-DAN', ranges: [{ s: 10, e: 20 }], clipLinks: ['https://drive.google.com/file/d/y/view'] },
    // A row whose ranges_json didn't parse: listed (and counted) by the review pane, no span.
    { clipId: 'd', videoFileId: 'FILE-NEAL', ranges: [], clipLinks: [] },
  ],
  legacy: [
    { name: 'Neal', start: '1:05', end: '1:40', clipLinks: ['https://drive.google.com/file/d/z/view'] },
    { name: 'NEAL', start: '', end: '', clipLinks: [] },
    // myLegacy's sameName: "Neal P" is not a prefix of "Neal (Top)", so the pane doesn't list it either.
    { name: 'Neal P', start: '2:00', end: '2:10', clipLinks: [] },
    { name: 'Neal', start: '9:12', end: '', clipLinks: [] },
    { name: 'Dan', start: '0:30', end: '0:50', clipLinks: [] },
  ],
}
const req = requestsForTape(sheet, tape)
eq('count: this tape\'s app rows + the typed rows the review pane matches on the name', req.count, 6)
eq('finished: rows with a finished-clip link', req.finished, 2)
eq('spans: outer span per app row, typed text as typed, earliest first', req.spans, [
  { start: '1:05', end: '1:40' }, { start: '2:11', end: '5:30' }, { start: '5:02', end: '5:40' }, { start: '9:12', end: '?' },
])
eq('another tape\'s rows are not this tape\'s', requestsForTape(sheet, { fileId: 'FILE-DAN', name: 'Dan Set.mp4' }),
  { count: 2, finished: 1, spans: [{ start: '0:10', end: '0:20' }, { start: '0:30', end: '0:50' }] })
eq('an empty sheet', requestsForTape({ clips: [], legacy: [] }, tape), { count: 0, finished: 0, spans: [] })
eq('no sheet at all (getClips before the first save has no legacy key)', requestsForTape({ clips: [] }, tape), { count: 0, finished: 0, spans: [] })
eq('a typed row with times only in the granular column spans what the pane plays',
  requestsForTape({ clips: [], legacy: [{ name: 'Neal', start: '', end: '', granular: '2:10-2:40, 5:00-5:20', clipLinks: [] }] }, tape),
  { count: 1, finished: 0, spans: [{ start: '2:10', end: '5:20' }] })

group('coverage — every set tape anyone has filed resolves to a comedian (or is nobody)')
const notPeople = new Set(ROSTER.NOT_PEOPLE.map(normLabel))
const unplaced = rows => rows.filter(([show, label]) => !notPeople.has(normLabel(label)) && !resolveComedian(show, label)).map(([show, label]) => `${show} / ${label}`)
const driveRows = Object.entries(DRIVE_LABELS_2026_10_22).flatMap(([show, labels]) => labels.map(label => [show, label]))
eq('fixture is the full 118-label scan plus the 3 Anime NYC sets that landed later', driveRows.length, 121)

group('June 2024 (NYC Tech Week) — the ingest\'s "<Name>AUJun6FullSet" labels')
eq('Ali', resolveComedian('June 2024 (NYC Tech Week)', 'AliAUJun6FullSet'), 'ali')
eq('Austin', resolveComedian('June 2024 (NYC Tech Week)', 'AustinAUJun6FullSet'), 'austin-nasso')
eq('Neal hosting', resolveComedian('June 2024 (NYC Tech Week)', 'NealAUJun6AllHostingSets'), 'neal-patel')
eq('which Alex is still open, so unmatched', resolveComedian('June 2024 (NYC Tech Week)', 'AlexAUJun6FullSet'), null)
eq('the label means nothing at another show', resolveComedian('June 2025 (NYC Tech Week)', 'AliAUJun6FullSet'), null)
eq('every Drive label (2026-10-22) resolves', unplaced(driveRows), [])
const live = JSON.parse(readFileSync(new URL('../data/upload-status.json', import.meta.url), 'utf8'))
const liveRows = (live.shows || []).flatMap(s => (s.items || []).map(i => [s.label, i.performer]))
ok('upload-status.json has items', liveRows.length > 0)
eq('every data/upload-status.json item resolves', unplaced(liveRows), [])

group('roster integrity')
const { COMEDIANS, SHOW_OVERRIDES, AMBIGUOUS, NOT_PEOPLE } = ROSTER
const keys = COMEDIANS.map(c => c.key)
eq('keys are unique', keys.filter((k, i) => keys.indexOf(k) !== i), [])
eq('keys are slugs', keys.filter(k => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(k)), [])
eq('every comedian has a name and an alias', COMEDIANS.filter(c => !c.name || !c.aliases?.length).map(c => c.key), [])
eq('every override is keyed by a show folder name', Object.keys(SHOW_OVERRIDES).filter(k => !parseShowFolderName(k)), [])
eq('every override target is a real key',
  Object.entries(SHOW_OVERRIDES).flatMap(([show, m]) => Object.entries(m).filter(([, k]) => !keys.includes(k)).map(([l, k]) => `${show} / ${l} -> ${k}`)), [])
const owners = new Map()
for (const c of COMEDIANS) for (const a of c.aliases) owners.set(normLabel(a), [...(owners.get(normLabel(a)) || []), c.key])
eq('no alias belongs to two comedians', [...owners].filter(([, ks]) => new Set(ks).size > 1).map(([a, ks]) => `${a}: ${ks.join(', ')}`), [])
eq('no AMBIGUOUS label is also a global alias', AMBIGUOUS.filter(a => owners.has(normLabel(a))), [])
eq('no NOT_PEOPLE label is an alias', NOT_PEOPLE.filter(a => owners.has(normLabel(a))), [])

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
