#!/usr/bin/env node
// Checks for the reel rules shared by the editor, the Apps Script backend and the GitHub runner —
// the parts that decide what ends up burned into a finished clip.
//
//   node videoreview/test-reel.mjs

import {
  FONTS, FONT_IDS, HEX_RE, DEFAULT_STYLE, LIMITS, hexToAss, assEscape, fillTimings, autoBreaks, groups,
  wordsInRanges, cutPauses, wantsCutPauses, toOutputTime, totalLength, captionSlices, captionAt,
  legacyKey, clampStyle, buildAss, ffmpegArgs, nextVersionName, rangesChanged, followTrack, cropAt, cropExpr, captionHalfWidth,
} from './reel.js'
import { existsSync, readFileSync } from 'node:fs'

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
const near = (a, b) => Math.abs(a - b) < 1e-6
const throws = fn => { try { fn(); return false } catch { return true } }
const group = name => console.log(`\n${name}`)

// The joke from the agreed mockup, with its real-looking timings (tape seconds).
const W = [
  ["I'm", 0, .18], ['a', .18, .28], ['software', .28, .74], ['engineer,', .74, 1.3], ['which', 1.45, 1.62], ['means', 1.62, 1.9],
  ['I', 2, 2.08], ['spend', 2.08, 2.4], ['eight', 2.4, 2.66], ['hours', 2.66, 2.98], ['a', 2.98, 3.06], ['day', 3.06, 3.4],
  ['asking', 3.6, 3.98], ['a', 3.98, 4.06], ['robot', 4.06, 4.5], ['to', 4.5, 4.6], ['do', 4.6, 4.78], ['my', 4.78, 4.96], ['job,', 4.96, 5.4],
  ['and', 6.1, 6.24], ['then', 6.24, 6.44], ['I', 6.44, 6.52], ['take', 6.7, 7], ['credit', 7, 7.4], ['for', 7.4, 7.56], ['it.', 7.56, 7.9],
].map(([text, s, e]) => ({ text, s, e, aligned: true }))

group('fonts')
eq('FONT_IDS is the FONTS order', FONTS.map(f => f.id), FONT_IDS)
for (const f of FONTS) ok(`${f.id}: ${f.file} is committed`, existsSync(new URL(`./fonts/${f.file}`, import.meta.url)))
eq('ASS names are the files\' own family names (libass matches on these)',
  FONTS.map(f => f.assName), ['Bebas Neue', 'Anton', 'Archivo Black', 'Montserrat Thin ExtraBold', 'Azeret Mono Thin'])
eq('default font is the closest match to the current reels', DEFAULT_STYLE.font, 'bebas')

group('hex -> ASS colour (&H00BBGGRR&)')
eq('#FFFF00', hexToAss('#FFFF00'), '&H0000FFFF&')
eq('brand yellow, no #', hexToAss('ffff82'), '&H0082FFFF&')
eq('pure red lands in the last byte', hexToAss('#ff0000'), '&H000000FF&')
eq('pure blue lands in the first byte', hexToAss('#0000FF'), '&H00FF0000&')
ok('3-digit hex refused', throws(() => hexToAss('#FFF')))
ok('a name refused', throws(() => hexToAss('red')))
ok('an override smuggled into a colour refused', throws(() => hexToAss('#FFFFFF}{\\b1')))
ok('HEX_RE anchored', !HEX_RE.test('x#FFFFFF') && !HEX_RE.test('#FFFFFFF'))

group('caption text is data, never ASS markup')
const esc = assEscape('{\\b1}hi\\N  there')
ok('no braces or backslashes survive', !/[{}\\]/.test(esc))
eq('readable', esc, '(∖b1)hi∖N there')

