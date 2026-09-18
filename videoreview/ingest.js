// The ONE ingest rule set: a file in a videographer's Dropbox/Drive folder -> where it lands in
// the NSDS Drive. Shared by the upload portal (browser) and the transfer worker (node), which is
// the whole point of it living here: if the two disagree, ingest writes files that the review app
// then refuses to list. Zero dependencies, no DOM, no node builtins — importable by both.
//
// The destination layout is the one every show folder already uses, verified against live Drive:
//
//   <Month> <Year> (<City>)/
//     tapes/            "<Performer> Set.mp4"   <- the only thing the review app lists
//     photos/  extras/  completed_clips/
//
// Tapes are RENAMED on the way in. April's masters arrived as "AndrewG_7-30-26.mp4" and are now
// "AndrewG Set.mp4"; that convention is why shows.js can get away with `strip: [/ Set$/i]`, and it
// is why a show ingested through here needs no per-show config at all.

import { SKIP_FOLDER_RE, EXCLUDED_TAPE_RE } from './tapes.js'

/**
 * Which kind of folder link a videographer pasted, and the parts needed to read it.
 *
 * Runs in the browser before anything is sent, so the common mistakes get named immediately
 * rather than after a slow server round trip. Every rejection here is a real failure someone
 * would otherwise hit hours later:
 *
 *   /scl/fi/  is a single FILE share, not a folder.
 *   /scl/fo/  without rlkey is a link copied out of the address bar after navigating, which
 *             drops the key and 404s server-side.
 *   /file/d/  is one Drive file.
 *   my-drive  is the pasting person's own Drive home, which we cannot read at all.
 *
 * `normalized` strips the volatile bits (`st=`, `e=`, `dl=`) and keeps the durable ones, so the
 * same folder pasted twice compares equal.
 *
 * @returns {{source:'dropbox'|'drive', normalized:string, ...}|{source:null, error:string}}
 */
export function parseShareLink(raw) {
  const text = String(raw || '').trim()
  if (!text) return { source: null, error: 'Paste the folder link first.' }

  let url
  try { url = new URL(text) } catch { return { source: null, error: "That doesn't look like a link." } }

  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const path = url.pathname

  if (host === 'dropbox.com' || host.endsWith('.dropbox.com')) {
    if (/^\/scl\/fi\//.test(path)) {
      return { source: null, error: "That's a link to one file, not the folder it's in." }
    }
    const m = /^\/scl\/fo\/([^/]+)\/([^/?]+)/.exec(path)
    if (!m) return { source: null, error: "That's a Dropbox link, but not to a shared folder." }
    const rlkey = url.searchParams.get('rlkey')
    if (!rlkey) {
      return { source: null, error: 'The link is missing its rlkey — copy it from Dropbox\u2019s Share button rather than the address bar.' }
    }
    return {
      source: 'dropbox',
      linkKey: m[1],
      secureHash: m[2],
      rlkey,
      // The durable form. `st` is a short-lived token and `e`/`dl` are view preferences.
      normalized: `https://www.dropbox.com/scl/fo/${m[1]}/${m[2]}?rlkey=${rlkey}`,
    }
  }

  if (host === 'drive.google.com' || host === 'docs.google.com') {
    if (/^\/file\/d\//.test(path)) {
      return { source: null, error: "That's one Drive file, not a folder." }
    }
    if (/^\/drive\/(my-drive|home|recent|shared-with-me|starred|trash)/.test(path)) {
      return { source: null, error: "That's your own Drive home, not a shared folder link." }
    }
    const m = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(path)
    const id = m ? m[1] : url.searchParams.get('id')
    if (!id) return { source: null, error: "That's a Google link, but no folder id in it." }
    return { source: 'drive', folderId: id, normalized: `https://drive.google.com/drive/folders/${id}` }
  }

  return { source: null, error: 'Only Dropbox and Google Drive folder links work here.' }
}

/** Masters we have actually seen, plus the obvious siblings. Lowercase, no dot. */
const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'mxf', 'avi', 'mkv', 'mts', 'm2ts'])

