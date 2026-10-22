#!/usr/bin/env node
// Checks for the carousel rules: default pacing, line edits and slide layout.
//
//   node videoreview/test-carousel.mjs

import { DEFAULT_CAP, lineText, splitLines, layout, splitLine, joinLines, deleteLine,
  frameBox, clampCrop, cropPixels, isSoft, panCrop, zoomCrop, moveCap, scoreFrames, rankCandidates, defaultStills, nextCarouselName, linkLabels, CAROUSEL_DEFAULT_STYLE } from './carousel.js'
import { nextVersionName } from './reel.js'
import { readFileSync } from 'node:fs'
import { SLIDE_CSS, imgBox, slideHtml } from './carousel-slide.js'

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

// Sentences timed at 0.3 s per word with a 0.6 s gap between them.
const mk = (...sentences) => { let t = 0; const out = []
  sentences.forEach(s => { s.split(' ').forEach(text => { out.push({ text, s: t, e: t + .3, aligned: true }); t += .3 }); t += .6 })
  return out }
const all = ws => [{ s: 0, e: ws[ws.length - 1].e }]
const texts = (ws, ls) => ls.map(l => lineText(ws, l.w))

group('splitLines')
const W7 = mk('I work in AI.', 'My mom asked for help.', 'With her printer.', 'I said no.', 'Wrong kind of AI.', 'She said all AI is printers.', "She's not wrong.")
eq('7 sentences -> 6 lines: the shortest adjacent pair (earliest on a tie) is joined', texts(W7, splitLines(W7, all(W7))),
  ['I work in AI.', 'My mom asked for help.', 'With her printer. I said no.', 'Wrong kind of AI.', 'She said all AI is printers.', "She's not wrong."])
const W5 = mk('One.', 'Two two.', 'This is the longest sentence, by far, in here.', 'Four.', 'Five five.')
eq('5 sentences -> 6 lines: the longest is split at the comma nearest its middle', texts(W5, splitLines(W5, all(W5))),
  ['One.', 'Two two.', 'This is the longest sentence,', 'by far, in here.', 'Four.', 'Five five.'])
const LONG = mk('So I finally got my standup into a pull request, and my manager approved it in four seconds flat.', 'Wow.', 'Ok.')
eq('a sentence over 70 chars breaks at its comma', texts(LONG, splitLines(LONG, all(LONG))).slice(0, 2),
  ['So I finally got my standup into a pull request,', 'and my manager approved it in four seconds flat.'])
// no comma: one 0.8 s pause after "standup" -> breaks there
const P = mk('So I finally got my standup into a pull request and my manager approved it in four seconds flat.', 'Wow.', 'Ok.', 'Fine.')
P.slice(6).forEach(w => { w.s += .8; w.e += .8 })
eq('no comma: breaks at the longest pause >= 0.5 s', lineText(P, splitLines(P, all(P))[0].w), 'So I finally got my standup')
ok('every line <= 70 chars, count % 3 === 0', [W7, W5, LONG].every(ws => { const ls = splitLines(ws, all(ws)); return ls.length % 3 === 0 && texts(ws, ls).every(t => t.length <= 70) }))
const cut = splitLines(W7, [{ s: 0, e: W7[3].e }, { s: W7[9].s, e: W7[W7.length - 1].e }])
ok('splitLines: words outside the ranges never appear', cut.every(l => l.w[0] >= 9 || l.w[1] <= 4))
eq('a Line is { w, text, cap, still } in that order, cap defaults to DEFAULT_CAP, still null',
  Object.keys(splitLines(W7, all(W7))[0]), ['w', 'text', 'cap', 'still'])
eq('default cap and still', [splitLines(W7, all(W7))[0].cap, splitLines(W7, all(W7))[0].still], [DEFAULT_CAP, null])

