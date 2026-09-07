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
  // ------------------------------------------------------------------ 2025 --
  // Folder ids verified against the live Drive during the 2026-09-06 reorganisation. Tape folders
  // were renamed in place from their old names (Set proofs, Proofs, Sets + Highlights…), so the
  // ids are the originals. `strip` rules come from the real filenames in each tapes folder.
  {
    id: 'dec2025', year: 2025, label: 'December 2025', city: 'NYC',
    folderId: '1H8dGrzHv5WoKgAqWfuF9lO2HRoh5-J4w',
    sheetId: '1VBPcY0nRkKWrjSQWqNEvKXzl3--atYgzbvI8nzJ9xY8',
    tapesFolderId: '1dBRPS3L8NuKQPY76jrMyeF-w4Xh7bvO1',
    photosFolderId: '1epa1F55gmRVSAZ9x15mfvw0YFyZs84po',
    completedClipsFolderId: '1Q2k2ITe9HRzaqN14Hubafsncq5MWynFL',
    strip: [/Set$/i],
    note: 'Set tapes are not in Drive; the sheet has requests for Neal, Hayden and Yanjaa.',
  },
  {
    id: 'oct2025techweek', year: 2025, label: 'October 2025', city: 'SF + LA Tech Week',
    folderId: '1ByK-EQUqIstJdDza7ZZuXKGovlj5HLPW',
    sheetId: '1pbV6TD4GNTdhOQ7TzbAloDY1Wq9q-GGIRgd8ykRBDh0',
    tapesFolderId: '1cEUaw0bA_cpc1OdW3NZRGObHa3xxJFzz',      // the LA tapes; the SF tapes are missing from Drive
    photosFolderId: '1XnO53aZQi4GPRLdZCNtuHwXV8sPPIIaI',
    completedClipsFolderId: '1wQ_Me871NhQwfZe6ICiZ0uhm-sBhxhCK',
    // "AULAOctPete.mp4"
    strip: [/^AULAOct/i],
    note: 'One folder and one request sheet cover both Tech Week shows.',
  },
  {
    id: 'sep2025', year: 2025, label: 'September 2025', city: 'NYC',
    folderId: '1Pza8uU9cJdn3BVVe0SD0pugIL0yK6AqO',
    sheetId: '1ysmB0gFIuER0GO8HlKK_zx6xq7gZvu7NuA0avFK0WgQ',
    tapesFolderId: '1ep3AlY65wqZM-b0051Ii8sZBo1LMf0-p',
    photosFolderId: '1ctzrVsCBhMuJVPJav9Yzh9Iz0-W4Y1kk',
    completedClipsFolderId: '1Of0QauXQsFilbrQVIt-GaKwDNDRjgLIu',
    // "AUSep2025AkaashSet.mp4"
    strip: [/^AUSep2025/i, /Set$/i],
  },
  {
    id: 'jul2025', year: 2025, label: 'July 2025', city: 'NYC',
    folderId: '1A_yUvOIwx4pT4gf0YV7edVHGxFH7349w',
    sheetId: '1b54OnJU7WJt7iB1i8NXFV5iWQNMFGqoBOQRgNxZ-cS4',
    tapesFolderId: '16VYjNVBVgME5EeNVqm3lx_SvdS1VCYGc',
    photosFolderId: '1q8WmqCNmA3tTUOq5fYRcton64HRjZrhm',
    completedClipsFolderId: '1VmpDT1rV9ZGG9gXaHY84thohQCca1i70',
    // "AUJuly2025AnnetteSet.mp4"
    strip: [/^AUJuly2025/i, /Set$/i],
  },
  {
    id: 'jun2025nytw', year: 2025, label: 'June 2025', city: 'NY Tech Week',
    folderId: '1MAJqVdUG52oiyH-ZO60k2NVGFvMmS8Lv',
    sheetId: '15I9KtU2rMGBrlXYdo1ht5BKjAFAZ3PQXwk70tRgsjDg',
    tapesFolderId: '1b2D0mcnSmuqlvBhEXdmRBadVQZN33Jmd',
    photosFolderId: '1r92Rqi0sAQGczFN1Lx7BqmjtN8lxPuBg',
    completedClipsFolderId: '16hhxx-K04Rlemk95S_2VW5Zck7cJVWzM',
    // "HumzahSet.mp4"
    strip: [/Set$/i],
    note: 'Request sheet is a 2025 "Timestamps" sheet — read-only in the app.',
  },
  {
    id: 'mar2025sf', year: 2025, label: 'March 2025', city: 'SF',
    folderId: '1JFBTRYNbxtPzBRSolRU0KffxkUSblqgR',
    sheetId: '16aUwlJT-XFMBtdhkaf7g9bzi1k0Mb0UhIxAltqYvIuo',
    tapesFolderId: '1gj_BNteLVEOy096lFyGHBiRiNJu8AmWM',
    photosFolderId: '10cnGgXqx6Y5uEszFaimtTLU_qLqtt3cJ',
    completedClipsFolderId: '1hbuKZ0FZsyBPmOM4bZ3km_MjG_3a5EFs',
    strip: [/Set$/i],
    displayNameOverrides: { FullShowTape: 'Full show' },
    note: 'Only a full-show tape exists; the request sheet is an empty 2025 template.',
  },
  {
    id: 'mar2025nyc', year: 2025, label: 'March 2025', city: 'NYC',
    folderId: '1xn376gXMDwlAn97Aurpczx_5wGSOMJhq',
    sheetId: '1csRfND9TUjs9EpFZPJ9GW0l2BeZIwHW8OZle3CPDqAg',
    tapesFolderId: '1HzarVmZBJ9rrtziI6ZCM994X8W7f8mTI',
    photosFolderId: '1vUzcEzP7noOcquR8azzbhuUNqWZc7Cc6',
    completedClipsFolderId: '15FHwftGc385u3NLj9ogPBSYFYMnOGTCP',
    // "AmandaSet.mp4"
    strip: [/Set$/i],
    note: 'Request sheet is a 2025 "Timestamps" sheet — read-only in the app.',
  },
  {
    id: 'jan2025', year: 2025, label: 'January 2025', city: 'NYC',
    folderId: '1ESemyqzDV_6vtkH9QTPKgGibiqctpb9H',
    sheetId: '1Qw6JX5EtLwdtV2iEoOFmnOYqGY3DtycPDuH0peEoGEs',
    tapesFolderId: '1K91lWRnL9f8Ed3uQ-DaR9QPWX2IyKdQL',
    photosFolderId: '14E_zCC3Fw8QgUo4rgyHWAw7iwoWx1lfx',
    completedClipsFolderId: '1jQgPRbK4ySFn9hY8IJM7YFHRZjRCO2-M',
    // "AUJan31BetsyFullSet.mp4"
    strip: [/^AUJan31/i, /FullSet$/i],
    note: 'Request sheet is a 2025 "Lines" sheet — read-only in the app.',
  },

  // ------------------------------------------------------------------ 2024 --
  {
    id: 'nov2024roast', year: 2024, label: 'November 2024', city: 'NYC — Immigrant Founders Roast',
    folderId: '1Wh85qzwCT-6HK0LGKsZgoXLNw_DhHgHr',
    sheetId: '1Oasa4cEObPsatTfjfXgaxhPt4_eJ4SQKsRy3PbRM0yk',
    tapesFolderId: '1nCmTAcfCl0uFnJR9FBXSiI7oMqkt2fjs',
    photosFolderId: '1NFnPhMsT1lsMJBN1mQNe3bEOnhDisnps',
    completedClipsFolderId: '1XeJM4Nw1tXjYJYYV-f6-7ztFlZye9e2D',
    // "Divya Set.mp4", "Neal Set & Sponor Plug.mp4"
    strip: [/ Set( & .*)?$/i],
    note: 'Request sheet is a 2024-format sheet — read-only in the app.',
  },
  {
    id: 'nov2024mango', year: 2024, label: 'November 2024', city: 'NYC — Mango',
    folderId: '1CRTYyS8qdYPyyeA0jmdf1rC2cyp2MjNt',
    sheetId: null,
    tapesFolderId: '1vRpquQwSf-Por1D6H_EJ497WFBR4UDp9',
    photosFolderId: '11WYBUj0dye6px1wU3Fqgn9QSgBawSrsc',
    completedClipsFolderId: '1ClC-n2C7fNvPrOTBFf7pVVojTXe71ZKv',
    strip: [/Set$/i],
    note: 'No tapes or photos in Drive.',
  },
  {
    id: 'oct2024latw', year: 2024, label: 'October 2024', city: 'LA Tech Week',
    folderId: '1hkCO5K0rzDxS4OpmT5Yz67c5xIlFtm9O',
    sheetId: '1O7Ha6w__swUZsmPj43QhoAZIrHSm4Hm7KoKNXGU5IdA',
    tapesFolderId: '1zw7QuHMLTqz6Db8BOt2k3PwzFAjlNA_v',
    photosFolderId: '1pOH7wSiZmnEQBG-x0shlHIF29LfrKAbF',
    completedClipsFolderId: '1zatjbAbJeg0vaXfBAoB3LwgU9AAYGOuZ',
    // "AU_LATW_MicAudio.mp4" — one full-show tape
    strip: [/^AU_LATW_/i],
    displayNameOverrides: { MicAudio: 'Full show' },
    note: 'One full-show tape. Request sheet is a 2024-format sheet — read-only in the app.',
  },
  {
    id: 'oct2024sftw', year: 2024, label: 'October 2024', city: 'SF Tech Week',
    folderId: '1kKwQjZPhQElzV6aGX2RTb6XS4bsUvLXO',
    sheetId: '1NTO5uKvNRp_I-5KeQVVkCxXbBNmYurmSV4CoeGp2uz0',
    tapesFolderId: '1yDFtkpqMH0yt1tjL6NHPQI87MM2noPk8',
    photosFolderId: '1vOBjKX6E38EC3r9YGNyNul5KQfXmwoVD',
    completedClipsFolderId: '12_g3wT4JPwyMvwyi5tAWewaEladcZrhn',
    // "SF_FULL_TAPE.MP4"
    strip: [/^SF_/i],
    displayNameOverrides: { FULL_TAPE: 'Full show' },
    note: 'One full-show tape. Request sheet is a 2024-format sheet — read-only in the app.',
  },
  {
    id: 'jul2024', year: 2024, label: 'July 2024', city: 'NYC',
    folderId: '1p7UzxuwHh89ZuvZmdvy56OnK-WADlqrt',
    sheetId: null,
    tapesFolderId: '1x1_CXinjTnlp7fLWWbm7ZfrrYvlEJkX5',
    photosFolderId: '12d9aH6Nn4Ks1hjTNA8c9PQ_6Rwxbl58C',
    completedClipsFolderId: '1Vg44prXa5lcDIC2oD1aYZHh83xPoQJa5',
    // "Copy of AUFullShowReview.mp4"
    strip: [/^Copy of /i],
    displayNameOverrides: { AUFullShowReview: 'Full show' },
    note: 'One full-show tape; no request sheet.',
  },
  {
    id: 'jun2024nytw', year: 2024, label: 'June 2024', city: 'NY Tech Week',
    folderId: '1-0E_ILIOaJybPDfREtP6Mr7DyLO4nWGo',
    sheetId: null,
    tapesFolderId: '1kUPeIALncZ6yw87Eyo73VX29hXBfq4Ft',
    photosFolderId: '1u0YX_tq-8cDbfPTI1Lw2PiU-k2AzZvs_',
    completedClipsFolderId: '1Vodpp_zyNkwdOlXQBp7_-1Pz6_OK5a2Y',
    strip: [/Set$/i],
    note: 'Photos only; no tapes, clips or request sheet in Drive.',
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
  // Drive's duplicate prefix ("Copy of Neal Set.mp4") is never part of a performer's name.
  name = name.replace(/^copy of\s+/i, '')
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
