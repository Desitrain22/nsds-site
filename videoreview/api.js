// Apps Script client.
//
// The Content-Type here is load-bearing. Apps Script never sees an OPTIONS request, so it
// cannot answer a CORS preflight — a POST with `application/json` triggers one and fails
// every time from a browser. `text/plain` makes it a CORS "simple request" with no
// preflight; the server reads the JSON back out of e.postData.contents.
//
// Apps Script also 302s to script.googleusercontent.com. fetch follows that by default;
// do not set redirect:'manual'.

// clipId -> { fingerprint, promise }. Keyed on the payload as well as the id, because
// deduping on the id alone silently discards edits: a re-render hands the user a fresh,
// enabled Save button while the first request is still flying, so the second click can carry
// DIFFERENT ranges and would otherwise be answered with the first call's result — reported as
// "Saved", dirty cleared, edit lost.
const inFlight = new Map()

/**
 * Read-side request coalescing.
 *
 * Two things made the picker feel broken. Identical reads overlapped — restoreFromUrl asked for the
 * same tape list twice on every deep link, and a double-click asked twice more — and revisiting a
 * show you had already opened paid full price again, even though the answer is a Drive folder
 * listing that only changes when the nightly sync runs.
 *
 * So: concurrent identical reads share one flight, and `ttl` lets a read also serve from the last
 * answer. getClips deliberately passes NO ttl. Its rows carry the `rev` that the conflict check
 * saves against, and handing back a cached rev would make the server reject a perfectly good save
 * as a conflict — coalescing is safe there, reuse is not.
 */
const reads = new Map()

function coalesce(key, ttl, run) {
  const hit = reads.get(key)
  if (hit && (hit.inFlight || (ttl && Date.now() - hit.at < ttl))) return hit.promise

  const entry = { at: Date.now(), inFlight: true, promise: null }
  entry.promise = run().then(
    value => { entry.inFlight = false; entry.at = Date.now(); return value },
    // A failure is never worth remembering — drop it so the next attempt is a real retry.
    err => { if (reads.get(key) === entry) reads.delete(key); throw err },
  )
  reads.set(key, entry)
  return entry.promise
}

/** Forget cached reads. Called whenever the passphrase changes. */
export function invalidate(prefix = '') {
  for (const key of [...reads.keys()]) {
    if (!prefix || key.startsWith(prefix)) reads.delete(key)
  }
}

// Drive folder contents only change when tools/youtube-sync.mjs runs, so a minute of reuse turns
// every revisit in a review session into an instant one.
const TAPES_TTL_MS = 60_000

export class Api {
  constructor({ endpoint, password }) {
    this.endpoint = endpoint
    this.password = password
  }

