// Carousel rules — what a finished Instagram carousel looks like, and how a clip's words become its lines.
//
// A carousel is 4:5 slides of three stills each, one line of the bit captioned per still. This file is the
// pure part, a sibling of reel.js (it reuses wordsInRanges): no DOM, no network, so the editor, the runner
// and test-carousel.mjs all run the same functions.
//
// Words are the transcript's words, indexed. A Line points at a contiguous run of them, w = [first, end),
// and carries its own (editable) text, caption position and chosen still.

import { wordsInRanges } from './reel.js'

export const SLIDE = { w: 1080, h: 1350 }
export const PANEL = { w: 1080, h: 450 }
export const PANEL_ASPECT = 2.4
export const FPS = 4
export const FRAMING = { k: 2.3, anchor: 0.42 }
export const DEFAULT_CAP = { x: 50, y: 94 }

export const CAROUSEL_LIMITS = { maxPlaced: 30, maxStored: 200, maxLineChars: 70, maxCaption: 120, pause: 0.5, size: [28, 72], capX: [10, 90], capY: [25, 100], zoom: 4, minPx: 450, maxFillers: 2 }

export const CAROUSEL_DEFAULT_STYLE = { font: 'montserrat', size: 44, box: '#2E1A42', fg: '#FFFFFF' }

const SENTENCE_END = /[.?!]["”’)]*$/

/** The words of a line, joined by single spaces. */
export const lineText = (words, w) => words.slice(w[0], w[1]).map(x => x.text).join(' ')

/** Tape-time span of a line: from its first word's start to its last word's end. */
export const lineWindow = (words, line) => ({ s: words[line.w[0]].s, e: words[line.w[1] - 1].e })

const mkLine = (words, w) => ({ w, text: lineText(words, w), cap: { ...DEFAULT_CAP }, still: null })
const wordCount = l => l.w[1] - l.w[0]

/**
 * Where to break the run w = [a, b): returns the index of the first word of the second half.
 * Commas/semicolons win, nearest the middle of the text; with none, the longest pause of at least
 * CAROUSEL_LIMITS.pause; with none of those, the word boundary nearest the middle. Ties go earliest.
 */
function breakAt(words, w) {
  const [a, b] = w
  const half = lineText(words, w).length / 2
  const through = k => lineText(words, [a, k + 1]).length
  const nearest = ks => ks.reduce((best, k) => (Math.abs(through(k) - half) < Math.abs(through(best) - half) ? k : best))
  const ks = []
  for (let k = a; k < b - 1; k++) ks.push(k)
  const commas = ks.filter(k => /[,;]$/.test(words[k].text))
  if (commas.length) return nearest(commas) + 1
  let best = -1
  let gap = CAROUSEL_LIMITS.pause
  for (const k of ks) {
    const g = words[k + 1].s - words[k].e
    if (g >= gap && (best < 0 || g > gap)) { best = k; gap = g }
  }
  return best >= 0 ? best + 1 : nearest(ks) + 1
}

/** Break a run into pieces of at most maxLineChars, as many times as it takes. */
function shorten(words, w) {
  if (w[1] - w[0] < 2 || lineText(words, w).length <= CAROUSEL_LIMITS.maxLineChars) return [w]
  const m = breakAt(words, w)
  return [...shorten(words, [w[0], m]), ...shorten(words, [m, w[1]])]
}

/**
 * The default pacing: a line per sentence, long sentences broken, then joined or split until the count is
 * a multiple of three so every slide is full. A line is a run of kept words — nothing spans a cut.
 */
export function splitLines(words, ranges) {
  const keep = wordsInRanges(words, ranges)
  const lines = []
  let start = -1
  const close = end => {
    if (start >= 0) shorten(words, [start, end]).forEach(w => lines.push(mkLine(words, w)))
    start = -1
  }
  words.forEach((word, i) => {
    if (!keep[i]) { close(i); return }
    if (start < 0) start = i
    if (SENTENCE_END.test(word.text)) close(i + 1)
  })
  close(words.length)

  const split = () => {
    let at = -1
    lines.forEach((l, i) => { if (wordCount(l) >= 2 && (at < 0 || l.text.length > lines[at].text.length)) at = i })
    if (at < 0) return false
    const { w } = lines[at]
    const m = breakAt(words, w)
    lines.splice(at, 1, mkLine(words, [w[0], m]), mkLine(words, [m, w[1]]))
    return true
  }
  const join = () => {
    let at = -1
    let len = Infinity
    for (let i = 0; i + 1 < lines.length; i++) {
      if (lines[i].w[1] !== lines[i + 1].w[0]) continue // a cut sits between them
      const n = lines[i].text.length + 1 + lines[i + 1].text.length
      if (n <= CAROUSEL_LIMITS.maxCaption && n < len) { at = i; len = n }
    }
    if (at < 0) return false
    lines.splice(at, 2, mkLine(words, [lines[at].w[0], lines[at + 1].w[1]]))
    return true
  }
  for (let guard = 0; lines.length > 0 && lines.length < CAROUSEL_LIMITS.maxPlaced && lines.length % 3 && guard < 100; guard++) {
    const moved = lines.length % 3 === 1 ? join() || split() : split() || join()
    if (!moved) break
  }
  return lines
}

/**
 * Three panels to a slide. Lines past maxPlaced wait in `reserve`; a short last slide is topped up with
 * fillers (the stored ones first, then blanks), so fillerCount is at most maxFillers.
 */
export function layout(lines, fillers = []) {
  const placed = lines.slice(0, CAROUSEL_LIMITS.maxPlaced)
  const reserve = lines.slice(CAROUSEL_LIMITS.maxPlaced)
  const fillerCount = (3 - placed.length % 3) % 3
  const panels = placed.map(l => ({ kind: 'line', ...l }))
  for (let i = 0; i < fillerCount; i++) panels.push({ kind: 'filler', ...(fillers[i] || { text: '', cap: { ...DEFAULT_CAP }, still: null }) })
  const slides = []
  for (let i = 0; i < panels.length; i += 3) slides.push(panels.slice(i, i + 3))
  return { slides, reserve, fillerCount }
}

/** Split line i at a caret in its text. The words split at the same place, by whitespace-separated token. */
export function splitLine(lines, words, i, offset) {
  const l = lines[i]
  if (!l || wordCount(l) < 2) return lines
  const head = l.text.slice(0, offset).trim()
  const before = head ? head.split(/\s+/).length : 0
  const m = Math.min(Math.max(l.w[0] + before, l.w[0] + 1), l.w[1] - 1)
  const a = { w: [l.w[0], m], text: head, cap: l.cap, still: null }
  const b = { w: [m, l.w[1]], text: l.text.slice(offset).trim(), cap: { ...DEFAULT_CAP }, still: null }
  return [...lines.slice(0, i), a, b, ...lines.slice(i + 1)]
}

/** Join line i with the next; the first line's caption position wins, the still is re-picked. */
export function joinLines(lines, words, i) {
  const a = lines[i]
  const b = lines[i + 1]
  if (!a || !b) return lines
  const joined = { w: [a.w[0], b.w[1]], text: `${a.text} ${b.text}`, cap: a.cap, still: null }
  return [...lines.slice(0, i), joined, ...lines.slice(i + 2)]
}

export const deleteLine = (lines, i) => lines.filter((_, j) => j !== i)
