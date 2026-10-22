#!/usr/bin/env node
// Assertions for videoreview/ingest.js — the source -> destination rules.
//
//   node videoreview/test-ingest.mjs
//
// Separate from test.mjs only because the videoreview refactor is in flight; fold these groups
// into it once that lands. Zero dependencies, same eq/group style as test.mjs.

import { readFileSync } from 'node:fs'
import { classify, routeAll, performerFrom, extOf, parseShareLink, findShowCollision, normalizeCity,
         guessPerformers, planTapes, pileDest, tidyName, angleFrom, safeSegment } from './ingest.js'
import { showFolderName, parseShowFolderName } from './shows.js'
import { SKIP_FOLDER_RE, EXCLUDED_TAPE_RE, TAPES_FOLDER_RE } from './tapes.js'

let pass = 0
const fail = []

function eq(label, got, want) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) pass++
  else fail.push(`${label}\n    got  ${g}\n    want ${w}`)
}
const ok = (label, cond) => eq(label, !!cond, true)
const group = name => console.log(`\n${name}`)

// ---------------------------------------------------------------- performerFrom --

group('performerFrom — and its idempotence, which ingest relies on')
eq('dated master',        performerFrom('AndrewG_7-30-26.mp4'), 'AndrewG')
eq('space in the name',   performerFrom('Neal P_7-30-26.mp4'), 'Neal P')
eq('digit in the name',   performerFrom('Neal2_7-30-26.mp4'), 'Neal2')
eq('already renamed',     performerFrom('Aakash Set.mp4'), 'Aakash')
eq('idempotent',          performerFrom(performerFrom('AndrewG_7-30-26.mp4') + ' Set.mp4'), 'AndrewG')
eq('parenthesised date',  performerFrom('Maybr-Intro (4-23-26).mp4'), 'Maybr Intro')
eq('4-digit year',        performerFrom('Dan_10-14-2025.mov'), 'Dan')
eq('never empty',         performerFrom('Set.mp4'), 'Set.mp4')

group('extOf')
eq('mp4', extOf('a.mp4'), '.mp4')
eq('uppercase kept', extOf('a.MOV'), '.MOV')
eq('none', extOf('Makefile'), '')
eq('dot in a folder does not count', extOf('3:18:26 sets/a'), '')

// ---------------------------------------------------------------- classify --

group('classify — real July 2026 filenames reproduce what is on Drive today')
// Verified live: the July Dropbox folder holds "<Name>_7-30-26.mp4" and the Drive folder holds
// "tapes/<Name> Set.mp4". The rules must agree with the rename that already happened by hand.
for (const [src, want] of [
  ['AndrewG_7-30-26.mp4', 'tapes/AndrewG Set.mp4'],
  ['Karthik_7-30-26.mp4', 'tapes/Karthik Set.mp4'],
  ['NateM_7-30-26.mp4',   'tapes/NateM Set.mp4'],
  ['Neal P_7-30-26.mp4',  'tapes/Neal P Set.mp4'],
  ['Neal2_7-30-26.mp4',   'tapes/Neal2 Set.mp4'],
  ['PeterB_7-30-26.mp4',  'tapes/PeterB Set.mp4'],
]) eq(src, classify(src).dest, want)

group('classify — the extension is preserved, never coerced to .mp4')
eq('.mov master', classify('Dan_10-14-25.mov').dest, 'tapes/Dan Set.mov')
eq('.MXF master', classify('Dan_10-14-25.MXF').dest, 'tapes/Dan Set.MXF')

group('classify — reels go to extras/, because the review app filters them out of tapes/')
for (const src of ['AI_7-30 SIZZLE.mp4', 'April2026_HighlightReel_maybern.mp4',
                   'April UPDATE.mp4', 'Boston recap.mov']) {
  eq(`${src} -> extras`, classify(src).kind, 'extra')
  ok(`${src} not under tapes/`, !classify(src).dest.startsWith('tapes/'))
}

group('classify — a skipped source folder outranks the file type')
eq('video in Clips/',  classify('Clips/BenClip.mp4').kind, 'extra')
eq('video in photos/', classify('photos/walkin.mp4').kind, 'extra')
eq('nested flicks/',   classify('Day 2/Flicks/x.mp4').kind, 'extra')
eq('keeps the path',   classify('Clips/BenClip.mp4').dest, 'extras/Clips/BenClip.mp4')

