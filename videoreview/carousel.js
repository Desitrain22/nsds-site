// Carousel rules — what a finished Instagram carousel looks like, and how a clip's words become its lines.
//
// A carousel is 4:5 slides of three stills each, one line of the bit captioned per still. This file is the
// pure part, a sibling of reel.js (it reuses wordsInRanges): no DOM, no network, so the editor, the runner
// and test-carousel.mjs all run the same functions.
//
// Words are the transcript's words, indexed. A Line points at a contiguous run of them, w = [first, end),
// and carries its own (editable) text, caption position and chosen still.

import { wordsInRanges, performerFaces, nextVersionName } from './reel.js'

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

// ---- Framing -------------------------------------------------------------------------------------
//
// A Crop is { cx, cy, h }, fractions of the SOURCE frame: the centre and the height of a box whose
// width is always h × PANEL_ASPECT in source pixels, so it fills a panel exactly.

const clampTo = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** The tallest crop that still fits in a frame of this aspect (width / height). */
export const maxCropH = aspect => Math.min(1, aspect / PANEL_ASPECT)

/** A crop's width as a fraction of the source width. */
const cropW = (h, aspect) => h * PANEL_ASPECT / aspect

/** Pull a crop's size and centre back inside the frame. */
export function clampCrop(crop, aspect) {
  const h = clampTo(crop.h, 1e-3, maxCropH(aspect))
  const hw = cropW(h, aspect) / 2
  return { cx: clampTo(crop.cx, hw, 1 - hw), cy: clampTo(crop.cy, h / 2, 1 - h / 2), h }
}

/**
 * The box a face gets: k face-heights tall, never below minPx source pixels (a soft still looks worse
 * than a loose one), never more than covers the panel, with the face's centre `anchor` of the way down.
 * `face` is fractions of the frame, as tools/reel/track.py reports it.
 */
export function frameBox(face, aspect, srcH, { k = FRAMING.k, anchor = FRAMING.anchor, minPx = CAROUSEL_LIMITS.minPx } = {}) {
  const h = clampTo(k * face.h, minPx / srcH, maxCropH(aspect))
  return clampCrop({ cx: face.cx, cy: face.cy + (0.5 - anchor) * h, h }, aspect)
}

/** The crop as an integer pixel rectangle of the source, ready for ffmpeg's crop filter. */
export function cropPixels(crop, srcW, srcH) {
  const h = Math.min(srcH, Math.round(crop.h * srcH))
  const w = Math.min(srcW, Math.round(crop.h * srcH * PANEL_ASPECT))
  return {
    x: clampTo(Math.round(crop.cx * srcW - w / 2), 0, srcW - w),
    y: clampTo(Math.round(crop.cy * srcH - h / 2), 0, srcH - h),
    w,
    h,
  }
}

/**
 * True when the crop has fewer source pixels than a sharp panel wants. Rounded the way cropPixels
 * rounds, so a frameBox floor crop (h = 450 / srcH) that the backend stored to 4 decimals (0.2083 of
 * 2160 = 449.93) still counts as the 450 px it is grabbed at.
 */
export const isSoft = (crop, srcH) => Math.round(crop.h * srcH) < CAROUSEL_LIMITS.minPx

/** Drag the picture by (dx, dy) panel pixels: the crop moves the opposite way. */
export function panCrop(crop, dx, dy, aspect) {
  return clampCrop({
    cx: crop.cx - dx / PANEL.w * cropW(crop.h, aspect),
    cy: crop.cy - dy / PANEL.h * crop.h,
    h: crop.h,
  }, aspect)
}

/** Zoom by `factor` (> 1 zooms in) keeping the point under the pointer (px, py: 0–1 in the panel) fixed. */
export function zoomCrop(crop, factor, px, py, aspect) {
  const max = maxCropH(aspect)
  const h = clampTo(crop.h / factor, max / CAROUSEL_LIMITS.zoom, max)
  const x = crop.cx + (px - 0.5) * cropW(crop.h, aspect)
  const y = crop.cy + (py - 0.5) * crop.h
  return clampCrop({ cx: x - (px - 0.5) * cropW(h, aspect), cy: y - (py - 0.5) * h, h }, aspect)
}

