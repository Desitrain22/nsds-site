// The rules that turn the roster (comedians.js) and the published data/upload-status.json into
// per-comedian libraries for the "By comedian" tab. Pure: no DOM, no fetch — test-library.mjs runs
// it against every label in Drive. Sets carry folder ids and filenames only; the tape's Drive file id
// is looked up behind the passphrase when a set is opened, so none ever reaches this repo.

import * as roster from './comedians.js'
import { parseShowFolderName, performerName } from './shows.js'

export const ROSTER = {
  COMEDIANS: roster.COMEDIANS,
  SHOW_OVERRIDES: roster.SHOW_OVERRIDES,
  AMBIGUOUS: roster.AMBIGUOUS,
  NOT_PEOPLE: roster.NOT_PEOPLE,
}

/**
 * "Yanjaa Westgate" / "yanjaa westgate" / "K. Cheng" all compare as letters and digits only. Accents
 * fold rather than drop, so "Zoë" matches "Zoe" and never collapses into "Zo".
 */
export const normLabel = label => String(label || '').normalize('NFKD').replace(/\p{M}/gu, '')
  .toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

// One trailing part marker each; the first that matches comes off. Pt/Part before bare digits, or
// "NealPt3" would come apart as "NealPt" + 3.
const PART_RES = [
  [/^(.+?)[\s_-]*\(\s*top\s*\)$/i, () => 'Top of show'],
  [/^(.+?)[\s_-]+top$/i, () => 'Top of show'],
  [/^(.+?)[\s_-]*(?:pt|part)[\s_.-]*(\d+)$/i, m => `Part ${Number(m[2])}`],
  [/^(.+?)[\s_-]*(\d+)$/, m => `Part ${Number(m[2])}`],
  [/^(.+?)[\s_-]*additional$/i, () => 'Additional'],
]

/**
 * "NealP (Top)" -> { base: 'NealP', part: 'Top of show' }; "Neal2" -> { base: 'Neal', part: 'Part 2' }.
 * Nothing name-specific: the base still has to be someone's alias to count.
 */
export function splitPart(label) {
  const text = String(label || '').trim()
  for (const [re, part] of PART_RES) {
    const m = text.match(re)
    const base = m && m[1].trim()
    if (base && normLabel(base)) return { base, part: part(m) }
  }
  return { base: text, part: null }
}

const NONE = { key: null, part: null }
const claimants = (n, r) => r.COMEDIANS.filter(c => c.aliases.some(a => normLabel(a) === n)).map(c => c.key)
const isAmbiguous = (n, r) => r.AMBIGUOUS.some(a => normLabel(a) === n)

/** That show's overrides. Folder names compare the way labels do, so a stray space or case change keeps them. */
function showOverrides(showLabel, r) {
  const show = Object.keys(r.SHOW_OVERRIDES).find(k => normLabel(k) === normLabel(showLabel))
  return show ? r.SHOW_OVERRIDES[show] : {}
}

/** { key, part } — part only when the label resolved by having its part marker stripped. */
function resolve(showLabel, tapeLabel, r) {
  const n = normLabel(tapeLabel)
  if (!n) return NONE
  const overrides = showOverrides(showLabel, r)
  // undefined: no override for this label. null: one that names nobody in the roster, so nothing.
  const forced = label => {
    const l = Object.keys(overrides).find(o => normLabel(o) === label)
    return l === undefined ? undefined : r.COMEDIANS.some(c => c.key === overrides[l]) ? overrides[l] : null
  }
  const whole = forced(n)
  if (whole !== undefined) return whole ? { key: whole, part: null } : NONE
  // An AMBIGUOUS label, or one two comedians both claim, stops here: "Dan" must not fall through to
  // a part-stripped guess.
  const exact = claimants(n, r)
  if (isAmbiguous(n, r) || exact.length > 1) return NONE
  if (exact.length) return { key: exact[0], part: null }
  const { base, part } = splitPart(tapeLabel)
  const b = normLabel(base)
  if (!part) return NONE
  // The show's override covers its parts too: where "Dan" is Guan, so is "Dan2".
  const split = forced(b)
  if (split !== undefined) return split ? { key: split, part } : NONE
  if (isAmbiguous(b, r)) return NONE
  const keys = claimants(b, r)
  return keys.length === 1 ? { key: keys[0], part } : NONE
}

/**
 * A tape label at a show -> comedian key, or null. Order: that show's override, an exact alias, then
 * the same two once a part marker ("Neal4", "NealPt3", "NealP (Top)") is stripped. Never a guess: a
 * label in AMBIGUOUS without an override, or one two comedians both claim, is null.
 */
export function resolveComedian(showLabel, tapeLabel, r = ROSTER) {
  return resolve(showLabel, tapeLabel, r).key
}

/** Running order within a show: the top, the set (or Part 1), Parts 2, 3 … 10, anything additional. */
function partRank(part) {
  if (part === 'Top of show') return 0
  if (part === 'Additional') return Infinity
  return Number(String(part).match(/^Part (\d+)$/)?.[1]) || 1
}
const byRunningOrder = (a, b) => (partRank(a.part) - partRank(b.part)) ||
  String(a.filename).localeCompare(String(b.filename), undefined, { numeric: true })

/** Newest first by the date in the show's name; the status file's own order is not date order. */
function showDate(show) {
  const p = parseShowFolderName(show.label)
  return p ? p.year * 12 + p.month : (Number(show.year) || 0) * 12
}

/**
 * upload-status.json -> { comedians, unmatched }. Each comedian with at least one set, sorted by
 * name, sets newest show first and in running order within a show. Full-show tapes and held-back items aren't anyone's set and are
 * left out; anything else the roster can't place goes in `unmatched` — shown, never dropped.
 */
export function buildLibrary(status, r = ROSTER) {
  const notPeople = new Set(r.NOT_PEOPLE.map(normLabel))
  const sets = new Map()
  const unmatched = []
  const shows = (status?.shows || []).map((show, order) => ({ show, order, date: showDate(show) }))
    .sort((a, b) => (b.date - a.date) || (a.order - b.order))
  for (const { show } of shows) {
    const refs = []
    for (const item of show.items || []) {
      const label = item.performer || performerName(item.filename)
      if (item.state === 'held-back' || notPeople.has(normLabel(label))) continue
      const { key, part } = resolve(show.label, label, r)
      refs.push({
        key,
        ref: {
          show: show.label, year: show.year, folderId: show.folderId, filename: item.filename,
          label, part, state: item.state, youtubeId: item.youtubeId || null,
        },
      })
    }
    // Sorted after resolving: the part is only known once the label has been placed.
    for (const { key, ref } of refs.sort((a, b) => byRunningOrder(a.ref, b.ref))) {
      if (!key) { unmatched.push(ref); continue }
      if (!sets.has(key)) sets.set(key, [])
      sets.get(key).push(ref)
    }
  }
  const comedians = r.COMEDIANS.filter(c => sets.has(c.key))
    .map(c => ({ key: c.key, name: c.name, aliases: c.aliases, sets: sets.get(c.key) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return { comedians, unmatched }
}

/** Case- and space-insensitive substring match on name and aliases; an empty query keeps everyone. */
export function searchComedians(comedians, query) {
  const q = normLabel(query)
  if (!q) return [...comedians]
  return comedians.filter(c => [c.name, ...c.aliases].some(x => normLabel(x).includes(q)))
}
