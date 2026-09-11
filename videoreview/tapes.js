// The ONE tape-discovery rule, shared by dev-server.mjs, publish-tapes.mjs and test.mjs.
// Code.gs carries byte-identical copies of the three literals and MAX_DEPTH; test.mjs asserts they
// haven't drifted. (Not imported by shows.js/app.js — shows.js re-exports EXCLUDED_TAPE_RE instead —
// to avoid an import cycle.)

/** A subfolder that IS the tapes root: the reorganised `tapes/`, or the legacy names still live. */
export const TAPES_FOLDER_RE = /^(tapes|set tapes|sets|footage)$/i

/**
 * Subfolders never entered while scanning for tapes. Finished clips are NOT catchable by name
 * (BenClip_…, PeterClip1.mp4, Daycares.mp4 …), so exclusion has to be by folder. Measured before
 * this rule: NYTW listed 18 "tapes", 15 of them finished clips from its Clips/ folder.
 */
export const SKIP_FOLDER_RE = /^(flicks|photos?|stills|proxies|clips|completed[ _-]?clips|extras?)$/i

/** Reels, sizzles and recaps that live alongside set tapes but aren't anyone's set. */
export const EXCLUDED_TAPE_RE = /sizzle|highlight|update|recap|rough/i

/** Scan the tapes root plus this many levels of subfolders. Matches rclone's --max-depth MAX_DEPTH+1. */
export const MAX_DEPTH = 1

/**
 * Which child of the show folder the scan starts from — same rule as Code.gs resolveTapesRoot.
 * `topLevelEntries` are rclone lsjson entries of the show folder itself (depth 1).
 * A followed shortcut's ID is "<targetId>\t<shortcutId>"; we want the target.
 */
export function pickTapesRoot(topLevelEntries, tapesFolderId) {
  if (tapesFolderId) return { id: tapesFolderId, mode: 'pinned' }
  const named = topLevelEntries.filter(e => e.IsDir && TAPES_FOLDER_RE.test(e.Name))
  return named.length === 1
    ? { id: String(named[0].ID).split('\t')[0], mode: 'named' }
    : { id: null, mode: 'showFolder' }
}

/**
 * rclone lsjson entries listed FROM the tapes root (with -R --max-depth MAX_DEPTH+1) -> the
 * reviewable tapes. `isExcludedName` carries any per-show exclusions from shows.js.
 */
export function pickTapes(entries, isExcludedName = () => false) {
  return entries.filter(e => {
    if (e.IsDir || !/^video\//.test(e.MimeType || '')) return false
    const folders = String(e.Path).split('/').slice(0, -1)
    if (folders.length > MAX_DEPTH) return false
    if (folders.some(f => SKIP_FOLDER_RE.test(f))) return false
    return !EXCLUDED_TAPE_RE.test(e.Name) && !isExcludedName(e.Name)
  })
}