group('classify — stills')
eq('jpg',  classify('NotSoDailyStandupShow083026-1.jpg').dest, 'photos/NotSoDailyStandupShow083026-1.jpg')
// A still is a photo whatever folder it came from, and photos/ is never nested inside itself.
eq('source photos/ is not nested', classify('photos/a.jpg').dest, 'photos/a.jpg')
eq('source Photos/ too',           classify('Photos/a.jpg').dest, 'photos/a.jpg')
eq('deeper grouping is kept',      classify('photos/Selects/a.jpg').dest, 'photos/Selects/a.jpg')
eq('still in Clips/ is a photo',   classify('Clips/a.jpg').kind, 'photo')
eq('HEIC', classify('IMG_2013.HEIC').kind, 'photo')
eq('raw',  classify('Selects/DSC_0491.CR3').kind, 'photo')
eq('subpath preserved', classify('Selects/DSC_0491.CR3').dest, 'photos/Selects/DSC_0491.CR3')

group('classify — unrecognised files are copied, never dropped')
eq('.DS_Store is other',  classify('.DS_Store').kind, 'other')
ok('.DS_Store still has a dest', !!classify('.DS_Store').dest)
eq('aae sidecar',         classify('IMG_2013.aae').dest, 'extras/_source/IMG_2013.aae')
eq('leading slash ok',    classify('/AndrewG_7-30-26.mp4').dest, 'tapes/AndrewG Set.mp4')

// ---------------------------------------------------------------- invariants --

group('invariants the review app depends on')
const SAMPLE = [
  '/AndrewG_7-30-26.mp4', '/Neal P_7-30-26.mp4', '/Dan_10-14-25.mov',
  '/AI_7-30 SIZZLE.mp4', '/April UPDATE.mp4', '/Clips/BenClip.mp4',
  '/photos/a.jpg', '/Selects/DSC_0491.CR3', '/.DS_Store', '/IMG_2013.aae',
]
for (const src of SAMPLE) {
  const { kind, dest } = classify(src)
  const top = dest.split('/')[0]
  ok(`${src}: bucket "${top}" is tapes/ or a skipped name`,
     TAPES_FOLDER_RE.test(top) || SKIP_FOLDER_RE.test(top))
  if (kind === 'tape') {
    ok(`${src}: a tapes/ name never matches EXCLUDED_TAPE_RE`,
       !EXCLUDED_TAPE_RE.test(dest.split('/').pop()))
  }
}

// ---------------------------------------------------------------- routeAll --

group('routeAll — collisions are reported, not silently renamed')
// The realistic case is a two-night show: the date is exactly what performerFrom strips, so
// both nights reduce to one performer and one destination. The second copy would overwrite the
// first with nothing in any log to say so, which is why this blocks submit instead of numbering
// the loser "Dan Set 2.mp4".
const collide = routeAll([
  { path: '/Dan_10-14-25.mp4', bytes: 1 },
  { path: '/Dan_10-15-25.mp4', bytes: 2 },
  { path: '/AndrewG_7-30-26.mp4', bytes: 3 },
])
eq('one collision found', collide.duplicates.length, 1)
eq('on the right dest',   collide.duplicates[0].dest, 'tapes/Dan Set.mp4')
eq('naming both sources', collide.duplicates[0].sources, ['Dan_10-14-25.mp4', 'Dan_10-15-25.mp4'])

// A re-delivery alongside an already-renamed copy collides the same way.
eq('dated + renamed collide',
   routeAll([{ path: '/Dan_10-14-25.mp4', bytes: 1 }, { path: '/Dan Set.mp4', bytes: 2 }])
     .duplicates.length, 1)
// Different extensions do NOT collide — both are kept, and that is correct.
eq('.mov and .mp4 coexist',
   routeAll([{ path: '/Dan_10-14-25.mp4', bytes: 1 }, { path: '/Dan_10-14-25.mov', bytes: 2 }])
     .duplicates, [])
// Part numbers survive performerFrom, so a split set does not collide either.
eq('part1/part2 do not collide',
   routeAll([{ path: '/Dan_part1.mp4', bytes: 1 }, { path: '/Dan_part2.mp4', bytes: 2 }])
     .duplicates, [])