group('fillTimings — WhisperX cannot time "2014" or "$13"')
const filled = fillTimings([{ text: 'in', s: 0, e: .2 }, { text: '2014' }, { text: 'we', s: 1, e: 1.2 }])
eq('the untimed word fills the gap', [filled[1].s, filled[1].e, filled[1].aligned], [.2, 1, false])
const edges = fillTimings([{ text: '$13' }, { text: 'bucks', s: 1, e: 1.3 }, { text: '2014' }, { text: 'lol', s: null, e: undefined }])
ok('every word has numbers', edges.every(w => Number.isFinite(w.s) && Number.isFinite(w.e) && w.e >= w.s))
ok('monotonic', edges.every((w, i) => i === 0 || w.s >= edges[i - 1].s))
ok('leading untimed word ends where the next begins', near(edges[0].e, 1))
ok('trailing untimed words get real slots', edges[2].e - edges[2].s >= 0.2 && edges[3].s >= edges[2].e)
eq('timed words are left alone', [edges[1].s, edges[1].e, edges[1].aligned], [1, 1.3, true])

group('autoBreaks — a sane start, people will regroup')
const auto = autoBreaks(W)
const autoGroups = groups(W, auto)
ok('no group longer than 3 words', autoGroups.every(g => g.length <= 3))
ok('breaks after "engineer,"', auto.includes(4))
ok('breaks at the 0.7s pause before "and"', auto.includes(19))
ok('no group spans a pause of 0.5s or more', autoGroups.every(g => g.every((i, k) => k === 0 || W[i].s - W[g[k - 1]].e < 0.5)))
eq('groups cover every word once, in order', autoGroups.flat(), W.map((_, i) => i))
eq('groups() ignores out-of-range and duplicate breaks', groups(W.slice(0, 4), [0, 2, 2, 9]), [[0, 1], [2, 3]])

group('wordsInRanges / cutPauses')
const cut = [{ s: 0, e: 2.5 }, { s: 3.5, e: 8 }] // "remove 2.5-3.5" drops eight/hours/a
eq('a word inside a removed gap is dropped', wordsInRanges(W, cut).map((k, i) => k ? null : W[i].text).filter(Boolean), ['eight', 'hours', 'a', 'day'])
ok('wantsCutPauses: column D advice', wantsCutPauses('cut pauses') && wantsCutPauses('Please remove the long pauses.') && wantsCutPauses('tighten pauses'))
ok('wantsCutPauses: not just any note', !wantsCutPauses('pause before the tag') && !wantsCutPauses('cut 9:45 - 9:52'))
const quiet = [{ s: 5.45, e: 6.05 }]          // dead air between "job," and "and"
const laugh = []                               // the 0.18s before "take" is nothing; nothing else is quiet
const tightened = cutPauses([{ s: 0, e: 8 }], W, quiet)
eq('cuts only the quiet part of the gap, keeping a little air', tightened.map(r => [r.s, r.e].map(x => +x.toFixed(2))), [[0, 5.6], [5.9, 8]])
eq('a gap that is not silence (a laugh) is left alone', cutPauses([{ s: 0, e: 8 }], W, laugh), [{ s: 0, e: 8 }])
eq('range edges are never trimmed', cutPauses([{ s: 0, e: 8 }], W, [{ s: 7.9, e: 8 }]), [{ s: 0, e: 8 }])

group('time remapping across cuts')
const two = [{ s: 158.4, e: 176 }, { s: 195.2, e: 210 }]
ok('start of the second range', near(toOutputTime(195.2, two), 17.6))
ok('inside a removed gap clamps to the join', near(toOutputTime(180, two), 17.6))
ok('before everything is 0', toOutputTime(100, two) === 0)
ok('after everything is the total', near(toOutputTime(999, two), totalLength(two)))
ok('totalLength', near(totalLength(two), 32.4))

group('caption slices — what the preview paints and the export burns')
const hand = [4, 8, 12, 15, 19, 22]
const slices = captionSlices(W, hand)
ok('nothing shows before the first word', slices[0].s === 0 && !captionAt(slices, -0.1))
ok('at most one highlighted word, and it is in the shown group', slices.every(sl => sl.active === null || sl.words.includes(sl.active)))
eq('"it." is highlighted while spoken', W[captionAt(slices, 7.6).active].text, 'it.')
eq('the punchline group stays together', captionAt(slices, 7.6).words.map(i => W[i].text), ['take', 'credit', 'for', 'it.'])
ok('a group lingers 0.6s after its last word, then clears', captionAt(slices, 8.4) && !captionAt(slices, 8.6))
ok('slices never overlap', slices.every((sl, i) => i === 0 || sl.s >= slices[i - 1].e - 1e-9))
const kept = captionSlices(W, hand, wordsInRanges(W, cut))
ok('dropped words never appear on screen', kept.every(sl => sl.words.every(i => !['eight', 'hours', 'day'].includes(W[i].text))))

