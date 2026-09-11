// Shows are DISCOVERED, not listed here. The backend (apps-script/Code.gs listShows) walks
//   Media/<year>/<Month YYYY (City)>/{tapes, photos, completed_clips, extras, <Show> Tape Requests}
// and returns every show with its folder ids and request sheet resolved by name. A new show is a new
// folder in Drive; nothing in this repo changes. The only ids the app knows are the Media root (in
// Code.gs, mirrored below for the dev server) and the deployed backend URL.

import { EXCLUDED_TAPE_RE } from './tapes.js'

/**
 * The deployed Apps Script web app. Safe to commit: without the passphrase it rejects every
 * request, so the URL alone gives nothing away. Filled in by tools/deploy-backend.sh.
 * Leave empty and the page falls back to the localStorage override the dev server seeds.
 */
export const BACKEND_URL = 'https://script.google.com/macros/s/AKfycbzTNvxy4Nzywwoh8tJCmiYEJYrtRbEJmDi1GUM6hYMzL8Ii2XrVOgdmNSkRTqeSh2sgPQ/exec'

// NSDS/Media — used only by the dev server, which mirrors the backend's discovery over rclone.
// Keep identical to MEDIA_ROOT_ID in apps-script/Code.gs (test.mjs asserts it).
export const MEDIA_ROOT_ID = '1nD-5TFDv5cFnriCdTOBC1JlF709A9eLD'

// A show folder is named "<Month> <YYYY>" with an optional "(City)". Keep byte-identical to
// SHOW_FOLDER_RE in apps-script/Code.gs (test.mjs asserts it).
export const SHOW_FOLDER_RE = /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})(?:\s*\((.+)\))?$/i
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

/** "June 2025 (NYC Tech Week)" -> { label: 'June 2025', month: 6, year: 2025, city: 'NYC Tech Week' }; null if it isn't a show. */
export function parseShowFolderName(name) {
  const m = String(name || '').trim().match(SHOW_FOLDER_RE)
  if (!m) return null
  const month = MONTHS.indexOf(m[1].toLowerCase()) + 1
  return { label: `${m[1].charAt(0).toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}`, month, year: Number(m[2]), city: m[3] ? m[3].trim() : null }
}

/** Newest first, the same order the backend uses. */
export function sortShows(shows) {
  return [...shows].sort((a, b) => (b.year - a.year) || (b.month - a.month) || String(a.name).localeCompare(String(b.name)))
}

export function showsByYear(shows) {
  const years = new Map()
  for (const show of sortShows(shows || [])) {
    if (!years.has(show.year)) years.set(show.year, [])
    years.get(show.year).push(show)
  }
  return years
}

/** Shows are addressed by their Drive folder id (that's what goes in the URL). */
export function getShow(shows, folderId) {
  return (shows || []).find(s => s.folderId === folderId) || null
}

export const showLabel = show => (show.city ? `${show.label} · ${show.city}` : show.label)

/** The sheet title the backend creates: "June 2025 (NYC Tech Week) Tape Requests". */
export const showTitle = show => `${show.label}${show.city ? ` (${show.city})` : ''}`

const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const normText = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '')

/** A short handle for the CLI tools: "jul2025", "mar2025-sf", "jun2026-nytechweek". */
export function showShortId(show) {
  return `${MON[show.month - 1]}${show.year}${show.city ? '-' + normText(show.city) : ''}`
}

/**
 * Resolve what someone typed on a command line to one show: a folder id, the old manifest ids
 * ("jul2025", "mar2026sf", "oct2025techweek" — month + year, then a piece of the city), or any
 * unique substring of "<label> <city>". Never guesses between several.
 */
export function matchShowArg(shows, arg) {
  const a = normText(arg)
  if (!a) return { show: null, why: 'empty' }
  const byId = (shows || []).find(s => s.folderId === arg || s.sheetId === arg)
  if (byId) return { show: byId }
  let cands = []
  const m = a.match(/^([a-z]{3})[a-z]*(\d{4})(.*)$/)
  if (m && MON.includes(m[1])) {
    cands = (shows || []).filter(s => MON[s.month - 1] === m[1] && String(s.year) === m[2] && (!m[3] || normText(s.city).includes(m[3])))
  }
  if (!cands.length) {
    // Free words: every token must appear in "<label> <city>" ("tech week 2026", "roast 2024").
    const toks = String(arg).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    cands = (shows || []).filter(s => { const hay = normText(`${s.label} ${s.city || ''}`); return toks.every(t => hay.includes(t)) })
  }
  if (cands.length === 1) return { show: cands[0] }
  return { show: null, why: cands.length ? 'ambiguous' : 'no match', candidates: cands }
}

/** Reels, sizzles and recaps live alongside the set tapes but aren't anyone's set (rule shared with the backend, see tapes.js). */
export function isExcluded(filename) {
  return EXCLUDED_TAPE_RE.test(filename)
}

