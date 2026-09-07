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
    sheetId: '1L5XfqMTAgZlY7pSoAF8oYa8suioIMWCeDH6dVeJhbPk',
    // Set tapes are "<Name>_4-23-26.mp4"; the host and intro tapes use " 4-23-26" / " (4-23-26)".
    tapesFolderId: '1a9HA_75NAeVwfppOujLqCodACVnuX2fp',
    photosFolderId: '1CFeeKKfdLrLTXNGBUvfmMGCQNEZgg9Eq',
    completedClipsFolderId: '13RBv6DSHff0lMC5v0xng1JqEgIRxF614',
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
    tapesFolderId: '1RD9LdKXYKZH6UsNGkhMWwt5Cl35FjgbR',
    photosFolderId: '1YNt5EU59cYCPWwSw-yfsmQzYkSeG2zjw',
    completedClipsFolderId: '1KDT0HSLAG2CAFS2EEveWcQAaXXw5PUZa',
    strip: [/Set$/i],
    exclude: [/^\w+Request_/i, /^Neal Hosting/i],
  },
  {
    id: 'mar2026sf',
    year: 2026,
    label: 'March 2026',
    city: 'SF',
    folderId: '1Bu0s2aZMfVVVAku1UsckXwO_C_Kzq_i4',
    sheetId: '18-ehOxQgHAHfDdBhIV9AS3pom-8AxPz_P6tLrJ6R4bg',
    tapesFolderId: '1S9y1-IdmFCSQfthCwxkuNLtISNkImwZX',
    photosFolderId: '11DPxcfnB3AIRJ_RUO6U30vJ7N5lFZ-5C',
    completedClipsFolderId: '17I41R-zfhR08ubjhr6voKOymeZH_tzwL',
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
    tapesFolderId: '1YNe8WH3SdXhqHyosKm5KYOXrNPyO4Iy0',
    photosFolderId: '1o74RI6E9xaL2jhSrX1H3hPEI0thianxu',
    completedClipsFolderId: '197Pn5GjCwBzWcd-IjJz8Lq8oFN2B3dHB',
    strip: [/ Set$/i],
  },
  {
    id: 'may2026bos',
    year: 2026,
    label: 'May 2026',
    city: 'Boston',
    folderId: '1J9A7CLVdD8tNsQwhBq2jSHSWP75zLsOg',
    sheetId: '1eoieqdyzvA2Nb4V5PqAbh4brwzHyrCm6jUJRUvyoR3Q',
    tapesFolderId: '1rqG1xbI9y6-IBfOnj_ztnCdx052e4adT',
    photosFolderId: '1tbThOR-BJJQHKbkShpAS-yxd4Z7HxECo',
    completedClipsFolderId: '1iX_NbpWXZ-slb136Ut11uZTgGK18_ErQ',
    strip: [/Set$/i, /[_ ]?\(?\d{1,2}-\d{1,2}-\d{2}\)?$/],
  },
  {
    id: 'jun2026sf',
    year: 2026,
    label: 'June 2026',
    city: 'SF',
    folderId: '1o8W-7rvjTGja6aXAZP12u1qykgE4SFFY',
    sheetId: '1Bohqhc-9F0gRps6YYMq2buuspd6y5wU6Wqr5BI-D2tw',
    tapesFolderId: '1hPbZf6S9Qon9I2DqT3bHenE937dQ4-GN',
    photosFolderId: '1vQbU1hmE-ZrclaNsDvyQltmji06C9eYX',
    completedClipsFolderId: '1i5h5SayfctMKHdemyZBvxTJ6nImbGxJU',
    strip: [/Set$/i, /[_ ]?\(?\d{1,2}-\d{1,2}-\d{2}\)?$/],
  },
  {
    id: 'jun2026nytw',
    year: 2026,
    label: 'June 2026',
    city: 'NY Tech Week',
    folderId: '1etjrvzEQ2EcbzjmH0k9mkBfcAmyXyjCn',
    sheetId: '1LY5ojLQRBfWXJSoTkqydikx-aT9Sfl77659hS8A2vho',
    tapesFolderId: '14sPQStABiwSb9uv8IYbN7HJI1bnPc07q',
    photosFolderId: '1aRra1DxNJSFSNbuhaJJ9107uHUq77TdD',
    completedClipsFolderId: '1RjzeFqbNjGetmNxRZnnWb8PuXuIGJ7aO',
    strip: [/Set$/i],
  },
  {
    id: 'jun2026avocarilla',
    year: 2026,
    label: 'June 2026',
    city: 'AvocaRilla',
    folderId: '12rjdk2zu7VCFIlnL9K_wVNavabHQ1dVP',
    sheetId: null,
    tapesFolderId: '17ihCTNCWn9nmbxwUipFGIBY31s6BHSAq',
    photosFolderId: '1ozD1MQ4wAmcN9WqTMC8hSNhMjo_KIgs8',
    completedClipsFolderId: '1zcP6qrRefeo2wDElXKi1LDO7sNHjtopu',
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
    tapesFolderId: '1QW50mPpFFq-Olu2LQ-_O3G50PXE5fGt8',
    photosFolderId: '1ECJSUXYdONVa90osmZEbGsLlIL5lw64O',
    completedClipsFolderId: '1rsH9yytunfd5l-Vy_rebZpJwcOo55cuE',
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