group('layout')
const lines = n => Array.from({ length: n }, (_, i) => ({ w: [i, i + 1], text: `l${i}`, cap: DEFAULT_CAP, still: null }))
eq('32 lines -> 10 slides, 2 in reserve, no fillers', [layout(lines(32)).slides.length, layout(lines(32)).reserve.length, layout(lines(32)).fillerCount], [10, 2, 0])
const one = layout(lines(1))
eq('layout: a one-line clip is one slide with two fillers', [one.slides.length, one.slides[0].map(p => p.kind)], [1, ['line', 'filler', 'filler']])
eq('a stored filler is used as-is', layout(lines(2), [{ text: 'ha', cap: DEFAULT_CAP, still: null }]).slides[0][2].text, 'ha')

group('line edits')
const E = mk('I told my mom I work in AI.')
const el = [{ w: [0, 8], text: 'I told my mom I work in AI.', cap: DEFAULT_CAP, still: null }]
const sp = splitLine(el, E, 0, 'I told my mom'.length)
eq('split at the caret: text and words both split', [sp.map(l => l.text), sp.map(l => l.w)], [['I told my mom', 'I work in AI.'], [[0, 4], [4, 8]]])
eq('split of a one-word line is a no-op', splitLine([{ w: [0, 1], text: 'I', cap: DEFAULT_CAP, still: null }], E, 0, 0).length, 1)
eq('join: words concatenate, text joined with a space', joinLines(sp, E, 0)[0], { ...el[0], still: null })
eq('delete removes one line', deleteLine(sp, 0).map(l => l.text), ['I work in AI.'])


// Framing assertions are exact to 1e-4.
const near = (a, b) => Math.abs(a - b) < 1e-4

group('framing')
const A = 1600 / 1020, face = { cx: (550.4 + 101.5) / 1600, cy: 259.5 / 1020, w: 203 / 1600, h: 264 / 1020 }
const fb = frameBox(face, A, 1020)
ok('the brainstorm spike photo frames as it did', near(fb.cx, .4554) && near(fb.cy, .30204) && near(fb.h, .59529))
ok('never below 450 master px', near(frameBox({ cx: .5, cy: .4, w: .03, h: 100 / 2160 }, 16 / 9, 2160).h, 450 / 2160))
ok('never more than covers the panel', near(frameBox({ cx: .5, cy: .5, w: .3, h: .5 }, 16 / 9, 1080).h, (16 / 9) / 2.4))
const cc = clampCrop({ cx: 0, cy: 0, h: 2 }, 16 / 9)
ok('clampCrop pulls a crop back inside', near(cc.h, .740741) && near(cc.cx, .5) && near(cc.cy, .37037))
eq('cropPixels of the full frame', cropPixels({ cx: .5, cy: .5, h: 1 }, 2400, 1000), { x: 0, y: 0, w: 2400, h: 1000 })
eq('isSoft at 216 px / 453.6 px', [isSoft({ h: .1 }, 2160), isSoft({ h: .21 }, 2160)], [true, false])
ok('dragging right by 10% of the panel shows more of the left', near(panCrop({ cx: .5, cy: .5, h: .5 }, 108, 0, 2.4).cx, .45))
ok('zoom 2x about the centre halves h', near(zoomCrop({ cx: .5, cy: .5, h: .6 }, 2, .5, .5, 2.4).h, .3))
ok('zoom stops at maxCropH / 4', near(zoomCrop({ cx: .5, cy: .5, h: .3 }, 10, .5, .5, 2.4).h, .25))
eq('moveCap clamps to the panel', moveCap({ x: 50, y: 94 }, 1080, 1000), { x: 90, y: 100 })