/** Stills, including the raw formats a photographer's "Selects" folder tends to hold. */
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'tif', 'tiff',
                           'dng', 'cr2', 'cr3', 'arw', 'raf', 'nef', 'orf', 'rw2'])

/** "AndrewG_7-30-26.mp4" -> ".mp4". Empty string when there is no extension. */
export function extOf(name) {
  const m = /\.[^.\/]+$/.exec(name)
  return m ? m[0] : ''
}

/**
 * Performer from a tape filename: "DavidS_4-23-26.mp4" -> "DavidS", "Aakash Set.mp4" -> "Aakash".
 * Idempotent, so running it on an already-renamed tape is safe.
 *
 * NB: tools/lib/tapes.mjs has a byte-identical twin of this, because the node tooling predates
 * this module. Collapse that one into an import from here — it cannot be done while the
 * videoreview refactor is in flight without conflicting with it.
 */
export function performerFrom(filename) {
  let n = filename.replace(/\.[^.]+$/, '').trim()
  n = n.replace(/[_ ]?\(?\d{1,2}-\d{1,2}-\d{2,4}\)?/g, ' ')
  n = n.replace(/\bset\b/i, ' ').replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim()
  return n || filename
}

/** Strip the leading slash Dropbox manifests carry, and collapse any doubled separators. */
function rel(path) {
  return String(path).replace(/^\/+/, '').replace(/\/{2,}/g, '/')
}

/**
 * Cities are typed by hand, so "NY", "new york" and "NYC" all mean the same room. Only used to
 * decide whether a declared show already exists — the folder keeps whatever was typed.
 */
export const CITY_ALIASES = {
  ny: 'NYC', nyc: 'NYC', 'new york': 'NYC', 'new york city': 'NYC', manhattan: 'NYC',
  sf: 'SF', 'san francisco': 'SF', la: 'LA', 'los angeles': 'LA',
  bos: 'Boston', boston: 'Boston',
  nytw: 'NY Tech Week', 'ny tech week': 'NY Tech Week', 'nyc tech week': 'NY Tech Week',
}

export function normalizeCity(city) {
  const raw = String(city || '').trim()
  if (!raw) return ''
  const key = raw.toLowerCase().replace(/\s+/g, ' ')
  return CITY_ALIASES[key] || raw
}

/**
 * Does the show a videographer just declared already exist?
 *
 * `exact` means don't create a second folder — offer the existing show instead. That is the real
 * case from the handoff notes: "June 2026 NY Tech week (Folder already exists, please transfer
 * these photos/videos to it)".
 *
 * `sameMonth` is a warning, not a block: June 2026 genuinely has three shows (SF, NY Tech Week,
 * AvocaRilla), so the city is the only thing telling them apart and a typo there is quiet.
 *
 * `shows` are the records listShows returns: { folderId, label, month, year, city, ... }.
 */
export function findShowCollision(shows, { month, year, city }) {
  const want = normalizeCity(city).toLowerCase()
  const sameSlot = (shows || []).filter(s => Number(s.month) === Number(month) && Number(s.year) === Number(year))
  const exact = sameSlot.find(s => normalizeCity(s.city).toLowerCase() === want)
  if (exact) return { kind: 'exact', show: exact }
  if (sameSlot.length) return { kind: 'sameMonth', shows: sameSlot }
  return null
}

