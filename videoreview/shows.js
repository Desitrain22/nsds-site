// Year -> show -> Drive folder. Pinned by ID on purpose: real Drive folder names can contain a
// forward slash ("April 2026 Tapes/Photos"), which the local Drive mount silently rewrites, so
// matching on name is unreliable. IDs verified against the live Drive.
//
// Layout after the reorganisation:  Media/<year>/<show>/{tapes,photos,completed_clips}
//   folderId               the SHOW folder — stays the same id forever; the backend finds the request
//                          sheet in its root and resolves the tapes folder from it
//   tapesFolderId          pin once known; null = backend picks the single tapes-like subfolder
//   photosFolderId         view-only link shown in the UI
//   completedClipsFolderId view-only link; always the TARGET folder id, never a shortcut's id
// Every *FolderId must be a real folder: Apps Script cannot see through Drive shortcuts.

import { EXCLUDED_TAPE_RE } from './tapes.js'

export const SHOWS = [
  {
    id: 'apr2026',
    year: 2026,
    label: 'April 2026',
    city: 'NYC',
    folderId: '1bS6gBq5vcLFbbGNG-_qB-9yWuknChO6Y',
    // Sheet is created on first save — April had none.
    sheetId: null,
    // Set tapes are "<Name>_4-23-26.mp4"; the host and intro tapes use " 4-23-26" / " (4-23-26)".
    tapesFolderId: null,
    photosFolderId: null,
    completedClipsFolderId: null,
    strip: [/[_ ]?\(?\d{1,2}-\d{1,2}-\d{2}\)?$/],
    // Keys are matched against the cleaned name, so the intro tape's key is the whole
    // "Maybr-Intro" — "Maybr" alone never fires.
    displayNameOverrides: { Albberta: 'Alberta', S: 'S.', 'Maybr-Intro': 'Mayberry (intro)' },
  },
  {
    id: 'mar2026nyc',
    year: 2026,
    label: 'March 2026',
    city: 'NYC',
    folderId: '1LdAhzNzEGhnGp6CuYyQNeRi5-n9SLkdb',
    sheetId: '1v9JKddG5T2DyObxHD7I6CckBXbjwame58L4RllV_bi8',
    // "PeteSet.mp4", "DanSet.mp4"; also holds already-cut "PeteRequest_*.mp4" files.
    tapesFolderId: null,
    photosFolderId: null,
    completedClipsFolderId: null,
    strip: [/Set$/i],
    exclude: [/^\w+Request_/i, /^Neal Hosting/i],
  },
  {
    id: 'mar2026sf',
    year: 2026,
    label: 'March 2026',
    city: 'SF',
    folderId: '1Bu0s2aZMfVVVAku1UsckXwO_C_Kzq_i4',
    sheetId: null,
    tapesFolderId: null,
    photosFolderId: null,
    completedClipsFolderId: null,
    strip: [/Set$/i, /[_ ]?\(?\d{1,2}-\d{1,2}-\d{2}\)?$/],
  },
  {
    id: 'feb2026',
    year: 2026,
    label: 'February 2026',
    city: 'NYC',
    folderId: '1RcIAK86gI7lqhJ72k9LniSv1tfi19Kvd',
    sheetId: '1srtb9-uNcCje6-gP5hY-uhRtQ02-ERgiDNUWgGTY1Dc',
    // "Peter Set.mp4", "Dan Set.mp4"
    tapesFolderId: null,
    photosFolderId: null,
    completedClipsFolderId: null,
    strip: [/ Set$/i],
  },
  {
    id: 'may2026bos',
    year: 2026,
    label: 'May 2026',
    city: 'Boston',
    folderId: '1J9A7CLVdD8tNsQwhBq2jSHSWP75zLsOg',
    sheetId: null,
    tapesFolderId: null,
    photosFolderId: null,
    completedClipsFolderId: null,
    strip: [/Set$/i, /[_ ]?\(?\d{1,2}-\d{1,2}-\d{2}\)?$/],
  },
  {
    id: 'jun2026sf',
    year: 2026,
    label: 'June 2026',
    city: 'SF',
    folderId: '1o8W-7rvjTGja6aXAZP12u1qykgE4SFFY',
    sheetId: null,
    tapesFolderId: null,
    photosFolderId: null,
    completedClipsFolderId: null,
    strip: [/Set$/i, /[_ ]?\(?\d{1,2}-\d{1,2}-\d{2}\)?$/],
  },
  {
    id: 'jun2026nytw',
    year: 2026,
    label: 'June 2026',
    city: 'NY Tech Week',
    folderId: '1etjrvzEQ2EcbzjmH0k9mkBfcAmyXyjCn',
    sheetId: '1LY5ojLQRBfWXJSoTkqydikx-aT9Sfl77659hS8A2vho',
    tapesFolderId: null,
    photosFolderId: null,
    completedClipsFolderId: null,
    strip: [/Set$/i],
    // Tapes and the request sheet both live in a "Set Tapes" subfolder. The backend recurses
    // one level, and sheetId above pins the sheet so no duplicate gets created.
    note: 'Tapes live in a "Set Tapes" subfolder.',
  },
  {
    id: 'jun2026avocarilla',
    year: 2026,
    label: 'June 2026',
    city: 'AvocaRilla',
    folderId: '12rjdk2zu7VCFIlnL9K_wVNavabHQ1dVP',
    sheetId: null,
    tapesFolderId: null,
    photosFolderId: null,
    completedClipsFolderId: null,
    strip: [/Set$/i],
  },
  {
    id: 'jul2026nyc',
    year: 2026,
    label: 'July 2026',
    city: 'NYC',
    folderId: '1jLpdaNRmhIFldwzf9fBnRBiw8lnDt2Vl',
    // Note the name: "Clip Requests", not "Tape Requests".
    sheetId: '1RS7p6MqfIDcyBXlJgn3tT64ViFkKvyOHQ4WDCLaBJp0',
    tapesFolderId: null,
    photosFolderId: null,
    completedClipsFolderId: null,
    strip: [/Set$/i, /[_ ]?\(?\d{1,2}-\d{1,2}-\d{2}\)?$/],
  },
]