group('scoring and stills')
const f = (t, score, sharp, h = .2) => ({ t, fileId: `id${t}`, faces: [{ cx: .5, cy: .4, w: .1, h, score, sharp }] })
const sc = scoreFrames([f(0, .9, 300), f(.25, .9, 30), f(.5, .9, 300, .05), { t: .75, fileId: 'n', faces: [] }])
ok('sharper beats blurrier', sc[0].score > sc[1].score)
ok('a much smaller face than usual is penalised', sc[2].score < sc[0].score)
eq('no face -> score 0, face null', [sc[3].score, sc[3].face], [0, null])
const fr = [[0, .9], [.25, .95], [.5, .2], [.75, .8], [1, .7]].map(([t, score]) => ({ t, fileId: `i${t}`, score, face: { cx: .5, cy: .4, w: .1, h: .2 } }))
eq('candidates: best first, >= 0.5 s apart', rankCandidates(fr, { s: 0, e: 1 }).map(x => x.t), [.25, .75])
const WS = [['One', 0, .5], ['two.', .5, 1], ['Three', 1, 1.5], ['four.', 1.5, 2]].map(([text, s, e]) => ({ text, s, e, aligned: true }))
const two = [{ w: [0, 2], text: 'One two.', cap: DEFAULT_CAP, still: null }, { w: [2, 4], text: 'Three four.', cap: DEFAULT_CAP, still: null }]
const fc = { cx: .5, cy: .4, w: .1, h: .2 }
const shared = [{ t: .5, fileId: 'a', score: .4, face: fc }, { t: 1, fileId: 'b', score: .99, face: fc }, { t: 1.5, fileId: 'c', score: .5, face: fc }]
eq('the next line avoids the frame the line above took', defaultStills(two, WS, shared, 16 / 9, 2160).map(l => l.still.t), [1, 1.5])
const blind = defaultStills(two, WS, [{ t: .1, fileId: 'z', score: 0, face: null }], 16 / 9, 2160)
ok('defaultStills: no faces anywhere falls back to centre crops', blind.every(l => l.still.noFace && near(l.still.crop.h, (16 / 9) / 2.4) && l.still.t === .1))

group('naming and links')
eq('carousel versions count only carousel folders', nextCarouselName('Kaz', 158, ['Kaz - 2m38 carousel v1', 'Kaz - 2m38 reel v3.mp4']), 'Kaz - 2m38 carousel v2')
eq('reel naming unchanged', nextVersionName('Kaz', 158, ['Kaz - 2m38 reel v3.mp4']), 'Kaz - 2m38 reel v4.mp4')
eq('folder links are carousels', linkLabels(['https://drive.google.com/file/d/a/view', 'https://drive.google.com/file/d/b/view', 'https://drive.google.com/drive/folders/c']),
  ['Finished clip 1 ↗', 'Finished clip 2 ↗', 'View carousel ↗'])
eq('a single file keeps today\'s label', linkLabels(['https://drive.google.com/file/d/a/view']), ['Finished clip ↗'])

group('slide markup')
eq('imgBox of a full-frame crop', imgBox({ cx: .5, cy: .5, h: 1 }, 2.4), { width: 100, left: 0, top: 0 })
const ib = imgBox({ cx: .5, cy: .5, h: .5 }, 2.4)
ok('imgBox of a 2x crop doubles and centres', near(ib.width, 200) && near(ib.left, -50) && near(ib.top, -50))
const P3 = [{ kind: 'line', index: 0, text: '</div><script>alert(1)</script> “Crypto Andrew” 🙃', cap: { x: 50, y: 94 }, still: null },
  { kind: 'line', index: 1, text: 'b', cap: { x: 30, y: 60 }, still: null }, { kind: 'filler', index: 0, text: '', cap: { x: 50, y: 94 }, still: null }]
const html = slideHtml(P3, CAROUSEL_DEFAULT_STYLE, { images: [{ src: 'a.jpg' }, { src: 'b.jpg' }, { src: 'c.jpg' }], fonts: { caption: 'c.ttf', bug: 'b.ttf', icon: 'i.svg' } })
ok('slideHtml escapes caption text', !html.includes('<script>') && html.includes('&lt;/div&gt;&lt;script&gt;') && html.includes('“Crypto Andrew” 🙃'))
eq('three panels, two captions (the empty filler has none), one bug',
  [(html.match(/class="cz-panel"/g) || []).length, (html.match(/class="cz-cap"/g) || []).length, (html.match(/class="cz-bug"/g) || []).length], [3, 2, 1])
ok('the bug reads A.U / Tech Comedy Show', html.includes('A.U<br>Tech Comedy Show'))
ok('the caption sits where it was dragged', html.includes('left:30%') && html.includes('top:60%'))
ok('style colours are applied', html.includes('#2E1A42') && html.includes('#FFFFFF'))
ok('SLIDE_CSS rounds each wrapped line and balances wrapping', /box-decoration-break:\s*clone/.test(SLIDE_CSS) && /\.cz-cap\s*\{[^}]*text-wrap:\s*balance/.test(SLIDE_CSS) && /border-radius:\s*999px/.test(SLIDE_CSS))

