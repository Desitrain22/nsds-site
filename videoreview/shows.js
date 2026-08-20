// Year -> show -> Drive folder. Pinned by ID on purpose: the real Drive folder names
// contain a forward slash ("April 2026 Tapes/Photos"), which the local Drive mount silently
// rewrites, so matching on name is unreliable. IDs verified against the live Drive.

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
    strip: [/ Set$/i],
  },
  {
    id: 'may2026bos',
    year: 2026,
    label: 'May 2026',
    city: 'Boston',
    folderId: '1J9A7CLVdD8tNsQwhBq2jSHSWP75zLsOg',
    sheetId: null,
    strip: [/Set$/i, /[_ ]?\(?\d{1,2}-\d{1,2}-\d{2}\)?$/],
  },
  {
    id: 'jun2026sf',
    year: 2026,
    label: 'June 2026',
    city: 'SF',
    folderId: '1o8W-7rvjTGja6aXAZP12u1qykgE4SFFY',
    sheetId: null,
    strip: [/Set$/i, /[_ ]?\(?\d{1,2}-\d{1,2}-\d{2}\)?$/],
  },
  {
    id: 'jun2026nytw',
    year: 2026,
    label: 'June 2026',
    city: 'NY Tech Week',
    folderId: '1etjrvzEQ2EcbzjmH0k9mkBfcAmyXyjCn',
    sheetId: '1LY5ojLQRBfWXJSoTkqydikx-aT9Sfl77659hS8A2vho',
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
    strip: [/Set$/i, /[_ ]?\(?\d{1,2}-\d{1,2}-\d{2}\)?$/],
  },
]

/**
 * Tape filename -> unlisted YouTube video id.
 *
 * Drive cannot serve video to a web page (it 403s any request with
 * `Sec-Fetch-Site: cross-site`, which JS cannot remove), so the playable copy lives on
 * YouTube as an unlisted upload. Fill this in after uploading — `node tools/publish-tapes.mjs
 * <show>` prepares the files and prints the block to paste here.
 *
 * Keyed by the master's filename in Drive, so the mapping survives renames of everything else.
 */
export const YOUTUBE = {
  apr2026: {
    // 'DavidS_4-23-26.mp4': 'dQw4w9WgXcQ',
  },
}

/** The unlisted YouTube id for a tape, or null if it hasn't been uploaded yet. */
export function youtubeIdFor(showId, filename) {
  return YOUTUBE[showId]?.[filename] || null
}

// Reels, sizzles and recaps live alongside the set tapes but aren't anyone's set.
const GLOBAL_EXCLUDE = [/sizzle/i, /highlight/i, /update/i, /recap/i]

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
