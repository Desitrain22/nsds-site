#!/usr/bin/env node
// Checks for the carousel rules: default pacing, line edits and slide layout.
//
//   node videoreview/test-carousel.mjs

import { DEFAULT_CAP, lineText, splitLines, layout, splitLine, joinLines, deleteLine,
  frameBox, clampCrop, cropPixels, isSoft, panCrop, zoomCrop, moveCap, scoreFrames, rankCandidates, defaultStills, nextCarouselName, linkLabels } from './carousel.js'
import { nextVersionName } from './reel.js'

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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