ok('the caption is as wide as its text, so dragging cannot change the wrap', /\.cz-cap\s*\{[^}]*width:\s*max-content/.test(SLIDE_CSS))
ok('size is clamped to the limits', slideHtml(P3, { ...CAROUSEL_DEFAULT_STYLE, size: 500 }, { fonts: {} }).includes('font-size: 72px'))
ok('font urls cannot break out of the CSS string', !slideHtml(P3, CAROUSEL_DEFAULT_STYLE, { fonts: { caption: 'x");}</style>' } }).includes('x")'))

const gs = readFileSync(new URL('./apps-script/Code.gs', import.meta.url), 'utf8')
const gsFn = (...names) => new Function(
  gs.match(/var (REEL|CAROUSEL)_[A-Z_]+ = .*?;/g).join('\n') + '\n' +
  names.map(n => gs.slice(gs.indexOf(`function ${n}(`), gs.indexOf('\n}\n', gs.indexOf(`function ${n}(`)) + 2)).join('\n') +
  `\nreturn { ${names.join(', ')} }`)()

group('Code.gs carousel literals and storage')
const carSrc = readFileSync(new URL('./carousel.js', import.meta.url), 'utf8')
eq('CAROUSEL_LIMITS', (gs.match(/var CAROUSEL_LIMITS = (\{.*?\});/) || [])[1], (carSrc.match(/export const CAROUSEL_LIMITS = (\{.*?\})/) || [])[1])
eq('CAROUSEL_DEFAULT_STYLE', (gs.match(/var CAROUSEL_DEFAULT_STYLE = (\{.*?\});/) || [])[1], (carSrc.match(/export const CAROUSEL_DEFAULT_STYLE = (\{.*?\})/) || [])[1])
const M = gsFn('mergeProgressGs')
eq('stills is a carousel step', M.mergeProgressGs({ tape: 'done' }, { stills: 'running', tracking: 'done' }, ['tape', 'captions', 'stills']), { tape: 'done', stills: 'running' })
eq('reels unchanged', M.mergeProgressGs({}, { tracking: 'done', stills: 'x' }), { tracking: 'done' })
ok('runner prefix routes carousel jobs', /\^\(reel\|carousel\)Job/.test(gs))
for (const a of ['carouselOpen', 'carouselGet', 'carouselFrame', 'carouselSave', 'renderCarousel']) ok(`routes ${a}`, gs.includes(`action === '${a}'`))

group('Code.gs carousel job and frame gates')
const gsStub = (extra, ...names) => new Function('stubs',
  'var { carouselFileGs, readCarouselGs, writeCarouselGs, assertUnderMediaRoot, DriveApp, Utilities, mergeProgressGs } = stubs;\n' +
  gs.match(/var (REEL|CAROUSEL)_[A-Z_]+ = .*?;/g).join('\n') + '\n' +
  names.map(n => gs.slice(gs.indexOf(`function ${n}(`), gs.indexOf('\n}\n', gs.indexOf(`function ${n}(`)) + 2)).join('\n') +
  `\nreturn { ${names.join(', ')} }`)(extra)
