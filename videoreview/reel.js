// Reel rules — the one place that decides what a finished vertical clip looks like.
//
// Imported by three very different callers, which is the point of keeping it pure:
//   reel-editor.js       the browser preview paints captions from captionSlices()
//   tools/reel/*.mjs     the GitHub runner builds the .ass file and the ffmpeg argv from the SAME
//                        functions, so what was previewed is what gets burned in
//   test-reel.mjs        node, no DOM
// Apps Script can't import ES modules, so Code.gs restates FONT_IDS, HEX_RE and LIMITS as
// byte-identical literals (test-reel.mjs fails if they drift) and its own hexToAssGs/legacyKeyGs
// are run against these in the tests.
//
// Times are TAPE seconds everywhere except inside buildAss, which maps them onto the output
// timeline with toOutputTime() once the ranges are concatenated.

/**
 * Caption fonts. All OFL, committed under videoreview/fonts/ so the browser preview (@font-face)
 * and libass on the runner read the very same files.
 *
 * `assName` is the family name INSIDE each file (name ID 1), which is what libass matches on. The
 * odd ones ("Montserrat Thin ExtraBold", "Azeret Mono Thin") are how the static instances cut from
 * variable fonts name themselves — matching the file beats matching the marketing name.
 *
 * `assScale` is (usWinAscent + usWinDescent) / unitsPerEm. libass sizes a font so that its whole
 * cell, not its em, equals Fontsize; CSS sizes the em. Multiplying by this makes ASS text the same
 * size as the preview.
 *
 * `size` is the default preview size for that face (px on the 300-px-wide preview frame).
 */
export const FONTS = [
  { id: 'bebas', label: 'Bebas Neue', file: 'BebasNeue-Regular.ttf', assName: 'Bebas Neue', assScale: 1.3, size: 44 },
  { id: 'anton', label: 'Anton', file: 'Anton-Regular.ttf', assName: 'Anton', assScale: 1.733, size: 36 },
  { id: 'archivo', label: 'Archivo Black', file: 'ArchivoBlack-Regular.ttf', assName: 'Archivo Black', assScale: 1.347, size: 28 },
  { id: 'montserrat', label: 'Montserrat ExtraBold', file: 'Montserrat-ExtraBold.ttf', assName: 'Montserrat Thin ExtraBold', assScale: 1.562, size: 28 },
  { id: 'azeret', label: 'Azeret Mono', file: 'AzeretMono-Bold.ttf', assName: 'Azeret Mono Thin', assScale: 1.342, size: 24 },
]
export const FONT_IDS = ['bebas', 'anton', 'archivo', 'montserrat', 'azeret']
export const fontById = id => FONTS.find(f => f.id === id) || FONTS[0]

export const HEX_RE = /^#?[0-9A-Fa-f]{6}$/

export const LIMITS = { maxRanges: 10, maxTotal: 180, trimSlack: 5, maxWordLen: 40, size: [18, 96], y: [30, 85] }

/** The preview frame is 300 px wide; the export is 1080. Every preview measurement scales by this. */
export const PREVIEW_SCALE = 1080 / 300

export const DEFAULT_STYLE = { font: 'bebas', size: 44, y: 58, fill: '#FFFFFF', highlight: '#FFFF82', outline: '#000000', crop: 0.5 }

// ------------------------------------------------------------------ colour + text --