/**
 * Tape filename -> performer label. Tapes are "<Performer> Set.mp4" everywhere now ("Neal (Top)
 * Set.mp4", "S. Set.mp4"); full-show recordings are "Full Show.mp4". The remaining rules only cover
 * files that haven't been renamed yet: Drive's "Copy of", a date suffix, underscores, a glued
 * "FullSet"/"PROOF" suffix, and a trailing "TOP".
 */
export function performerName(filename) {
  let name = String(filename || '').replace(/\.[^.]+$/, '').trim()
  name = name.replace(/^copy of\s+/i, '')
  name = name.replace(/[_ ]?\(?\d{1,2}-\d{1,2}-\d{2,4}\)?/g, ' ')
  name = name.replace(/_+/g, ' ')
  if (/^(full\s*show|au\s*latw\s*micaudio|sf\s*full\s*tape|aufullshowreview)/i.test(name.replace(/\s+/g, ' ').trim())) return 'Full Show'
  name = name.replace(/\s*(full)?\s*set(\s*&.*)?$/i, '')
  name = name.replace(/\s*proof$/i, '')
  name = name.replace(/\s+top$/i, ' (Top)')
  name = name.replace(/\s+/g, ' ').replace(/[\s_-]+$/, '').trim()
  return name || filename
}

export const driveFolderUrl = id => (id ? `https://drive.google.com/drive/folders/${id}` : null)

/** View-only Drive links for a show. Photos and finished clips are never sent to the backend. */
export function showLinks(show) {
  return {
    tapes: driveFolderUrl(show.tapesFolderId || show.folderId),
    photos: driveFolderUrl(show.photosFolderId),
    clips: driveFolderUrl(show.completedClipsFolderId),
    // The pre-2025-H2 request sheet ("Name | Timestamp | Quote | Notes"), kept as-is in extras/
    // after its rows were imported into the canonical sheet.
    legacySheet: show.legacySheetId ? 'https://docs.google.com/spreadsheets/d/' + show.legacySheetId + '/edit' : null,
  }
}

/**
 * What to tell the performer above the tape list — derived from what was actually found, so it
 * can never go stale: no tapes at all, or a single full-show recording everyone shares.
 */
export function showNotes(show, tapes) {
  if (!Array.isArray(tapes)) return []
  if (!tapes.length) return ['No set tapes were saved for this show, so there is nothing to play here — any finished clips are linked below.']
  if (tapes.length === 1 && performerName(tapes[0].name) === 'Full Show') return ['One full-show tape covers everyone — timestamp your requests against it.']
  return []
}

/** "Peter" vs "Pete" vs "peter " — the same person across two shows' filename conventions. */
export function sameName(a, b) {
  const norm = x => String(x || '').toLowerCase().replace(/[^a-z]/g, '')
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return false
  return x === y || x.startsWith(y) || y.startsWith(x)
}

/**
 * Resolve a performer name to exactly ONE tape, or say why not. Exact (letters-only) match beats
 * fuzzy; any tie is "ambiguous", never a guess. Measured on April's tapes: "S." fuzzy-matches
 * Simren, SarahB and S., so a first-match rule would silently attach clips to the wrong tape.
 * tapes: [{ fileId, performer }]
 */
export function uniqueTapeFor(name, tapes) {
  const norm = x => String(x || '').toLowerCase().replace(/[^a-z]/g, '')
  const n = norm(name)
  if (!n) return { tape: null, why: 'no name' }
  const exact = tapes.filter(t => norm(t.performer) === n)
  if (exact.length === 1) return { tape: exact[0] }
  if (exact.length > 1) return { tape: null, why: 'ambiguous', candidates: exact }
  const fuzzy = tapes.filter(t => sameName(t.performer, name))
  if (fuzzy.length === 1) return { tape: fuzzy[0] }
  return { tape: null, why: fuzzy.length ? 'ambiguous' : 'no tape', candidates: fuzzy }
}

/**
 * Finished clips are named "<Performer> — <Topic>.mp4" (older ones "KazAUClip1.mp4",
 * "BenRequest_MetaMonitoring.mp4"). Does this file belong to the performer whose tape is open?
 */
export function clipBelongsTo(fileName, performer) {
  const stem = String(fileName || '').replace(/\.[^.]+$/, '')
  const norm = x => String(x || '').toLowerCase().replace(/[^a-z]/g, '')
  const who = norm(performer)
  if (!who) return false
  if (stem.includes(' — ')) {
    // Exact, or a prefix at least three letters long on BOTH sides: "Pete" ~ "Peter", but "S."
    // must never claim Simren's clip.
    const a = norm(stem.split(' — ')[0])
    return a === who || (Math.min(a.length, who.length) >= 3 && (a.startsWith(who) || who.startsWith(a)))
  }
  const first = norm(String(performer).split(/\s+/)[0])
  return first.length >= 3 && norm(stem).startsWith(first)
}

/** "Kaz Khadem — VC Charity (v2).mp4" -> "VC Charity (v2)"; "KazAUClip1.mp4" -> "KazAUClip1". */
export function clipTopic(fileName) {
  const stem = String(fileName || '').replace(/\.[^.]+$/, '')
  return stem.includes(' — ') ? stem.split(' — ').slice(1).join(' — ') : stem
}