const FID = 'A'.repeat(25)
const mkStubs = draft => {
  const writes = []
  return { writes, stubs: { carouselFileGs: () => ({}), readCarouselGs: () => JSON.parse(JSON.stringify(draft)),
    writeCarouselGs: (f, d) => writes.push(d), assertUnderMediaRoot: () => {}, mergeProgressGs: (a) => a,
    DriveApp: { getFileById: () => ({ getParents: () => ({ hasNext: () => true, next: () => ({ getId: () => 'p' }) }), getBlob: () => ({ getBytes: () => [1, 2, 3] }) }) },
    Utilities: { base64Encode: b => 'b64:' + b.length } } }
}
{
  const { writes, stubs } = mkStubs({ frames: [{ fileId: FID }], progress: {} })
  const J = gsStub(stubs, 'carouselJobPut', 'carouselFrame')
  const put = patch => J.carouselJobPut({ draftId: FID, patch: { status: 'drafting', ...patch } })
  const fr = o => ({ t: 1, fileId: FID, score: 0.5, face: null, ...o })
  ok('a good frame passes', put({ frames: [fr({ face: [1, 2, 3, 4] })] }).ok)
  ok('refuses a bad fileId', !put({ frames: [fr({ fileId: '../x' })] }).ok)
  ok('refuses a non-finite t', !put({ frames: [fr({ t: Infinity })] }).ok)
  ok('refuses a face with a missing number', !put({ frames: [fr({ face: [1, 2, 3] })] }).ok)
  ok('refuses a face with a non-number', !put({ frames: [fr({ face: [1, 2, 3, 'x'] })] }).ok)
  ok('refuses non-integer dims', !put({ dims: { w: 10.5, h: 20 } }).ok)
  ok('accepts integer dims', put({ dims: { w: 1080, h: 1920 } }).ok)
  const before = writes.length
  put({ frames: [fr({ t: NaN })] })
  eq('a refused patch writes nothing', writes.length, before)
  ok('frame refuses a fileId the draft does not list', !J.carouselFrame({ draftId: FID, fileId: 'B'.repeat(25) }).ok)
  eq('frame serves a listed one', J.carouselFrame({ draftId: FID, fileId: FID }), { ok: true, mime: 'image/jpeg', data: 'b64:3' })
}

group('Code.gs carousel validation')
const C = gsFn('maxCropHGs', 'clampCropGs', 'validatePanelGs', 'validateLinesGs', 'validateCarouselEditGs')
for (const [c, a] of [[{ cx: 0, cy: 0, h: 2 }, 16 / 9], [{ cx: .9, cy: .1, h: .3 }, 2.4], [{ cx: .5, cy: .5, h: .01 }, 16 / 9]])
  eq(`clampCropGs === clampCrop ${JSON.stringify(c)}`, C.clampCropGs(c, a), clampCrop(c, a))
const sw = mk('One two.', 'Three four.')
const stored = { words: sw, frames: [{ t: .6 }, { t: .9 }], dims: { w: 3840, h: 2160 }, lines: [], fillers: [], style: CAROUSEL_DEFAULT_STYLE }
const okLines = [{ w: [0, 2], text: 'One two.', cap: { x: 50, y: 94 }, still: { t: .6, crop: { cx: .5, cy: .4, h: .3 } } },
  { w: [2, 4], text: '', cap: { x: 50, y: 94 }, still: null }]