group('classify — known warts, asserted so they are not discovered in production')
// March NYC's real convention is "PeteSet.mp4" / "DanSet.mp4" with no separator, and \bset\b
// cannot fire without one. Ingest therefore proposes "PeteSet Set.mp4". Mechanically correct,
// visibly silly — which is exactly why the portal's destination column is editable. Do not
// "fix" this by stripping a trailing "Set" unconditionally: that would turn a performer
// genuinely called "Set" into an empty name.
eq('no-separator Set', classify('PeteSet.mp4').dest, 'tapes/PeteSet Set.mp4')
// Likewise, ingest does not correct spelling. April's "Albberta" was fixed by hand on the way in
// and lives on as a displayNameOverrides entry; a new show fixes it in the preview table instead.
eq('spelling is not guessed', classify('Albberta_4-23-26.mp4').dest, 'tapes/Albberta Set.mp4')

const clean = routeAll([
  { path: '/AndrewG_7-30-26.mp4', bytes: 4014816409 },
  { path: '/AI_7-30 SIZZLE.mp4', bytes: 50000000 },
  { path: '/photos/a.jpg', bytes: 1000 },
  { path: '/.DS_Store', bytes: 6148 },
  { path: '/Selects', bytes: 0, isDir: true },
])
eq('no false collisions', clean.duplicates, [])
eq('folders are not rows', clean.rows.length, 4)
eq('counts', clean.counts, { tape: 1, photo: 1, extra: 1, other: 1 })
eq('bytes are summed', clean.bytes, 4014816409 + 50000000 + 1000 + 6148)
ok('rows are sorted by source', clean.rows.map(r => r.src).join() ===
   [...clean.rows.map(r => r.src)].sort((a, b) => a.localeCompare(b)).join())
eq('href is carried through for the downloader',
   routeAll([{ path: '/a.mp4', bytes: 1, href: 'https://x' }]).rows[0].href, 'https://x')

group('the real July 2026 manifest, end to end (offline fixture)')
// Captured from the live Dropbox share on 2026-09-18 via nsds_fetch.py enumerate_share, which
// reconciled 9 of 9 against Dropbox's own total_num_entries. tools/README.md records the same
// show as "9 files, 44.0 GiB" — 44.0 GiB is 47.2 GB, so the byte total below agrees with it.
//
// The point of this fixture: routing these raw source names must reproduce, character for
// character, the tapes/ names a human produced by hand when this show was moved. Verified
// against live Drive at the time of writing — all 9 matched.
const JULY_2026_NYC = [
  { path: "/AndrewG_7-30-26.mp4", bytes: 4014816409 },
  { path: "/Karthik_7-30-26.mp4", bytes: 6175793044 },
  { path: "/NateM_7-30-26.mp4", bytes: 5782168937 },
  { path: "/Neal P_7-30-26.mp4", bytes: 9682715247 },
  { path: "/Neal2_7-30-26.mp4", bytes: 731765183 },
  { path: "/PeterB_7-30-26.mp4", bytes: 5308346878 },
  { path: "/PeterL_7-30-26.mp4", bytes: 5537877009 },
  { path: "/Sristi_7-30-26.mp4", bytes: 3823639688 },
  { path: "/Victoria_7-30-26.mp4", bytes: 6190268290 },
]
const july = routeAll(JULY_2026_NYC)
eq('9 files in, 9 tapes out', july.counts, { tape: 9, photo: 0, extra: 0, other: 0 })
eq('no collisions',           july.duplicates, [])
eq('byte total',              july.bytes, 47247390685)
eq('reproduces the live Drive tapes/ names',
   july.rows.map(r => r.dest).sort(),
   ['tapes/AndrewG Set.mp4', 'tapes/Karthik Set.mp4', 'tapes/NateM Set.mp4',
    'tapes/Neal P Set.mp4', 'tapes/Neal2 Set.mp4', 'tapes/PeterB Set.mp4',
    'tapes/PeterL Set.mp4', 'tapes/Sristi Set.mp4', 'tapes/Victoria Set.mp4'])

// ---------------------------------------------------------------- assign: who's who --

group('tidyName / angleFrom / safeSegment')
eq('shouting folder', tidyName('KYLE LEWIS'), 'Kyle Lewis')
eq('mixed case is left alone', tidyName('DavidS'), 'DavidS')
eq('initial stays', tidyName('Neal P'), 'Neal P')
eq('angle after a dash', angleFrom('A/Alex Kim - Audience Shot.mp4', 'Alex Kim'), 'Audience Shot')
eq('angle with no dash', angleFrom('Kyle Lewis Sideshot.mp4', 'Kyle Lewis'), 'Sideshot')
eq('name inside a word is not removed', angleFrom('Neal - Nealson cam.mp4', 'Neal'), 'Nealson cam')
eq('nothing left', angleFrom('Dan.mp4', 'Dan'), '')
eq('slashes cannot nest folders', safeSegment('AC/DC'), 'AC DC')
eq('no hidden files', safeSegment('..Dan'), 'Dan')