group('legacyKey — finds a typed row again without writing to it')
const row = { name: 'Pete', start: '2:38', end: '3:30', granular: '2:38 - 2:56, 3:15 - 3:30' }
ok('shape', /^row-[0-9a-f]{8}$/.test(legacyKey(row)))
eq('stable across stray whitespace', legacyKey({ ...row, granular: ' 2:38 - 2:56,  3:15 - 3:30 ' }), legacyKey(row))
ok('changes when the request changes', legacyKey({ ...row, end: '3:31' }) !== legacyKey(row))

group('rangesChanged — a request edited after its draft exists')
ok('same ranges', !rangesChanged(two, two.map(r => ({ ...r }))))
ok('different end', rangesChanged(two, [two[0], { s: 195.2, e: 211 }]))

group('clampStyle')
eq('garbage falls back to defaults', clampStyle({ font: 'comic-sans', fill: 'red', size: 9999, y: -4, crop: 'x' }),
  { ...DEFAULT_STYLE, size: LIMITS.size[1], y: LIMITS.y[0] })
eq('highlight can be switched off', clampStyle({ highlight: null }).highlight, null)

group('buildAss')
const draft = { words: W, breaks: hand, ranges: [{ s: 0, e: 2.5 }, { s: 3.5, e: 8.4 }], style: { ...DEFAULT_STYLE } }
const ass = buildAss(draft)
ok('1080x1920 canvas', /PlayResX: 1080/.test(ass) && /PlayResY: 1920/.test(ass))
ok('style uses the font\'s own name', /^Style: Reel,Bebas Neue,\d+,&H00FFFFFF&/m.test(ass))
ok('current word highlighted in brand yellow', ass.includes('{\\c&H0082FFFF&}'))
ok('upper-cased like the current reels', ass.includes('TAKE CREDIT FOR'))
const times = [...ass.matchAll(/^Dialogue: 0,(\d+):(\d\d):(\d\d\.\d\d),(\d+):(\d\d):(\d\d\.\d\d)/gm)]
  .map(m => [+m[1] * 3600 + +m[2] * 60 + +m[3], +m[4] * 3600 + +m[5] * 60 + +m[6]])
ok('has dialogue', times.length > 5)
ok('every event inside the output timeline', times.every(([s, e]) => s >= 0 && e <= totalLength(draft.ranges) + 0.01 && e > s))
ok('cut words are not burned in', !/EIGHT|HOURS/.test(ass))
const sneaky = buildAss({ ...draft, words: W.map((w, i) => i === 0 ? { ...w, text: '{\\fs200}x' } : w) })
ok('a word cannot restyle the render', !sneaky.includes('{\\fs200}') && sneaky.includes('(∖FS200)X'))
ok('highlight off -> no colour overrides', !buildAss({ ...draft, style: { ...draft.style, highlight: null } }).includes('{\\c'))

group('ffmpegArgs')
const args = ffmpegArgs(draft, { input: 'http://127.0.0.1:8099/tape.mp4', ass: '/tmp/r/c.ass', fontsDir: '/tmp/r/fonts', icon: '/tmp/r/icon.png', bugFont: '/tmp/r/fonts/AzeretMono-Bold.ttf', out: '/tmp/r/out.mp4' })
ok('is an argv array', Array.isArray(args) && args.every(a => typeof a === 'string'))
eq('one input per range plus the bug', args.filter(a => a === '-i').length, 3)
const graph = args[args.indexOf('-filter_complex') + 1]
ok('the requested crop, centred (no track)', graph.includes("crop=w=ih*9/16:h=ih:x='(iw-ih*9/16)*(0.5)':y=0"))
ok('scaled to 1080x1920', graph.includes('scale=1080:1920'))
ok('ranges joined by concat', graph.includes('concat=n=2:v=1:a=1'))
ok('captions from the .ass with bundled fonts', graph.includes("ass=filename='/tmp/r/c.ass':fontsdir='/tmp/r/fonts'"))
ok('bug faded', graph.includes('colorchannelmixer=aa=0.7'))
ok('bug text exact', graph.includes("text='A.U'") && graph.includes("text='Tech Comedy Show'"))
ok('web-ready', args.includes('+faststart') && args.includes('yuv420p') && args.includes('libx264'))
ok('a path with a quote is refused', throws(() => ffmpegArgs(draft, { input: 'x', ass: "/tmp/it's.ass", fontsDir: '/f', icon: '/i', bugFont: '/b', out: '/o' })))

