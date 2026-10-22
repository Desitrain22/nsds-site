#!/usr/bin/env node
// Checks for the carousel rules: default pacing, line edits and slide layout.
//
//   node videoreview/test-carousel.mjs

import { DEFAULT_CAP, lineText, splitLines, layout, splitLine, joinLines, deleteLine } from './carousel.js'

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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