group('guessPerformers — the real ANYC 2026 WeTransfer (offline fixture)')
// Filenames and sizes from the live transfer on 2026-10-22. Ids are synthetic: the real ones and
// the link's hash are credentials (see SECURITY.md).
const ANYC_2026 = [
  { path: "ANYC 2026 - SETS/Alex Kim/Alex Kim - Audience Shot.mp4", bytes: 4834653735, href: '000000000000000000000000' },
  { path: "ANYC 2026 - SETS/Alex Kim/Alex Kim - Master Shot.mp4", bytes: 4839255283, href: '010101010101010101010101' },
  { path: "ANYC 2026 - SETS/Alex Kim/Alex Kim - Side Shot.mp4", bytes: 4834015791, href: '020202020202020202020202' },
  { path: "ANYC 2026 - SETS/Bret Birnham/Bret Birnham - Audience Shot.mp4", bytes: 3951863184, href: '030303030303030303030303' },
  { path: "ANYC 2026 - SETS/Bret Birnham/Bret Birnham - Audio (First half).mp4", bytes: 8669983, href: '040404040404040404040404' },
  { path: "ANYC 2026 - SETS/Bret Birnham/Bret Birnham - Master Shot.mp4", bytes: 3958136515, href: '050505050505050505050505' },
  { path: "ANYC 2026 - SETS/Bret Birnham/Bret Birnham - Side Shot.mp4", bytes: 3953711531, href: '060606060606060606060606' },
  { path: "ANYC 2026 - SETS/Christos/Christos - Audience Shot.mp4", bytes: 4599705975, href: '070707070707070707070707' },
  { path: "ANYC 2026 - SETS/Christos/Christos - Master Shot.mp4", bytes: 4602208372, href: '080808080808080808080808' },
  { path: "ANYC 2026 - SETS/Christos/Christos - Side Shot.mp4", bytes: 4598735491, href: '090909090909090909090909' },
  { path: "ANYC 2026 - SETS/Dan Toomey/Dan Toomey - Audience Shot.mp4", bytes: 4902597018, href: '101010101010101010101010' },
  { path: "ANYC 2026 - SETS/Dan Toomey/Dan Toomey - Master Shot.mp4", bytes: 4709717842, href: '111111111111111111111111' },
  { path: "ANYC 2026 - SETS/Dan Toomey/Dan Toomey - Side Shot.mp4", bytes: 4901790925, href: '121212121212121212121212' },
  { path: "ANYC 2026 - SETS/KYLE LEWIS/Kyle Lewis Audience Shot.mp4", bytes: 5638166829, href: '131313131313131313131313' },
  { path: "ANYC 2026 - SETS/KYLE LEWIS/Kyle Lewis Master Shot.mp4", bytes: 5643362397, href: '141414141414141414141414' },
  { path: "ANYC 2026 - SETS/KYLE LEWIS/Kyle Lewis Sideshot.mp4", bytes: 5640584720, href: '151515151515151515151515' },
  { path: "ANYC 2026 - SETS/Kilara/Kilara - Audience Shot.mp4", bytes: 4846266270, href: '161616161616161616161616' },
  { path: "ANYC 2026 - SETS/Kilara/Kilara - Master Shot.mp4", bytes: 4850357820, href: '171717171717171717171717' },
  { path: "ANYC 2026 - SETS/Kilara/Kilara - Side Shot.mp4", bytes: 4847461303, href: '181818181818181818181818' },
  { path: "ANYC 2026 - SETS/Marcus Cusic/Marcus Cusic - Audience Shot.mp4", bytes: 5060347134, href: '191919191919191919191919' },
  { path: "ANYC 2026 - SETS/Marcus Cusic/Marcus Cusic - Master Shot.mp4", bytes: 5066498091, href: '202020202020202020202020' },
  { path: "ANYC 2026 - SETS/Marcus Cusic/Marcus Cusic - Side Shot.mp4", bytes: 5060948272, href: '212121212121212121212121' },
  { path: "ANYC 2026 - SETS/NORE DAVIS/Nore Davis - Audience Shot.mp4", bytes: 5798272437, href: '222222222222222222222222' },
  { path: "ANYC 2026 - SETS/NORE DAVIS/Nore Davis - Master Shot.mp4", bytes: 5801840179, href: '232323232323232323232323' },
  { path: "ANYC 2026 - SETS/NORE DAVIS/Nore Davis - Side Shot.mp4", bytes: 5796845932, href: '242424242424242424242424' },
  { path: "ANYC 2026 - SETS/Neal/Neal - Audience Shot.mp4", bytes: 5173622537, href: '252525252525252525252525' },
  { path: "ANYC 2026 - SETS/Neal/Neal - Master Shot.mp4", bytes: 5177922296, href: '262626262626262626262626' },
  { path: "ANYC 2026 - SETS/Neal/Neal - Side Shot.mp4", bytes: 5174095490, href: '272727272727272727272727' },
  { path: "ANYC 2026 - SETS/Sonia Dennis/Sonia Dennis - Audience Shot.mp4", bytes: 4959008075, href: '282828282828282828282828' },
  { path: "ANYC 2026 - SETS/Sonia Dennis/Sonia Dennis - Master Shot.mp4", bytes: 4963658416, href: '292929292929292929292929' },
  { path: "ANYC 2026 - SETS/Sonia Dennis/Sonia Dennis - Side Shot.mp4", bytes: 4957305305, href: '303030303030303030303030' },
  { path: "ANYC 2026 - SETS/Zoe Dixon/Zoe Dixon - Audience Shot.mp4", bytes: 4570881037, href: '313131313131313131313131' },
  { path: "ANYC 2026 - SETS/Zoe Dixon/Zoe Dixon - Master Shot.mp4", bytes: 4577134469, href: '323232323232323232323232' },
  { path: "ANYC 2026 - SETS/Zoe Dixon/Zoe Dixon - Side Shot.mp4", bytes: 4573573220, href: '333333333333333333333333' },
]
const anyc = routeAll(ANYC_2026)
const guess = guessPerformers(anyc.rows)
eq('34 files, all tapes', anyc.counts, { tape: 34, photo: 0, extra: 0, other: 0 })
eq('byte total matches the transfer', anyc.bytes, 162873213874)
eq('11 performers, from the folders — the wrapper folder is ignored',
   guess.map(p => p.name),
   ['Alex Kim', 'Bret Birnham', 'Christos', 'Dan Toomey', 'Kilara', 'Kyle Lewis', 'Marcus Cusic',
    'Neal', 'Nore Davis', 'Sonia Dennis', 'Zoe Dixon'])