const edit = { lines: okLines, fillers: [], style: CAROUSEL_DEFAULT_STYLE }
ok('a normal edit passes (an empty caption is allowed)', C.validateCarouselEditGs(edit, stored).ok)
const no = (label, e) => ok(label, C.validateCarouselEditGs(e, stored).ok === false)
no('unknown key', { ...edit, html: '<b>' })
no('unknown line key', { ...edit, lines: [{ ...okLines[0], onclick: 'x' }] })
no('overlapping lines', { ...edit, lines: [okLines[0], { ...okLines[1], w: [1, 4] }] })
no('a still at a time the draft never offered', { ...edit, lines: [{ ...okLines[0], still: { t: .61, crop: okLines[0].still.crop } }, okLines[1]] })
no('caption over 120 chars', { ...edit, lines: [{ ...okLines[0], text: 'x'.repeat(121) }] })
no('font not on the list', { ...edit, style: { ...CAROUSEL_DEFAULT_STYLE, font: 'Comic Sans' } })
no('3-digit colour', { ...edit, style: { ...CAROUSEL_DEFAULT_STYLE, box: '#FFF' } })
no('three fillers', { ...edit, fillers: [1, 2, 3].map(() => ({ text: '', cap: { x: 50, y: 94 }, still: null })) })
eq('a caption dragged off the panel is clamped back', C.validateCarouselEditGs({ ...edit, lines: [{ ...okLines[0], cap: { x: 3, y: 200 } }, okLines[1]] }, stored).lines[0].cap, { x: 10, y: 100 })
no('a line past the end of the transcript', { ...edit, lines: [{ ...okLines[0], w: [0, 5] }] })
no('an empty line range', { ...edit, lines: [{ ...okLines[0], w: [1, 1] }] })
no('a non-integer line range', { ...edit, lines: [{ ...okLines[0], w: [0, 1.5] }] })
no('unknown still key', { ...edit, lines: [{ ...okLines[0], still: { ...okLines[0].still, x: 1 } }] })
no('noFace must be true', { ...edit, lines: [{ ...okLines[0], still: { ...okLines[0].still, noFace: 'yes' } }] })
no('a filler with a w', { ...edit, fillers: [{ w: [0, 1], text: '', cap: { x: 50, y: 94 }, still: null }] })
const rounded = C.validateCarouselEditGs({ ...edit, lines: [{ ...okLines[0], cap: { x: 50.123, y: 94.456 }, still: { t: .6, crop: { cx: .5123456, cy: .4123456, h: .3123456 } } }, okLines[1]] }, stored).lines[0]
eq('cap rounds to 1 decimal', rounded.cap, { x: 50.1, y: 94.5 })
eq('crop rounds to 4 decimals', [rounded.still.crop.cx, rounded.still.crop.cy, rounded.still.crop.h], [.5123, .4123, .3123])
const many = Array.from({ length: 200 }, (_, i) => ({ w: [i, i + 1], text: 'x'.repeat(120), cap: { x: 50, y: 94 }, still: { t: .6, crop: { cx: .5123, cy: .4123, h: .3123 } } }))
const manyW = Array.from({ length: 200 }, () => ({ text: 'a', s: 0, e: 1 }))
eq('too many lines for a Sheets cell', C.validateLinesGs(many, manyW, [.6], 16 / 9), { ok: false, error: 'too many lines to save' })
ok('more than maxStored lines refused', !C.validateLinesGs(many.concat(many[0]), manyW, [], 16 / 9).ok)
// Review Focus 5
const gsSave = (extra, ...names) => new Function('stubs',
  'var { readCarouselGs, carouselFileGs, writeCarouselGs, reelBusyGs, dispatchReelGs } = stubs;\n' +
  gs.match(/var (REEL|CAROUSEL)_[A-Z_]+ = .*?;/g).join('\n') + '\n' +
  names.map(n => gs.slice(gs.indexOf(`function ${n}(`), gs.indexOf('\n}\n', gs.indexOf(`function ${n}(`)) + 2)).join('\n') +
  `\nreturn { ${names.join(', ')} }`)(extra)
