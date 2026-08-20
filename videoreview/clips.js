// Clip/range model and timestamp handling.
//
// Internally a timestamp is always **seconds as a float**. The sheet gets whole-second
// m:ss (the format the editing team already reads); full precision survives only in the
// machine `ranges_json` column. Never write m:ss.hh into the human Start/End columns —
// Sheets coerces it, so a human retyping "2:38.43" ends up with something near 2h38m.

/**
 * Parse the sloppy timestamps humans actually type.
 * Accepts "1:14", "10:28", "1:02:03", "72", "1:12.5", and junk-suffixed forms like
 * "1:12'ish" (which really is in the live February sheet).
 * Returns seconds, or null if there's no number in there at all.
 */
export function parseTime(input) {
  if (input === null || input === undefined) return null
  if (typeof input === 'number') return Number.isFinite(input) ? input : null

  // Keep only digits, colons and dots, so "1:12'ish" degrades to "1:12".
  const cleaned = String(input).trim().replace(/[^0-9:.]/g, '')
  if (!cleaned) return null

  const parts = cleaned.split(':')
  if (parts.some(p => p === '')) {
    // Things like "1:" or ":30" — salvage what we can rather than returning garbage.
    const usable = parts.filter(p => p !== '')
    if (!usable.length) return null
    return parseTime(usable.join(':'))
  }

  const nums = parts.map(Number)
  if (nums.some(n => !Number.isFinite(n))) return null

  let seconds
  if (nums.length === 1) seconds = nums[0]
  else if (nums.length === 2) seconds = nums[0] * 60 + nums[1]
  else seconds = nums[0] * 3600 + nums[1] * 60 + nums[2]

  return seconds < 0 ? null : seconds
}

/** Whole-second m:ss — what goes into the sheet. */
export function formatTime(seconds) {
  const total = Math.round(Number(seconds) || 0)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Tenths, for on-screen readouts where precision is the point. */
export function formatTimePrecise(seconds) {
  const v = Math.max(0, Number(seconds) || 0)
  const m = Math.floor(v / 60)
  const s = v - m * 60
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`
}

let counter = 0
function localId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID()
  counter += 1
  return `clip-${Date.now()}-${counter}`
}

/**
 * A clip is one sheet row and owns an ORDERED list of ranges, so clip 2 can be
 * 2:38-2:56 then a jump cut to 3:15-3:30.
 * The id is minted here, before any request goes out — that's what makes a retried save
 * an update instead of a second row.
 */
export function newClip({ name = '', videoFileId = '' } = {}) {
  return {
    clipId: localId(),
    name,
    videoFileId,
    ranges: [{ s: null, e: null }],
    notes: '',
    links: [],
    thumb: '',
    granular: '',
    rev: undefined,
    dirty: true,
    saving: false,
    error: null,
    readOnly: false,
  }
}

export function addRange(clip) {
  clip.ranges.push({ s: null, e: null })
  clip.dirty = true
  return clip
}

export function removeRange(clip, index) {
  if (clip.ranges.length <= 1) return clip
  clip.ranges.splice(index, 1)
  clip.dirty = true
  return clip
}

/** Ranges that are fully specified and coherent, in order. */
export function playableRanges(clip) {
  return clip.ranges
    .filter(r => r.s !== null && r.e !== null && r.e > r.s)
    .map(r => ({ s: r.s, e: r.e }))
}

/**
 * Why a clip can't be saved yet, or null if it can.
 * The duration bound is the cheap check that catches nearly every parse pathology,
 * including a time-serial that decoded 60x too large.
 */
export function validate(clip, duration) {
  if (!clip.ranges.length) return 'Add at least one time range.'
  for (let i = 0; i < clip.ranges.length; i++) {
    const r = clip.ranges[i]
    const label = clip.ranges.length > 1 ? `Range ${i + 1}` : 'The range'
    if (r.s === null) return `${label} is missing a start time.`
    if (r.e === null) return `${label} is missing an end time.`
    if (r.e <= r.s) return `${label} ends at or before it starts.`
    if (duration && r.e > duration + 1) {
      return `${label} ends at ${formatTime(r.e)}, past the end of the tape (${formatTime(duration)}).`
    }
  }
  return null
}

/** How the clip will read in the sheet's Start/End/granular columns. */
export function previewRow(clip) {
  const ranges = playableRanges(clip)
  if (!ranges.length) return { start: '', end: '', granular: '' }
  return {
    start: formatTime(ranges[0].s),
    end: formatTime(ranges[ranges.length - 1].e),
    granular:
      ranges.length > 1
        ? ranges.map(r => `${formatTime(r.s)} - ${formatTime(r.e)}`).join(', ')
        : clip.granular || '',
  }
}

/**
 * Best-effort read of the free-text "granular time stamps" column on legacy rows.
 *
 * That column means three different things in the live sheets: additive sub-ranges
 * ("1:12 - 1:19, 1:21 - 1:27"), subtractive removals ("remove 4:23-4:26", "cut 9:45 - 9:52"),
 * and plain advice with no timestamps at all ("cut pauses"). We classify but never write
 * the result back — a parse is only ever a suggestion.
 */
export function parseGranular(text) {
  const raw = String(text || '').trim()
  if (!raw) return { kind: 'empty', ranges: [], raw }

  const pairs = []
  const re = /(\d{1,2}(?::\d{1,2}){0,2}(?:\.\d+)?)\s*[-–—]\s*(\d{1,2}(?::\d{1,2}){0,2}(?:\.\d+)?)/g
  let m
  while ((m = re.exec(raw)) !== null) {
    const s = parseTime(m[1])
    const e = parseTime(m[2])
    if (s !== null && e !== null && e > s) pairs.push({ s, e })
  }

  if (!pairs.length) return { kind: 'advice', ranges: [], raw }
  const subtractive = /\b(remove|cut|drop|skip|delete|omit)\b/i.test(raw)
  return { kind: subtractive ? 'subtractive' : 'additive', ranges: pairs, raw }
}

/**
 * Build the playable ranges for a legacy row: the outer Start/End span, refined by column D
 * when we can read it. Display only.
 */
export function legacyRanges(row) {
  const s = parseTime(row.start)
  const e = parseTime(row.end)
  const span = s !== null && e !== null && e > s ? [{ s, e }] : []
  const g = parseGranular(row.granular)

  if (g.kind === 'additive' && g.ranges.length) return g.ranges
  if (g.kind === 'subtractive' && span.length) return subtractRanges(span, g.ranges)
  return span
}

function subtractRanges(spans, cuts) {
  let out = spans.slice()
  for (const cut of cuts) {
    const next = []
    for (const r of out) {
      if (cut.e <= r.s || cut.s >= r.e) { next.push(r); continue }
      if (cut.s > r.s) next.push({ s: r.s, e: Math.min(cut.s, r.e) })
      if (cut.e < r.e) next.push({ s: Math.max(cut.e, r.s), e: r.e })
    }
    out = next
  }
  return out.filter(r => r.e > r.s)
}

/** Total kept time, for the "2 parts · 0:33" summary. */
export function totalDuration(ranges) {
  return ranges.reduce((sum, r) => sum + Math.max(0, r.e - r.s), 0)
}