ok('every main is the Master Shot', guess.every(p => /Master Shot\.mp4$/.test(p.main)))
eq('Bret keeps all four files', guess.find(p => p.name === 'Bret Birnham').files.length, 4)
eq('angles named from what is left of the filename',
   Object.values(guess.find(p => p.name === 'Bret Birnham').angles).sort(),
   ['Audience Shot', 'Audio (First half)', 'Side Shot'])

const bySrc = new Map(anyc.rows.map(r => [r.src, r]))
const plan = planTapes(guess, bySrc)
eq('no problems', plan.problems, [])
eq('every file filed once', plan.manifest.length, 34)
eq('one tape per performer — the main, named the way the review app expects',
   plan.manifest.filter(r => !r.dest.includes('/angles/')).map(r => r.dest).sort(),
   guess.map(p => `tapes/${p.name}/${p.name} Set.mp4`).sort())
eq('alternates under angles/',
   plan.manifest.filter(r => r.src.endsWith('Alex Kim - Side Shot.mp4'))[0].dest,
   'tapes/Alex Kim/angles/Alex Kim - Side Shot.mp4')
eq('the href (a WeTransfer file id) rides along', plan.manifest[0].href, bySrc.get(plan.manifest[0].src).href)

group('guessPerformers — the other shapes deliveries come in')
// July 2026: flat, one file each. Same performer names the flat layout produced.
eq('flat delivery: one performer per file',
   guessPerformers(routeAll(JULY_2026_NYC).rows).map(p => p.name),
   ['AndrewG', 'Karthik', 'NateM', 'Neal P', 'Neal2', 'PeterB', 'PeterL', 'Sristi', 'Victoria'])
