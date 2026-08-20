// Video player wrapper: exact playhead reads, precise seeks, and back-to-back
// ranged playback.
//
// Measured against DavidS_4-23-26.mp4 (4.33 GB, 4K, 453.82s) through the Worker proxy:
// duration matched ffprobe exactly, seeks landed on the requested second, and a ranged
// play stopped 10ms past its target. The 10ms is the rAF quantum (~16.7ms at 60Hz) and is
// the practical floor for a JS-driven stop.

/**
 * Build the proxy URL for a tape. There is deliberately no default: a placeholder hostname
 * would fail as an opaque media error, and the user would be told the file might not be shared
 * when the real problem is that they never pasted the Worker URL.
 */
export function tapeUrl({ proxyBase, fileId, token }) {
  if (!proxyBase) {
    throw new Error('No tape proxy URL configured — open Settings and paste the Cloudflare Worker URL.')
  }
  const url = new URL(proxyBase)
  url.searchParams.set('id', fileId)
  if (token) url.searchParams.set('t', token)
  return url.toString()
}

export class Player {
  constructor(videoEl) {
    this.el = videoEl
    // Required. Drive's bytes come back with `cross-origin-resource-policy: same-site`,
    // which blocks a *no-cors* cross-origin media load; requesting in CORS mode sidesteps
    // CORP, and the proxy answers with `access-control-allow-origin`.
    this.el.crossOrigin = 'anonymous'
    this._playToken = 0
  }

  get duration() {
    return Number.isFinite(this.el.duration) ? this.el.duration : null
  }

  /** The playhead — this is what the "now" button reads. */
  now() {
    return this.el.currentTime || 0
  }

  /**
   * `preload: 'auto'` is what makes scrubbing feel instant. A 480p proxy is ~93 MB, so the
   * browser can pull the whole thing in ~20s and every later seek lands in the buffer with no
   * network round trip. Measured: cold seeks cost ~2-3s each on the throttled anonymous path,
   * buffered seeks are effectively free. Use 'metadata' for a 4-7 GB master, where eager
   * buffering would be pointless.
   */
  load(src, { preload = 'auto' } = {}) {
    this.cancel()
    this.el.preload = preload
    return new Promise((resolve, reject) => {
      const onMeta = () => { cleanup(); resolve(this.duration) }
      const onErr = () => {
        cleanup()
        const code = this.el.error?.code
        // code 4 (SRC_NOT_SUPPORTED) is what you get when the proxy handed back an error
        // page instead of video, so point at the likely cause rather than the symptom.
        reject(new Error(
          code === 4
            ? 'Could not load this tape. The proxy may be unreachable, the token wrong, or the file not shared publicly.'
            : `Video error (code ${code ?? '?'}).`
        ))
      }
      const cleanup = () => {
        this.el.removeEventListener('loadedmetadata', onMeta)
        this.el.removeEventListener('error', onErr)
      }
      this.el.addEventListener('loadedmetadata', onMeta)
      this.el.addEventListener('error', onErr)
      this.el.src = src
    })
  }

  /** Seek and resolve only once the browser confirms the new position is ready. */
  seek(seconds, { timeout = 30000 } = {}) {
    const target = Math.max(0, Math.min(seconds, this.duration ?? seconds))
    return new Promise((resolve, reject) => {
      // A seek to where we already are fires no 'seeked' event, so don't wait for one.
      if (Math.abs(this.el.currentTime - target) < 0.02) return resolve()
      const timer = setTimeout(() => { cleanup(); reject(new Error('Seek timed out.')) }, timeout)
      const onSeeked = () => { cleanup(); resolve() }
      const onErr = () => { cleanup(); reject(new Error('Video error while seeking.')) }
      const cleanup = () => {
        clearTimeout(timer)
        this.el.removeEventListener('seeked', onSeeked)
        this.el.removeEventListener('error', onErr)
      }
      this.el.addEventListener('seeked', onSeeked)
      this.el.addEventListener('error', onErr)
      this.el.currentTime = target
    })
  }

  pause() {
    this.el.pause()
  }

  /** Abandon any in-flight playRanges. */
  cancel() {
    this._playToken += 1
    return this._playToken
  }

  /**
   * Play an ordered list of ranges back to back, then pause — the "play timestamps"
   * button. Monitoring uses requestAnimationFrame rather than the `timeupdate` event,
   * which only fires about 4x/sec and would overshoot a range end by up to ~250ms.
   */
  async playRanges(ranges, { onEnter, onProgress, onDone } = {}) {
    const token = this.cancel()
    const list = ranges.filter(r => r && r.e > r.s)
    if (!list.length) return

    for (let i = 0; i < list.length; i++) {
      if (token !== this._playToken) return
      const range = list[i]

      await this.seek(range.s)
      if (token !== this._playToken) return
      onEnter?.(i, range)

      try {
        await this.el.play()
      } catch {
        // Autoplay was refused (no user gesture yet). Leave the playhead parked at the
        // range start so the native controls can take over.
        return
      }

      const finished = await new Promise(resolve => {
        const tick = () => {
          if (token !== this._playToken) return resolve(false)
          if (this.el.ended) return resolve(true)
          if (this.el.currentTime >= range.e) return resolve(true)
          onProgress?.(this.el.currentTime, i)
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })

      if (!finished || token !== this._playToken) return
    }

    if (token !== this._playToken) return
    this.el.pause()
    onDone?.()
  }
}