/** Drag a caption by (dx, dy) panel pixels; its position is a percentage of the panel. */
export const moveCap = (cap, dx, dy) => ({
  x: clampTo(cap.x + dx / PANEL.w * 100, CAROUSEL_LIMITS.capX[0], CAROUSEL_LIMITS.capX[1]),
  y: clampTo(cap.y + dy / PANEL.h * 100, CAROUSEL_LIMITS.capY[0], CAROUSEL_LIMITS.capY[1]),
})

// ---- Scoring and stills --------------------------------------------------------------------------

// How a sampled frame is scored (weights are tunable): detector confidence, sharpness (a Laplacian
// variance; 300 counts as fully sharp), and a penalty for a face much smaller than the performer's usual.
const W_FACE = 0.4
const W_SHARP = 0.6
const SHARP_FULL = 300
const SMALL_FACE = 0.6
const SMALL_PENALTY = 0.3

const median = xs => { const a = [...xs].sort((x, y) => x - y); return a[a.length >> 1] }

/**
 * samples = [{ t, fileId, faces: [{ cx, cy, w, h, score, sharp }] }] -> Frame[] { t, fileId, score, face }.
 * Only the performer's face counts (see performerFaces); a frame without one scores 0.
 */
export function scoreFrames(samples) {
  const picked = performerFaces(samples)
  const typical = median(picked.filter(Boolean).map(f => f.h))
  return samples.map((s, i) => {
    const p = picked[i]
    if (!p) return { t: s.t, fileId: s.fileId, score: 0, face: null }
    const raw = W_FACE * p.score + W_SHARP * Math.min(1, p.sharp / SHARP_FULL) - (p.h < SMALL_FACE * typical ? SMALL_PENALTY : 0)
    return { t: s.t, fileId: s.fileId, score: clampTo(raw, 0, 1), face: { cx: p.cx, cy: p.cy, w: p.w, h: p.h } }
  })
}

/** The best frames inside a window (inclusive), best first, no two closer than `spacing` seconds. */
export function rankCandidates(frames, win, { spacing = 0.5, limit = 6 } = {}) {
  const inside = frames.filter(f => f.face && f.t >= win.s && f.t <= win.e).sort((a, b) => b.score - a.score || a.t - b.t)
  const out = []
  for (const f of inside) {
    if (out.length >= limit) break
    if (out.every(o => Math.abs(o.t - f.t) >= spacing - 1e-9)) out.push(f)
  }
  return out
}

/** The still for a frame: framed on its face, or a centre crop when it has none. */
export function stillFor(frame, aspect, srcH) {
  if (frame.face) return { t: frame.t, crop: frameBox(frame.face, aspect, srcH) }
  return { t: frame.t, crop: { cx: 0.5, cy: 0.5, h: maxCropH(aspect) }, noFace: true }
}

/**
 * Pick a still for every line that has none: the best candidate in its window, skipping the frame the
 * line above took. A window with no face falls back to the time-nearest frame of any kind; with no
 * frames at all the line stays null.
 */
export function defaultStills(lines, words, frames, aspect, srcH) {
  let prev = null
  return lines.map(line => {
    if (line.still) { prev = line.still.t; return line }
    const win = lineWindow(words, line)
    const cands = rankCandidates(frames, win)
    let frame = cands.find(f => f.t !== prev) || cands[0]
    if (!frame && frames.length) {
      const mid = (win.s + win.e) / 2
      frame = frames.reduce((best, f) => (Math.abs(f.t - mid) < Math.abs(best.t - mid) ? f : best))
    }
    if (!frame) return line
    prev = frame.t
    return { ...line, still: stillFor(frame, aspect, srcH) }
  })
}

/** Where a filler panel's stills come from: the 3 s after the last placed line ends. */
export function fillerWindow(words, placedLines) {
  const s = placedLines.length ? lineWindow(words, placedLines[placedLines.length - 1]).e : 0
  return { s, e: s + 3 }
}

// ---- Naming and links ----------------------------------------------------------------------------

/** "<Performer> - 2m38 carousel vN": a Drive folder, one past the highest carousel already there. */
export const nextCarouselName = (performer, firstStart, existing) => nextVersionName(performer, firstStart, existing, { kind: 'carousel', ext: '' })

/** Labels for the finished-work links: numbered clips when there are several, "View carousel" for a folder. */
export function linkLabels(urls) {
  const files = urls.filter(u => !/\/folders\//.test(u)).length
  let n = 0
  return urls.map(u => {
    if (/\/folders\//.test(u)) return 'View carousel ↗'
    return files > 1 ? `Finished clip ${++n} ↗` : 'Finished clip ↗'
  })
}