// Angle words come off a filename too, so flat multi-angle files still group.
const flatAngles = guessPerformers(routeAll([
  { path: '/Alex Kim - Audience Shot.mp4', bytes: 2 }, { path: '/Alex Kim - Master Shot.mp4', bytes: 1 },
  { path: '/KYLE LEWIS cam B.mp4', bytes: 5 }, { path: '/Kyle Lewis.mp4', bytes: 9 },
]).rows)
eq('flat angles group by person', flatAngles.map(p => [p.name, p.files.length]), [['Alex Kim', 2], ['Kyle Lewis', 2]])
eq('master beats bigger', flatAngles[0].main, 'Alex Kim - Master Shot.mp4')
eq('no master: the largest is main', flatAngles[1].main, 'Kyle Lewis.mp4')
// A folder only names a person when its name shows up in its files.
eq('"Day 1/" is not a performer',
   guessPerformers(routeAll([{ path: '/Day 1/Alex.mp4', bytes: 1 }, { path: '/Day 1/Bob.mp4', bytes: 1 },
                             { path: '/Day 2/Carl.mp4', bytes: 1 }]).rows).map(p => p.name),
   ['Alex', 'Bob', 'Carl'])
eq('only tapes go on the board', guessPerformers(routeAll([{ path: '/AI SIZZLE.mp4', bytes: 1 }]).rows), [])

group('planTapes — what blocks submit')
const two = new Map([['a.mp4', { bytes: 1 }], ['b.mp4', { bytes: 2 }], ['c.mov', { bytes: 3 }]])
const card = (name, files, main = files[0], angles = {}) => ({ name, files, main, angles })
eq('empty card is ignored', planTapes([card('', [], null)], two), { manifest: [], problems: [] })
ok('no name', /has no name/.test(planTapes([card('  ', ['a.mp4'])], two).problems[0]))
ok('same person twice', /same name/.test(planTapes([card('Dan', ['a.mp4']), card('dan', ['b.mp4'])], two).problems[0]))
ok('a name the review app would hide', /review app hides/.test(planTapes([card('Recap Rick', ['a.mp4'])], two).problems[0]))
ok('main not on the card', /main shot/.test(planTapes([card('Dan', ['a.mp4'], 'b.mp4')], two).problems[0]))
ok('two angles, one name (case does not tell them apart)',
   /rename one/.test(planTapes([card('Dan', ['a.mp4', 'b.mp4', 'c.mp4'], 'a.mp4', { 'b.mp4': 'Side', 'c.mp4': 'side' })],
                               new Map([...two, ['c.mp4', { bytes: 3 }]])).problems[0]))
eq('extensions are kept', planTapes([card('Dan', ['c.mov', 'a.mp4'], 'c.mov', { 'a.mp4': 'Wide' })], two).manifest.map(r => r.dest),
   ['tapes/Dan/Dan Set.mov', 'tapes/Dan/angles/Dan - Wide.mp4'])
eq('an alternate with no angle name still lands somewhere sane',
   planTapes([card('Dan', ['a.mp4', 'b.mp4'], 'a.mp4', {})], two).manifest[1].dest, 'tapes/Dan/angles/Dan - angle.mp4')

group('pileDest — a video taken off the board')
eq('a tape moved off goes to extras/ under its source path', pileDest({ kind: 'tape', src: 'Day 1/Intro.mp4', dest: 'tapes/Intro Set.mp4' }), 'extras/Day 1/Intro.mp4')
eq('an extra keeps its own dest', pileDest({ kind: 'extra', src: 'AI SIZZLE.mp4', dest: 'extras/AI SIZZLE.mp4' }), 'extras/AI SIZZLE.mp4')