  async call(action, payload = {}, { retries = 2 } = {}) {
    if (!this.endpoint) throw new Error('No Apps Script URL configured.')

    let lastError
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action, password: this.password, ...payload }),
        })
        if (!res.ok) throw new Error(`Backend returned ${res.status}`)

        const text = await res.text()
        let data
        try {
          data = JSON.parse(text)
        } catch {
          // Almost always the Google sign-in page, i.e. the deployment isn't set to
          // "Anyone" access.
          throw new Error('Backend returned HTML, not JSON — check the deployment is set to "Anyone" access.')
        }
        if (data.ok === false) {
          const err = new Error(data.error || 'Backend error')
          err.data = data
          throw err
        }
        return data
      } catch (err) {
        lastError = err
        // A rejected password or a real conflict won't improve on retry.
        if (/bad password/i.test(err.message) || err.data?.conflict) break
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 400 * Math.pow(3, attempt)))
        }
      }
    }
    throw lastError
  }

  /**
   * Cheap password check for the gate.
   *
   * The gate used to prove the passphrase by running listTapes on the first show and throwing the
   * result away — a full recursive Drive listing, seconds of it, to learn one boolean. `ping` does
   * nothing but answer. Backends deployed before this action existed answer "unknown action", which
   * we read as a correct password: getting that far already means checkPassword passed.
   */
  async ping() {
    try {
      return await this.call('ping', {}, { retries: 1 })
    } catch (err) {
      if (/unknown action/i.test(err.message)) return { ok: true, stale: true }
      throw err
    }
  }

  listTapes(show) {
    // tapesFolderId pins the scan root; null lets the backend pick the single tapes-like subfolder.
    return coalesce(
      `tapes:${show.folderId}:${show.tapesFolderId || ''}:${show.completedClipsFolderId || ''}`,
      TAPES_TTL_MS,
      () => this.call('listTapes', {
        folderId: show.folderId,
        tapesFolderId: show.tapesFolderId || null,
        // The finished clips folder, so the page can list "your finished clips" beside the requests.
        completedClipsFolderId: show.completedClipsFolderId || null,
      }))
  }

  getClips(show, videoFileId) {
    return coalesce(`clips:${show.folderId}:${videoFileId}`, 0, () => this.call('getClips', {
      folderId: show.folderId,
      // Pinning the sheet is the only reliable answer for shows whose request sheet lives in
      // a subfolder (NYTW's is inside "Set Tapes"); folder-scanning alone would miss it and
      // then helpfully create a duplicate the editing team never reads.
      sheetId: show.sheetId || null,
      showLabel: `${show.label}${show.city ? ` (${show.city})` : ''}`,
      videoFileId,
    }))
  }

  /**
   * Save a clip.
   *
   * An identical repeat (double-click, or a retry of the same bytes) collapses onto the
   * in-flight promise. A *different* payload for the same clip is queued behind it instead,
   * so nothing is silently dropped and two rows are never appended.
   *
   * The request body is built lazily, inside the queued callback, so a chained save reads
   * `clip.rev` as it stands after the previous save resolved rather than the stale value from
   * when the click happened.
   */
  saveClip(show, clip, duration) {
    const key = clip.clipId
    const content = () => ({
      clipId: clip.clipId,
      name: clip.name,
      ranges: clip.ranges.filter(r => r.s !== null && r.e !== null && r.e > r.s),
      notes: clip.notes,
      links: clip.links,
      thumb: clip.thumb,
      granular: clip.granular,
      videoFileId: clip.videoFileId,
      duration,
    })
    const fingerprint = JSON.stringify(content())

    const existing = inFlight.get(key)
    if (existing && existing.fingerprint === fingerprint) return existing.promise

    const send = () => this.call('saveClip', {
      folderId: show.folderId,
      sheetId: show.sheetId || null,
      // A first-ever save creates the sheet; this makes its A1 link point at the tapes folder.
      tapesFolderId: show.tapesFolderId || null,
      showLabel: `${show.label}${show.city ? ` (${show.city})` : ''}`,
      clip: { ...content(), rev: clip.rev },
    })

    // Chain after any in-flight save for this clip; swallow its rejection so a failure
    // doesn't cancel the follow-up.
    const promise = existing
      ? existing.promise.then(send, send)
      : send()

    const entry = { fingerprint, promise }
    inFlight.set(key, entry)
    promise.catch(() => {}).then(() => {
      if (inFlight.get(key) === entry) inFlight.delete(key)
    })
    return promise
  }

  deleteClip(show, clipId) {
    return this.call('deleteClip', {
      folderId: show.folderId,
      sheetId: show.sheetId || null,
      showLabel: `${show.label}${show.city ? ` (${show.city})` : ''}`,
      clipId,
    })
  }
}

/**
 * Drive share links aren't images — /file/d/<id>/view serves an HTML page, so it renders
 * as a broken image in an <img>. The thumbnail endpoint does work cross-origin
 * (verified: 206 with `access-control-allow-origin: *` even under Sec-Fetch-Site:
 * cross-site, which is what blocks the download endpoint).
 */
export function toImageUrl(raw) {
  const url = String(raw || '').trim()
  if (!url) return null

  const driveId =
    url.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/)?.[1] ||
    url.match(/[?&]id=([A-Za-z0-9_-]{10,})/)?.[1] ||
    url.match(/\/d\/([A-Za-z0-9_-]{10,})/)?.[1]

  if (driveId) return `https://drive.google.com/thumbnail?id=${driveId}&sz=w1200`
  if (/^https?:\/\//i.test(url)) return url
  return null
}