/**
 * The deployed Apps Script web app. Safe to commit: without the passphrase it rejects every
 * request, so the URL alone gives nothing away. Filled in by tools/deploy-backend.sh.
 * Leave empty and the page falls back to whatever is in Backend settings.
 */
export const BACKEND_URL = 'https://script.google.com/macros/s/AKfycbzTNvxy4Nzywwoh8tJCmiYEJYrtRbEJmDi1GUM6hYMzL8Ii2XrVOgdmNSkRTqeSh2sgPQ/exec'

// Reels, sizzles and recaps live alongside the set tapes but aren't anyone's set. One rule, shared
// with the backend and the tools (see tapes.js).
const GLOBAL_EXCLUDE = [EXCLUDED_TAPE_RE]

export function showsByYear() {
  const years = new Map()
  for (const show of SHOWS) {
    if (!years.has(show.year)) years.set(show.year, [])
    years.get(show.year).push(show)
  }
  return years
}

export function getShow(id) {
  return SHOWS.find(s => s.id === id) || null
}

export function isExcluded(show, filename) {
  const patterns = GLOBAL_EXCLUDE.concat(show.exclude || [])
  return patterns.some(re => re.test(filename))
}

/** Turn a tape filename into a performer label. */
export function performerName(show, filename) {
  let name = filename.replace(/\.[^.]+$/, '').trim()
  for (const re of show.strip || []) name = name.replace(re, '').trim()
  name = name.replace(/[_\-\s]+$/, '').trim()

  const overrides = show.displayNameOverrides || {}
  // Match the override against the bare name, ignoring any parenthetical like "(Top)".
  const bare = name.replace(/\s*\(.*\)\s*$/, '').trim()
  if (overrides[bare]) name = name.replace(bare, overrides[bare])

  return name || filename
}

export const driveFolderUrl = id => (id ? `https://drive.google.com/drive/folders/${id}` : null)

/** View-only Drive links for a show. Photos and finished clips are never sent to the backend. */
export function showLinks(show) {
  return {
    tapes: driveFolderUrl(show.tapesFolderId || show.folderId),
    photos: driveFolderUrl(show.photosFolderId),
    clips: driveFolderUrl(show.completedClipsFolderId),
  }
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