group('Code.gs assertManifest accepts what planTapes makes, and nothing looser')
// Run the backend's own function, not a copy of its rules: the browser plans, the server checks,
// and a drift between them is a submit button that always fails.
const gs = readFileSync(new URL('./apps-script/Code.gs', import.meta.url), 'utf8')
const fnSrc = gs.slice(gs.indexOf('function assertManifest'), gs.indexOf('\n}\n', gs.indexOf('function assertManifest')) + 2)
const assertManifest = new Function(`var UPLOAD_BUCKETS = ['tapes', 'photos', 'extras'];\n${fnSrc}\nreturn assertManifest`)()
const refuses = (label, manifest, kind, re) => {
  let msg = null
  try { assertManifest(manifest, kind) } catch (e) { msg = e.message }
  ok(`${label} — refused (${msg})`, msg && re.test(msg))
}
let accepted = true
try { assertManifest(plan.manifest, 'wetransfer') } catch (e) { accepted = e.message }
eq('the whole ANYC plan', accepted, true)
try { accepted = true; assertManifest([{ src: 'a', dest: 'tapes/Dan Set.mp4', href: 'x' }], 'dropbox') } catch (e) { accepted = e.message }
eq('an old flat tape still passes', accepted, true)
const T = (dest, href = 'f'.repeat(24)) => ({ src: dest, dest, href })
refuses('no main', [T('tapes/Dan/angles/Dan - Side.mp4')], 'wetransfer', /exactly one main/)
refuses('two mains', [T('tapes/Dan/Dan Set.mp4'), T('tapes/Dan/Dan Set.mov')], 'wetransfer', /exactly one main/)
refuses('nested past angles/', [T('tapes/Dan/Dan Set.mp4'), T('tapes/Dan/angles/x/y.mp4')], 'wetransfer', /tapes\/<performer>/)
refuses('a subfolder that is not angles/', [T('tapes/Dan/Dan Set.mp4'), T('tapes/Dan/raw/y.mp4')], 'wetransfer', /tapes\/<performer>/)
refuses('a URL where a WeTransfer file id goes', [T('tapes/Dan/Dan Set.mp4', 'https://evil.example/x')], 'wetransfer', /file id/)
refuses('same dest, different case', [T('tapes/Dan/Dan Set.mp4'), T('tapes/dan/dan set.mp4')], 'dropbox', /both land/)

group('parseShareLink — every rejection here is a failure someone would otherwise hit hours later')
// Synthetic links on purpose. Real share links are credentials: for a folder shared "anyone with
// the link", the rlkey IS the authorization, so committing one to this public repo would publish
// the footage. See SECURITY.md.
const DBX = 'https://www.dropbox.com/scl/fo/aaaaaaaaaaaaaaaaaaaaa/BBBBBBBBBBBBBBBBBBBBBB'
const RL = '?rlkey=ccccccccccccccccccccc'
eq('dropbox folder', parseShareLink(DBX + RL).source, 'dropbox')
eq('  link_key', parseShareLink(DBX + RL).linkKey, 'aaaaaaaaaaaaaaaaaaaaa')
eq('  secure_hash', parseShareLink(DBX + RL).secureHash, 'BBBBBBBBBBBBBBBBBBBBBB')
eq('  rlkey', parseShareLink(DBX + RL).rlkey, 'ccccccccccccccccccccc')
// st= is a short-lived token and dl=/e= are view preferences; the same folder must compare equal.
eq('volatile params dropped',
   parseShareLink(DBX + RL + '&st=zzzz&e=1&dl=0').normalized,
   parseShareLink(DBX + RL).normalized)
eq('missing rlkey is named', /rlkey/.test(parseShareLink(DBX).error), true)
eq('single file share', /one file/i.test(parseShareLink('https://www.dropbox.com/scl/fi/xxxxxxxxxxxxxxxxxxxx/A.mp4?rlkey=q').error), true)

const GID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345'
eq('drive folder', parseShareLink(`https://drive.google.com/drive/folders/${GID}`).folderId, GID)
eq('drive /u/0/ form', parseShareLink(`https://drive.google.com/drive/u/0/folders/${GID}`).folderId, GID)
eq('drive ?id= form', parseShareLink(`https://drive.google.com/open?id=${GID}`).folderId, GID)
eq('drive single file', /one Drive file/i.test(parseShareLink(`https://drive.google.com/file/d/${GID}/view`).error), true)
eq('drive home', /own Drive home/i.test(parseShareLink('https://drive.google.com/drive/my-drive').error), true)
eq('other host', /Dropbox, Google Drive and WeTransfer/.test(parseShareLink('https://box.com/s/x').error), true)

// Synthetic ids, same shapes as a real transfer: a 46-char transfer id and a 6-char hash.
const WT_ID = 'a'.repeat(26) + '20261013133236'.padStart(20, '0')
const WT = `https://wetransfer.com/downloads/${WT_ID}/abc123`
eq('wetransfer link', parseShareLink(WT).source, 'wetransfer')
eq('  transfer id', parseShareLink(WT).transferId, WT_ID)
eq('  security hash', parseShareLink(WT).securityHash, 'abc123')
eq('  tracking params dropped',
   parseShareLink(WT + '?t_exp=1797082357&t_lsid=x&t_network=link&t_rid=Z29v&t_s=download_link').normalized, WT)