group('performer tracking')
// A performer walking left to right across 16:9 over 20 s, sampled at 4 fps, with a poster face
// fixed at the far right, an audience head bottom-left, and a few frames where nobody is found.
const walk = Array.from({ length: 81 }, (_, i) => {
  const t = 100 + i / 4
  const cx = 0.2 + 0.6 * (i / 80)
  const faces = [
    { cx: 0.92, cy: 0.3, w: 0.03, h: 0.05, score: 0.9 },          // poster
    { cx: 0.1, cy: 0.9, w: 0.06, h: 0.08, score: 0.8 },           // front row
  ]
  if (i % 9 !== 4) faces.push({ cx, cy: 0.35, w: 0.05, h: 0.09, score: 0.85 })
  return { t, faces }
})
const track = followTrack(walk, 16 / 9)
ok('a track comes back', Array.isArray(track) && track.length >= 2)
ok('keyframes are simplified', track.length < walk.length / 2, `${track.length} keyframes`)
ok('follows the performer left to right', cropAt(track, 100.5) < 0.2 && cropAt(track, 119.5) > 0.8,
  `${cropAt(track, 100.5).toFixed(2)} -> ${cropAt(track, 119.5).toFixed(2)}`)
ok('never jumps to the poster at the start', cropAt(track, 100) < 0.3)
ok('stays in [0, 1]', track.every(k => k.p >= 0 && k.p <= 1))
const steps = track.slice(1).map((k, i) => Math.abs(k.p - track[i].p) / (k.t - track[i].t))
ok('moves smoothly (no jump faster than a frame-width a second)', steps.every(v => v < 1.2), Math.max(...steps).toFixed(2))
const still = followTrack(Array.from({ length: 40 }, (_, i) => ({ t: i / 4, faces: [{ cx: 0.5 + (i % 2 ? 0.01 : -0.01), cy: 0.4, w: 0.05, h: 0.09, score: 0.9 }] })))
ok('a performer standing still gets a still camera', still.length === 2 && Math.abs(still[0].p - still[1].p) < 1e-3)
eq('no faces at all -> no track', followTrack([{ t: 0, faces: [] }, { t: 1, faces: [] }]), null)
eq('cropAt without a track uses the fallback', cropAt(null, 5, 0.3), 0.3)
ok('cropExpr is a constant for a still camera', /^[\d.]+$/.test(cropExpr(still, { s: 0, e: 5 })))
const ex = cropExpr(track, { s: 105, e: 110 })
ok('cropExpr is piecewise in t, starting from range-local time 0', ex.startsWith('if(lt(t,') && !/t-10\d/.test(ex), ex.slice(0, 60))
const evalExpr = (e, t) => Function('t', 'const lt=(a,b)=>a<b, iff=(c,a,b)=>c?a:b; return ' + e.replace(/if\(/g, 'iff('))(t)
ok('cropExpr agrees with cropAt across the range', [0, 1.3, 2.5, 4.9].every(u => Math.abs(evalExpr(ex, u) - cropAt(track, 105 + u)) < 1e-3))
const shifted = track.map(k => ({ t: k.t - 100, p: k.p }))  // onto the fixture draft's 0-8.4 s
const tracked = ffmpegArgs({ ...draft, track: shifted }, { input: 'x', ass: '/a.ass', fontsDir: '/f', icon: '/i.png', bugFont: '/b.ttf', out: '/o.mp4' })
ok('export follows the track when following', tracked[tracked.indexOf('-filter_complex') + 1].includes("x='(iw-ih*9/16)*(if(lt(t,"))
const fixed = ffmpegArgs({ ...draft, track: shifted, style: { ...draft.style, follow: false, crop: 0.25 } }, { input: 'x', ass: '/a.ass', fontsDir: '/f', icon: '/i.png', bugFont: '/b.ttf', out: '/o.mp4' })
ok('and the fixed frame when not', fixed[fixed.indexOf('-filter_complex') + 1].includes("x='(iw-ih*9/16)*(0.25)'"))

group('dragged captions and bug')
ok('centred captions wrap within the frame less 6% a side', Math.abs(captionHalfWidth(50) - 0.44) < 1e-9)
ok('dragged toward an edge, the box narrows so text stays inside', Math.abs(captionHalfWidth(30) - 0.24) < 1e-9 && captionHalfWidth(30) === captionHalfWidth(70))
ok('never collapses to nothing', captionHalfWidth(1) >= 0.08)
const moved = buildAss({ ...draft, style: { ...draft.style, x: 30, y: 20 } })
ok('a dragged caption is positioned where it was dropped', moved.includes('{\\pos(324,384)}'), (moved.match(/\\pos\([^)]*\)/) || [])[0])
const side = Math.round((1080 - 2 * 0.24 * 1080) / 2)
ok('and wraps within its narrower box (event margins)', new RegExp(`^Dialogue: 0,[^,]+,[^,]+,Reel,,${side},${side},0,,`, 'm').test(moved))
ok('centred by default', buildAss(draft).includes('{\\pos(540,1114)}'))
const g0 = ffmpegArgs(draft, { input: 'x', ass: '/a.ass', fontsDir: '/f', icon: '/i.png', bugFont: '/b.ttf', out: '/o.mp4' })
const graph0 = g0[g0.indexOf('-filter_complex') + 1]
ok('default bug: a little in from the corner', graph0.includes('overlay=x=994-w:y=115'), (graph0.match(/overlay=[^[]*/) || [])[0])
const g1 = ffmpegArgs({ ...draft, style: { ...draft.style, bugX: 50, bugY: 80 } }, { input: 'x', ass: '/a.ass', fontsDir: '/f', icon: '/i.png', bugFont: '/b.ttf', out: '/o.mp4' })
const graph1 = g1[g1.indexOf('-filter_complex') + 1]
ok('a dragged bug moves logo and text together', graph1.includes('overlay=x=540-w:y=1536') && graph1.includes('x=432-tw:y=1544'))
eq('positions clamp into the frame', (({ x, bugX, bugY }) => [x, bugX, bugY])(clampStyle({ x: 2, bugX: 120, bugY: -5 })), [LIMITS.x[0], LIMITS.bugX[1], LIMITS.bugY[0]])

group('nextVersionName')
eq('first export', nextVersionName('Pete', 158.4, []), 'Pete - 2m38 reel v1.mp4')
eq('never overwrites', nextVersionName('Pete', 158.4, ['Pete - 2m38 reel v1.mp4', 'Pete - 2m38 reel v3.mp4', 'Other.mp4']), 'Pete - 2m38 reel v4.mp4')
eq('unsafe filename characters dropped', nextVersionName('A/B: "x"', 5, []), 'AB x - 0m05 reel v1.mp4')

group('Code.gs carries byte-identical literals')
const gs = readFileSync(new URL('./apps-script/Code.gs', import.meta.url), 'utf8')
const reelSrc = readFileSync(new URL('./reel.js', import.meta.url), 'utf8')
eq('REEL_FONT_IDS', (gs.match(/var REEL_FONT_IDS = (\[.*?\]);/) || [])[1], (reelSrc.match(/export const FONT_IDS = (\[.*?\])/) || [])[1])
eq('REEL_HEX_RE', (gs.match(/var REEL_HEX_RE = (\/.*?\/);/) || [])[1], String(HEX_RE))
eq('REEL_DEFAULT_STYLE', (gs.match(/var REEL_DEFAULT_STYLE = (\{.*?\});/) || [])[1], (reelSrc.match(/export const DEFAULT_STYLE = (\{.*?\})/) || [])[1])
eq('REEL_LIMITS', (gs.match(/var REEL_LIMITS = (\{.*?\});/) || [])[1], (reelSrc.match(/export const LIMITS = (\{.*?\})/) || [])[1])

// Run the .gs functions themselves, so the backend and the browser can't quietly disagree.
const gsFn = (...names) => new Function(
  gs.match(/var REEL_[A-Z_]+ = .*?;/g).join('\n') + '\n' +
  names.map(n => gs.slice(gs.indexOf(`function ${n}(`), gs.indexOf('\n}\n', gs.indexOf(`function ${n}(`)) + 2)).join('\n') +
  `\nreturn { ${names.join(', ')} }`)()
const G = gsFn('hexToAssGs', 'legacyKeyGs', 'validateReelEditGs', 'validateRangesGs')
for (const hex of ['#FFFF00', 'ffff82', '#123456']) eq(`hexToAssGs ${hex}`, G.hexToAssGs(hex), hexToAss(hex))
eq('hexToAssGs refuses junk', G.hexToAssGs('#FFF'), null)
eq('legacyKeyGs === legacyKey', G.legacyKeyGs(row), legacyKey(row))

const stored = { words: W, breaks: auto, ranges: [{ s: 0, e: 8 }], source: { span: { s: 0, e: 8 } }, style: DEFAULT_STYLE }
const edit = { breaks: hand, words: W.map(w => w.text), style: { ...DEFAULT_STYLE, fill: '#ffff82' }, ranges: [{ s: 0, e: 8 }] }
const good = G.validateReelEditGs(edit, stored)
ok('a normal edit passes', good.ok)
eq('colours converted inside the route', good.ok && good.style.ass.fill, '&H0082FFFF&')
eq('highlight off survives', G.validateReelEditGs({ ...edit, style: { ...edit.style, highlight: null } }, stored).style.ass.highlight, null)
const refuse = (label, e) => ok(label, G.validateReelEditGs(e, stored).ok === false)
refuse('unknown key', { ...edit, shell: 'rm -rf /' })
refuse('unknown style key', { ...edit, style: { ...edit.style, fontfile: '/etc/passwd' } })
refuse('bug position must be a number', { ...edit, style: { ...edit.style, bugX: 'far' } })
ok('a caption dragged off the frame is clamped back', G.validateReelEditGs({ ...edit, style: { ...edit.style, x: 3 } }, stored).style.x === LIMITS.x[0])
refuse('follow must be a boolean', { ...edit, style: { ...edit.style, follow: 'yes' } })
ok('follow off survives', G.validateReelEditGs({ ...edit, style: { ...edit.style, follow: false } }, stored).style.follow === false)
refuse('font not on the list', { ...edit, style: { ...edit.style, font: 'Comic Sans' } })
refuse('3-digit colour', { ...edit, style: { ...edit.style, fill: '#FFF' } })
refuse('word count changed', { ...edit, words: edit.words.slice(1) })
refuse('word too long', { ...edit, words: edit.words.map((w, i) => i ? w : 'x'.repeat(41)) })
refuse('a word that is not a string (timing smuggled in)', { ...edit, words: edit.words.map((w, i) => i ? w : { text: w, s: 9 }) })
refuse('breaks unsorted', { ...edit, breaks: [8, 4] })
refuse('break out of range', { ...edit, breaks: [0, 4] })
refuse('trim more than 5s past the request', { ...edit, ranges: [{ s: 0, e: 13.5 }] })
refuse('inverted range', { ...edit, ranges: [{ s: 5, e: 4 }] })
ok('size clamped, not refused', G.validateReelEditGs({ ...edit, style: { ...edit.style, size: 500 } }, stored).style.size === LIMITS.size[1])
ok('validateRangesGs refuses > 180s', !G.validateRangesGs([{ s: 0, e: 181 }]).ok)
ok('validateRangesGs refuses 11 ranges', !G.validateRangesGs(Array.from({ length: 11 }, (_, i) => ({ s: i * 2, e: i * 2 + 1 }))).ok)
ok('validateRangesGs sorts', G.validateRangesGs([{ s: 5, e: 6 }, { s: 1, e: 2 }]).ranges[0].s === 1)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