const mkSave = (over = {}, status = 'ready') => {
  const writes = [], sent = []
  const st = { readCarouselGs: () => JSON.parse(JSON.stringify({ ...stored, ...over, status, rev: 3 })), carouselFileGs: () => ({ getId: () => 'x' }),
    writeCarouselGs: (f, d) => writes.push(d), reelBusyGs: d => d.status === 'queued', dispatchReelGs: (k, id) => (sent.push([k, id]), { ok: true }) }
  return { writes, sent, S: gsSave(st, 'maxCropHGs', 'clampCropGs', 'validatePanelGs', 'validateLinesGs', 'validateCarouselEditGs', 'carouselSave') }
}
{
  const { S, writes } = mkSave()
  ok('carouselSave refuses a stale rev', S.carouselSave({ draftId: 'x', rev: 2, edit }, false).conflict === true)
  eq('stale rev reports currentRev and writes nothing', [S.carouselSave({ draftId: 'x', rev: 2, edit }, false).currentRev, writes.length], [3, 0])
  const r = S.carouselSave({ draftId: 'x', rev: 3, edit }, false)
  eq('a good save bumps rev and keeps status', [r.ok, r.rev, writes[0].status], [true, 4, 'ready'])
  eq('a save stores lines, fillers and style', [writes[0].lines.length, writes[0].fillers, writes[0].style], [2, [], CAROUSEL_DEFAULT_STYLE])
  const e = S.carouselSave({ draftId: 'x', rev: 3, edit: { ...edit, html: 1 } }, false)
  ok('a bad edit is refused', e.ok === false)
}
{
  const { S } = mkSave({}, 'queued')
  ok('carouselSave refuses while busy', /busy/.test(S.carouselSave({ draftId: 'x', rev: 3, edit }, false).error))
}
{
  const { S } = mkSave({ dims: undefined })
  eq('no dims, no save', S.carouselSave({ draftId: 'x', rev: 3, edit }, false).error, 'this draft has no frames yet')
}
{
  const { S, sent, writes } = mkSave()
  eq('render refuses a panel with no still', S.carouselSave({ draftId: 'x', rev: 3, edit }, true), { ok: false, error: 'pick a still for every panel' })
  eq('...and writes and dispatches nothing', [writes.length, sent.length], [0, 0])
  const full = { ...edit, lines: [okLines[0], { ...okLines[0], w: [2, 4] }] }
  const r = S.carouselSave({ draftId: 'x', rev: 3, edit: full }, true)
  eq('2 lines + 1 filler: the filler needs a still too', r.error, 'pick a still for every panel')
  const f = { text: '', cap: { x: 50, y: 94 }, still: okLines[0].still }
  const r2 = S.carouselSave({ draftId: 'x', rev: 3, edit: { ...full, fillers: [f] } }, true)
  eq('every panel placed: queued and dispatched', [r2.ok, writes[0].status, sent], [true, 'queued', [['carousel-render', 'x']]])
  const three = { ...edit, lines: [0, 1, 2].map(i => ({ ...okLines[0], w: [i, i + 1] })) }
  ok('3 lines need no filler', S.carouselSave({ draftId: 'x', rev: 3, edit: three }, true).ok)
}
ok('the column M label is a parameter', /function appendExportLinkGs\(draft, exp, label\)/.test(gs))
ok('reel callers keep the default label', /label = label \|\| 'Reel v' \+ exp\.version/.test(gs))
ok('carousel callers pass Carousel vN', (gs.match(/appendExportLinkGs\([a-z]+, [a-z]+, 'Carousel v' \+ [a-z]+\.version\)/g) || []).length === 2)
ok('routes carouselSave/renderCarousel for real', /carouselSave\(body, false\)/.test(gs) && /carouselSave\(body, true\)/.test(gs))
{
  const { stubs, writes } = mkStubs({ words: sw, frames: [{ t: .6, fileId: FID }], dims: { w: 3840, h: 2160 }, progress: {}, exports: [] })
  stubs.appendExportLinkGs = () => ({ ok: true })
  const J2 = new Function('stubs',
    'var { carouselFileGs, readCarouselGs, writeCarouselGs, mergeProgressGs, appendExportLinkGs } = stubs;\n' +
    gs.match(/var (REEL|CAROUSEL)_[A-Z_]+ = .*?;/g).join('\n') + '\n' +
    ['maxCropHGs', 'clampCropGs', 'validatePanelGs', 'validateLinesGs', 'carouselJobPut'].map(n => gs.slice(gs.indexOf(`function ${n}(`), gs.indexOf('\n}\n', gs.indexOf(`function ${n}(`)) + 2)).join('\n') +
    '\nreturn { carouselJobPut }')(stubs)
  const put = patch => J2.carouselJobPut({ draftId: FID, patch: { status: 'ready', ...patch } })
  ok('job lines are validated', put({ lines: okLines }).ok)
  ok('bad job lines are refused', !put({ lines: [{ ...okLines[0], onclick: 1 }] }).ok)
  const exp = { version: 2, name: 'Carousel v2', folderId: FID, soft: [0, 3] }
  ok('a good export', put({ status: 'done', export: exp }).ok)
  const saved = writes[writes.length - 1].exports[0]
  eq('export url, soft, linked', [saved.url, saved.soft, saved.linked, saved.version], ['https://drive.google.com/drive/folders/' + FID, [0, 3], true, 2])
  ok('bad folder id', !put({ export: { ...exp, folderId: '../x' } }).ok)
  ok('soft must be non-negative integers', !put({ export: { ...exp, soft: [-1] } }).ok && !put({ export: { ...exp, soft: [1.5] } }).ok)
  ok('soft at most 30', !put({ export: { ...exp, soft: Array.from({ length: 31 }, (_, i) => i) } }).ok)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