eq('  emailed form keeps its recipient',
   parseShareLink(`https://wetransfer.com/downloads/${WT_ID}/${'b'.repeat(30)}/abc123`).recipientId, 'b'.repeat(30))
eq('  www. is fine', parseShareLink(`https://www.wetransfer.com/downloads/${WT_ID}/abc123`).source, 'wetransfer')
eq('wetransfer, not a transfer', /not to a transfer/.test(parseShareLink('https://wetransfer.com/pricing').error), true)
eq('we.tl short link is accepted as-is', parseShareLink('https://we.tl/t-AbCdEf0123').normalized, 'https://we.tl/t-AbCdEf0123')
eq('we.tl, not a transfer', parseShareLink('https://we.tl/').source, null)
eq('not a url', parseShareLink('nonsense').source, null)
eq('empty never throws', parseShareLink('').source, null)
eq('null never throws', parseShareLink(null).source, null)
eq('uppercase host + whitespace still parses', parseShareLink('  HTTPS://WWW.DROPBOX.COM/scl/fo/aaaaaaaaaaaaaaaaaaaaa/BBBBBBBBBBBBBBBBBBBBBB?rlkey=k  ').source, 'dropbox')

group('showFolderName round-trips through parseShowFolderName')
// A drift between these two means the portal creates folders that discovery then cannot see.
eq('with city', showFolderName({ month: 10, year: 2025, city: 'NYC' }), 'October 2025 (NYC)')
eq('without city', showFolderName({ month: 11, year: 2024, city: '' }), 'November 2024')
eq('city is trimmed', showFolderName({ month: 3, year: 2026, city: '  SF  ' }), 'March 2026 (SF)')
eq('bad month', showFolderName({ month: 13, year: 2026, city: 'NYC' }), null)
eq('no year', showFolderName({ month: 1, city: 'NYC' }), null)
for (const decl of [
  { month: 6, year: 2026, city: 'NY Tech Week' },
  { month: 1, year: 2025, city: 'NYC' },
  { month: 12, year: 2025, city: null },
]) {
  const round = parseShowFolderName(showFolderName(decl))
  eq(`round-trip ${showFolderName(decl)}`,
     { month: round.month, year: round.year, city: round.city },
     { month: decl.month, year: decl.year, city: decl.city || null })
}

group('findShowCollision — June 2026 proves the city is the only discriminator')
const SHOWS_FIX = [
  { folderId: 'a', label: 'June 2026', month: 6, year: 2026, city: 'SF' },
  { folderId: 'b', label: 'June 2026', month: 6, year: 2026, city: 'NY Tech Week' },
  { folderId: 'c', label: 'June 2026', month: 6, year: 2026, city: 'AvocaRilla' },
  { folderId: 'd', label: 'March 2026', month: 3, year: 2026, city: 'NYC' },
]
eq('exact match blocks', findShowCollision(SHOWS_FIX, { month: 3, year: 2026, city: 'NYC' }).kind, 'exact')
eq('alias still matches', findShowCollision(SHOWS_FIX, { month: 3, year: 2026, city: 'ny' }).kind, 'exact')
eq('case/spacing still matches', findShowCollision(SHOWS_FIX, { month: 6, year: 2026, city: 'ny tech WEEK' }).kind, 'exact')
eq('same month, new city warns', findShowCollision(SHOWS_FIX, { month: 6, year: 2026, city: 'Austin' }).kind, 'sameMonth')
eq('  and names the others', findShowCollision(SHOWS_FIX, { month: 6, year: 2026, city: 'Austin' }).shows.length, 3)
eq('empty slot is clean', findShowCollision(SHOWS_FIX, { month: 10, year: 2025, city: 'NYC' }), null)
eq('city alias normalises', normalizeCity('new york'), 'NYC')
eq('unknown city is kept verbatim', normalizeCity('AvocaRilla'), 'AvocaRilla')
eq('blank city', normalizeCity(''), '')

// ---------------------------------------------------------------- report --

console.log(`\n${pass} passed, ${fail.length} failed`)
if (fail.length) {
  for (const f of fail) console.log(`  ✗ ${f}`)
  process.exit(1)
}