/**
 * Where one source file goes. Returns { kind, dest, why }.
 *
 *   kind 'tape'  -> tapes/   reviewable; drives everything downstream (YouTube, clip requests)
 *        'photo' -> photos/  copied, never reviewable
 *        'extra' -> extras/  sizzles, recaps, intros, and anything from a folder we skip
 *        'other' -> extras/_source/  unrecognised, but still COPIED and still counted
 *
 * Order matters, and each rule earns its place:
 *
 *  1. Type first: a still is a photo no matter which folder it arrived in. Testing the source
 *     folder before the type is wrong and was the first version of this function — it filed a jpg
 *     from the photographer's own "photos/" folder as an extra, at extras/photos/…, so the show's
 *     photos ended up split across two places depending on how the source was organised.
 *  2. For VIDEOS only, a source folder matching SKIP_FOLDER_RE (clips/, flicks/, completed_clips/,
 *     extras/, photos/ ...) downgrades it to an extra. A video inside the videographer's own
 *     "Clips" folder is a finished cut, not a set — NYTW listed 18 "tapes", 15 of them finished
 *     clips, before that rule existed.
 *  3. Then EXCLUDED_TAPE_RE (sizzle|highlight|update|recap) sends a video to extras/ rather than
 *     tapes/. It has to: the review app applies the same regex when listing, so a sizzle written
 *     into tapes/ would be copied, transcoded, uploaded to YouTube, and then never shown.
 *  4. The extension is PRESERVED. A .mov master becomes "<Performer> Set.mov" — renaming it to
 *     .mp4 without transcoding produces a file ffmpeg will open and YouTube may reject.
 *
 * Nothing is ever silently dropped. An unrecognised file is 'other', not discarded, so the
 * preview can show it and the counts still reconcile against the source's own total.
 */
export function classify(path, { isDir = false } = {}) {
  const p = rel(path)
  const parts = p.split('/')
  const name = parts[parts.length - 1]
  const folders = parts.slice(0, -1)

  if (isDir) return { kind: 'dir', dest: null, why: 'folder' }
  if (!name) return { kind: 'other', dest: null, why: 'empty name' }

  const ext = extOf(name)
  const bare = ext.slice(1).toLowerCase()

  if (IMAGE_EXT.has(bare)) {
    // Don't nest photos/photos/… when the source already grouped them under that name.
    const inner = folders.filter((f, i) => !(i === 0 && /^photos?$/i.test(f)))
    return { kind: 'photo', dest: ['photos', ...inner, name].join('/'), why: 'still' }
  }

  if (VIDEO_EXT.has(bare)) {
    const skipped = folders.find(f => SKIP_FOLDER_RE.test(f))
    if (skipped) return { kind: 'extra', dest: `extras/${p}`, why: `video inside "${skipped}/"` }
    if (EXCLUDED_TAPE_RE.test(name)) {
      return { kind: 'extra', dest: `extras/${name}`, why: 'reel, not a set' }
    }
    return { kind: 'tape', dest: `tapes/${performerFrom(name)} Set${ext}`, why: 'set tape' }
  }

  return { kind: 'other', dest: `extras/_source/${p}`, why: `unrecognised type "${bare || 'none'}"` }
}

/**
 * Classify a whole manifest and find the collisions.
 *
 * Two sources can land on one destination — "Dan_part1.mp4" and "Dan_part2.mp4" both reduce to
 * "tapes/Dan Set.mp4", and the second copy would overwrite the first with nothing in any log to
 * say so. Silently numbering the loser ("Dan Set 2.mp4") would be exactly the kind of quiet guess
 * this codebase refuses to make, so collisions are REPORTED and the portal blocks submit until a
 * human renames one. That is what makes Jack's confirm click mean something.
 *
 * `entries` are { path, bytes, isDir? } — the shape nsds_fetch.py's enumerate_share already
 * returns, and close enough to rclone lsjson to map in one step.
 */
export function routeAll(entries) {
  const rows = []
  const counts = { tape: 0, photo: 0, extra: 0, other: 0 }
  let bytes = 0

  for (const e of entries) {
    const { kind, dest, why } = classify(e.path, { isDir: e.isDir })
    if (kind === 'dir') continue
    rows.push({ src: rel(e.path), bytes: Number(e.bytes) || 0, kind, dest, why, href: e.href })
    counts[kind] = (counts[kind] || 0) + 1
    bytes += Number(e.bytes) || 0
  }

  const byDest = new Map()
  for (const r of rows) {
    if (!r.dest) continue
    if (!byDest.has(r.dest)) byDest.set(r.dest, [])
    byDest.get(r.dest).push(r)
  }
  const duplicates = [...byDest.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([dest, group]) => ({ dest, sources: group.map(r => r.src) }))

  rows.sort((a, b) => a.src.localeCompare(b.src))
  return { rows, counts, bytes, duplicates }
}