/** "#RRGGBB" -> "&H00BBGGRR&" — ASS stores alpha first (00 = opaque), then blue, green, red. */
export function hexToAss(hex) {
  if (!HEX_RE.test(String(hex))) throw new Error(`not a #RRGGBB colour: ${hex}`)
  const h = String(hex).replace('#', '').toUpperCase()
  return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`
}

const normHex = hex => '#' + String(hex).replace('#', '').toUpperCase()

/**
 * A caption word is data. In ASS `{` opens an override block and `\N`, `\h`… are escapes, and
 * libass has no way to escape a backslash — so a mis-heard word typed as `{\fs200}` would restyle
 * the whole render. Replace the three characters with look-alikes instead.
 */
export function assEscape(text) {
  return String(text ?? '').replace(/\\/g, '∖').replace(/\{/g, '(').replace(/\}/g, ')').replace(/\s+/g, ' ').trim()
}

// ------------------------------------------------------------------ words --

const timed = w => Number.isFinite(w?.s) && Number.isFinite(w?.e)
const UNTIMED_SLOT = 0.3

/**
 * WhisperX's aligner can't place words with digits or symbols ("2014", "$13.60"), and stand-up is
 * full of them. Spread each run of untimed words evenly across the gap its neighbours leave; at the
 * very start or end of the clip, give each one UNTIMED_SLOT seconds.
 */
export function fillTimings(words) {
  const out = words.map(w => timed(w)
    ? { text: String(w.text), s: w.s, e: Math.max(w.e, w.s), aligned: w.aligned !== false }
    : { text: String(w.text), s: null, e: null, aligned: false })
  let i = 0
  while (i < out.length) {
    if (out[i].s !== null) { i++; continue }
    let j = i
    while (j < out.length && out[j].s === null) j++
    const n = j - i
    const prev = out[i - 1]
    const next = out[j]
    let lo = prev ? prev.e : next ? Math.max(0, next.s - UNTIMED_SLOT * n) : 0
    let hi = next ? next.s : lo + UNTIMED_SLOT * n
    if (hi < lo) hi = lo
    const slot = (hi - lo) / n
    for (let k = 0; k < n; k++) Object.assign(out[i + k], { s: lo + k * slot, e: lo + (k + 1) * slot })
    i = j
  }
  return out
}

/**
 * The first grouping, before anyone regroups by hand: at most 3 words / 16 characters on screen,
 * always breaking at a pause of half a second or more and after a word that ends a clause.
 * Returns the indices that START a new group (index 0 never appears).
 */
export function autoBreaks(words, { maxWords = 3, maxChars = 16, gap = 0.5 } = {}) {
  const out = []
  let count = 0
  let chars = 0
  words.forEach((w, i) => {
    const len = String(w.text).length
    if (i > 0) {
      const prev = words[i - 1]
      if (count >= maxWords || chars + 1 + len > maxChars || w.s - prev.e >= gap || /[.?!,;:]["')\]]*$/.test(prev.text)) {
        out.push(i)
        count = 0
        chars = 0
      }
    }
    chars += (count ? 1 : 0) + len
    count++
  })
  return out
}

/** Word indices, grouped. Breaks outside (0, length) or repeated are ignored. */
export function groups(words, breaks) {
  const at = new Set(breaks)
  const out = []
  let cur = []
  words.forEach((_, i) => {
    if (i > 0 && at.has(i) && cur.length) { out.push(cur); cur = [] }
    cur.push(i)
  })
  if (cur.length) out.push(cur)
  return out
}

/** A word is in the reel iff its midpoint falls inside a kept range. */
export function wordsInRanges(words, ranges) {
  return words.map(w => {
    const mid = (w.s + w.e) / 2
    return ranges.some(r => mid >= r.s && mid < r.e)
  })
}

/** Does a column-D / notes string ask for the pauses to go? */
export function wantsCutPauses(notes) {
  return /\b(cut|remove|trim|tighten)\b[^.]*\bpauses?\b/i.test(String(notes || ''))
}

/**
 * "cut pauses", without cutting the laughs. A gap between two words is only removed where it is
 * also SILENCE (ffmpeg silencedetect on the runner) — a laugh is loud, so it survives. `pad` of air
 * is kept on both sides, a cut under 0.2 s isn't worth a jump, and range edges are never touched
 * (the performer chose those).
 */
export function cutPauses(ranges, words, silences, { gap = 0.6, pad = 0.15 } = {}) {
  const cuts = []
  for (let i = 1; i < words.length; i++) {
    const a = words[i - 1]
    const b = words[i]
    if (b.s - a.e <= gap) continue
    for (const q of silences) {
      const s = Math.max(a.e, q.s) + pad
      const e = Math.min(b.s, q.e) - pad
      if (e - s >= 0.2) cuts.push({ s, e })
    }
  }
  let out = ranges.map(r => ({ s: r.s, e: r.e }))
  for (const c of cuts) {
    const next = []
    for (const r of out) {
      if (c.s <= r.s || c.e >= r.e || c.e <= r.s || c.s >= r.e) { next.push(r); continue }
      next.push({ s: r.s, e: c.s }, { s: c.e, e: r.e })
    }
    out = next
  }
  return out
}

// ------------------------------------------------------------------ time --

export const totalLength = ranges => ranges.reduce((n, r) => n + Math.max(0, r.e - r.s), 0)

/** Tape time -> output time once the ranges are concatenated. A time in a removed gap lands on the join. */
export function toOutputTime(t, ranges) {
  let acc = 0
  for (const r of [...ranges].sort((a, b) => a.s - b.s)) {
    if (t < r.s) return acc
    if (t < r.e) return acc + (t - r.s)
    acc += r.e - r.s
  }
  return acc
}

/** Output time -> tape time (for the preview's scrubber). */
export function toTapeTime(o, ranges) {
  const sorted = [...ranges].sort((a, b) => a.s - b.s)
  let acc = 0
  for (const r of sorted) {
    if (o < acc + (r.e - r.s)) return r.s + Math.max(0, o - acc)
    acc += r.e - r.s
  }
  return sorted.length ? sorted[sorted.length - 1].e : 0
}

export function rangesChanged(a, b) {
  const key = rs => JSON.stringify([...(rs || [])].sort((x, y) => x.s - y.s).map(r => [+r.s.toFixed(2), +r.e.toFixed(2)]))
  return key(a) !== key(b)
}

// ------------------------------------------------------------------ captions --

const LINGER = 0.6
const HL_SLOP = 0.02

/**
 * What is on screen when, in tape time. A group appears at its first word and stays until the next
 * group starts or LINGER after its own last word, whichever is first. Each slice carries the word
 * being spoken (`active`), or null between words. The preview and buildAss both read this, which is
 * what keeps the export identical to what was edited.
 */
export function captionSlices(words, breaks, keep = null) {
  const gs = groups(words, breaks).map(g => keep ? g.filter(i => keep[i]) : g).filter(g => g.length)
  const out = []
  gs.forEach((g, k) => {
    const start = words[g[0]].s
    const next = gs[k + 1]
    const end = Math.min(next ? words[next[0]].s : Infinity, words[g[g.length - 1]].e + LINGER)
    if (!(end > start)) return
    const cuts = new Set([start, end])
    for (const i of g) {
      for (const t of [words[i].s, words[i].e + HL_SLOP]) if (t > start && t < end) cuts.add(t)
    }
    const pts = [...cuts].sort((a, b) => a - b)
    for (let p = 0; p < pts.length - 1; p++) {
      const s = pts[p]
      const hit = g.find(i => words[i].s <= s && s < words[i].e + HL_SLOP)
      out.push({ s, e: pts[p + 1], words: g, active: hit === undefined ? null : hit })
    }
  })
  return out
}

export function captionAt(slices, t) {
  for (const sl of slices) if (t >= sl.s && t < sl.e) return sl
  return null
}

// ------------------------------------------------------------------ rows + style --

/**
 * A stable id for a row typed straight into the sheet (no clip_id). FNV-1a over the request's own
 * text, whitespace-normalised. Code.gs has the same function as legacyKeyGs; the tests run both.
 */
export function legacyKey(row) {
  const str = [row.name, row.start, row.end, row.granular].map(x => String(x || '').trim().replace(/\s+/g, ' ')).join('|')
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return 'row-' + h.toString(16).padStart(8, '0')
}

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v))

/** Browser-side tidy-up: anything invalid falls back to the default. The backend refuses instead. */
export function clampStyle(style = {}) {
  const d = DEFAULT_STYLE
  const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
  const hex = (v, fallback) => (HEX_RE.test(String(v)) ? normHex(v) : fallback)
  return {
    font: FONT_IDS.includes(style.font) ? style.font : d.font,
    size: clamp(num(style.size, d.size), LIMITS.size),
    y: clamp(num(style.y, d.y), LIMITS.y),
    fill: hex(style.fill, d.fill),
    highlight: style.highlight === null ? null : hex(style.highlight, d.highlight),
    outline: hex(style.outline, d.outline),
    crop: clamp(num(style.crop, d.crop), [0, 1]),
  }
}

/** CSS stroke the preview uses; the ASS outline is half of it (a CSS stroke straddles the edge). */
export const strokeFor = size => Math.max(3, size / 7)

// ------------------------------------------------------------------ export --

const assTime = t => {
  const cs = Math.max(0, Math.round(t * 100))
  const h = Math.floor(cs / 360000)
  const m = Math.floor(cs / 6000) % 60
  const s = Math.floor(cs / 100) % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`
}

/** The burned-in captions, as an .ass file, from a draft's words/breaks/ranges/style. */
export function buildAss(draft) {
  const style = clampStyle(draft.style)
  const font = fontById(style.font)
  const fill = hexToAss(style.fill)
  const hl = style.highlight ? hexToAss(style.highlight) : null
  const size = Math.round(style.size * font.assScale * PREVIEW_SCALE)
  const outline = +(strokeFor(style.size) / 2 * PREVIEW_SCALE).toFixed(1)
  const y = Math.round(style.y / 100 * 1920)
  const margin = Math.round(18 * PREVIEW_SCALE)

  const words = draft.words
  const ranges = draft.ranges
  const slices = captionSlices(words, draft.breaks, wordsInRanges(words, ranges))
  const events = []
  for (const sl of slices) {
    const s = toOutputTime(sl.s, ranges)
    const e = toOutputTime(sl.e, ranges)
    if (e - s < 0.01) continue
    const text = sl.words.map(i => {
      const t = assEscape(words[i].text).toUpperCase()
      return hl && i === sl.active ? `{\\c${hl}}${t}{\\r}` : t
    }).join(' ')
    events.push(`Dialogue: 0,${assTime(s)},${assTime(e)},Reel,,0,0,0,,{\\pos(540,${y})}${text}`)
  }

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Reel,${font.assName},${size},${fill},${fill},${hexToAss(style.outline)},&H00000000&,0,0,0,0,100,100,0,0,1,${outline},0,5,${margin},${margin},0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n')
}

// The bug, measured off the agreed mockup (300-px frame) and scaled to 1080.
const BUG = { top: 50, right: 43, icon: 86, gap: 22, font: 31, line: 35, opacity: 0.7 }

/**
 * ffmpeg argv for the export. An array, never a shell string. The filter graph quotes paths, so a
 * path carrying a quote, colon or backslash is refused rather than escaped — the runner only ever
 * passes paths it made itself.
 */
export function ffmpegArgs(draft, { input, ass, fontsDir, icon, bugFont, out }) {
  for (const p of [ass, fontsDir, bugFont]) {
    if (/['\\:,;[\]]/.test(p)) throw new Error(`refusing a filter path with special characters: ${p}`)
  }
  const style = clampStyle(draft.style)
  const ranges = [...draft.ranges].sort((a, b) => a.s - b.s)
  const crop = +style.crop.toFixed(4)
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y']
  for (const r of ranges) args.push('-ss', r.s.toFixed(3), '-t', (r.e - r.s).toFixed(3), '-i', input)
  args.push('-i', icon)

  const parts = []
  ranges.forEach((r, i) => {
    const d = r.e - r.s
    parts.push(`[${i}:v]crop=ih*9/16:ih:(iw-ih*9/16)*${crop},scale=1080:1920:flags=lanczos,setsar=1,fps=30000/1001[v${i}]`)
    parts.push(`[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo,afade=t=in:d=0.015,afade=t=out:st=${Math.max(0, d - 0.015).toFixed(3)}:d=0.015[a${i}]`)
  })
  parts.push(`${ranges.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${ranges.length}:v=1:a=1[cv][ca]`)
  parts.push(`[cv]ass=filename='${ass}':fontsdir='${fontsDir}'[sv]`)
  parts.push(`[${ranges.length}:v]format=rgba,colorchannelmixer=aa=${BUG.opacity}[bug]`)
  parts.push(`[sv][bug]overlay=x=W-w-${BUG.right}:y=${BUG.top}[ov]`)
  const textRight = BUG.right + BUG.icon + BUG.gap
  const textTop = BUG.top + Math.round((BUG.icon - 2 * BUG.line) / 2)
  const draw = (text, yy) => `drawtext=fontfile='${bugFont}':text='${text}':fontsize=${BUG.font}:fontcolor=white@${BUG.opacity}:shadowcolor=black@0.5:shadowx=0:shadowy=2:x=w-tw-${textRight}:y=${yy}`
  parts.push(`[ov]${draw('A.U', textTop)},${draw('Tech Comedy Show', textTop + BUG.line)}[outv]`)

  args.push(
    '-filter_complex', parts.join(';'),
    '-map', '[outv]', '-map', '[ca]',
    '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '18',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart',
    out,
  )
  return args
}

/** "<Performer> - 2m38 reel vN.mp4", N one past the highest already in the folder. Never overwrites. */
export function nextVersionName(performer, firstStart, existing) {
  const who = String(performer || 'Clip').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim() || 'Clip'
  const t = Math.max(0, Math.floor(firstStart))
  const base = `${who} - ${Math.floor(t / 60)}m${String(t % 60).padStart(2, '0')} reel`
  let n = 0
  for (const name of existing) {
    const m = name.startsWith(base + ' v') && name.slice(base.length + 2).match(/^(\d+)\.mp4$/)
    if (m) n = Math.max(n, +m[1])
  }
  return `${base} v${n + 1}.mp4`
}
