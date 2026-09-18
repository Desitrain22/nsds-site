#!/usr/bin/env node
// Assertions for videoreview/ingest.js — the source -> destination rules.
//
//   node videoreview/test-ingest.mjs
//
// Separate from test.mjs only because the videoreview refactor is in flight; fold these groups
// into it once that lands. Zero dependencies, same eq/group style as test.mjs.

import { classify, routeAll, performerFrom, extOf, parseShareLink, findShowCollision, normalizeCity } from './ingest.js'
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
eq('other host', /Dropbox and Google Drive/.test(parseShareLink('https://wetransfer.com/x').error), true)
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
