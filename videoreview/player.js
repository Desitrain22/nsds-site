// Video player wrapper over the YouTube IFrame Player API.
//
// WHY YOUTUBE AND NOT DRIVE
// Drive cannot serve video to a web page at all: `drive.usercontent.google.com` returns
// 403 + an HTML error page to any request carrying `Sec-Fetch-Site: cross-site`. Measured by
// bisecting headers — `same-origin`, `same-site` and `none` all return 206; only `cross-site`
// is refused. That header is browser-controlled and forbidden to JS, so no <video> on another
// origin can ever load a Drive file. Apps Script can't bridge it either (text-only MIME types,
// ~50 MB response cap, and no HTTP Range support, so no seeking).
//
// YouTube solves it with no extra infrastructure: unlisted uploads, an adaptive quality ladder
// that defaults low and lets the viewer pick 1080p, and an API that exposes exactly what clip
// marking needs — getCurrentTime, seekTo, playVideo, pauseVideo, getDuration, onStateChange.
//
// This module keeps the same shape the rest of the app already used, so app.js barely changed.

const API_SRC = 'https://www.youtube.com/iframe_api'

// YouTube has no 'seeked' event, so a seek is confirmed by polling getCurrentTime().
const SEEK_POLL_MS = 60
const SEEK_TOLERANCE = 0.35

let apiReady = null

/** Load the IFrame API once, resolving when YT.Player is constructible. */
function loadApi() {
  if (apiReady) return apiReady
  apiReady = new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT)

    // The API calls this global when it's done. Chain any existing one rather than clobbering.
    const previous = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      previous?.()
      resolve(window.YT)
    }

    if (!document.querySelector(`script[src="${API_SRC}"]`)) {
      const tag = document.createElement('script')
      tag.src = API_SRC
      tag.async = true
      tag.onerror = () => reject(new Error('Could not load the YouTube player API — check your connection.'))
      document.head.append(tag)
    }
    setTimeout(() => reject(new Error('YouTube player API timed out loading.')), 20000)
  })
  return apiReady
}

const ERRORS = {
  2: 'YouTube rejected that video id.',
  5: 'This video can’t be played in an embedded player.',
  100: 'That video is gone, or set to Private. Unlisted is what this needs — Private will not embed.',
  101: 'The video owner has disabled embedding for this video.',
  150: 'The video owner has disabled embedding for this video.',
}

export class Player {
  /** @param {HTMLElement} mount element the iframe replaces */
  constructor(mount) {
    this.mount = mount
    this.yt = null
    this._playToken = 0
    this._videoId = null
    // What we last asked for. getPlayerState() lags a play/pause call by a beat and passes
    // through BUFFERING, so reading it straight after pauseVideo() can still say PLAYING.
    // onStateChange reconciles this whenever the viewer uses YouTube's own controls.
    this._intent = 'paused'
  }

  get duration() {
    const d = this.yt?.getDuration?.()
    return Number.isFinite(d) && d > 0 ? d : null
  }

  /** The playhead — this is what the "now" button reads. */
  now() {
    return this.yt?.getCurrentTime?.() || 0
  }

  get paused() {
    return this._intent !== 'playing'
  }

  /**
   * Point the player at a video id and resolve with its duration.
   * getDuration() returns 0 until metadata has loaded, so this waits for a real number rather
   * than resolving on onReady alone.
   */
  async load(videoId) {
    this.cancel()
    if (!videoId) throw new Error('This tape has no YouTube id yet — see SETUP.md step 3.')

    const YT = await loadApi()

    if (this.yt && this._videoId) {
      this._videoId = videoId
      this.yt.loadVideoById(videoId)
    } else {
      await new Promise((resolve, reject) => {
        this._videoId = videoId
        this.yt = new YT.Player(this.mount, {
          videoId,
          playerVars: {
            rel: 0, modestbranding: 1, playsinline: 1,
            // Native controls stay on — the scrub bar and quality menu are the whole point.
            controls: 1,
          },
          events: {
            onReady: () => resolve(),
            onError: e => reject(new Error(ERRORS[e.data] || `YouTube player error ${e.data}.`)),
            onStateChange: e => {
              const S = window.YT.PlayerState
              if (e.data === S.PLAYING) this._intent = 'playing'
              else if (e.data === S.PAUSED || e.data === S.ENDED) this._intent = 'paused'
              // BUFFERING and CUED are transitional; leave the last intent standing.
            },
          },
        })
        setTimeout(() => reject(new Error('YouTube player took too long to start.')), 25000)
      })
    }

    const duration = await this._waitForDuration()
    return duration
  }

  _waitForDuration(timeout = 20000) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now()
      const tick = () => {
        const d = this.duration
        if (d) return resolve(d)
        if (Date.now() - t0 > timeout) return reject(new Error('Could not read the video duration.'))
        setTimeout(tick, SEEK_POLL_MS)
      }
      tick()
    })
  }

  /**
   * Seek, then wait until the player actually reports the new position.
   * There is no 'seeked' event on this API, so this polls. allowSeekAhead=true so an
   * unbuffered target still fetches rather than snapping to the nearest buffered keyframe.
   */
  seek(seconds, { timeout = 15000 } = {}) {
    if (!this.yt) return Promise.resolve()
    const duration = this.duration
    const target = Math.max(0, duration ? Math.min(seconds, duration) : seconds)

    return new Promise(resolve => {
      this.yt.seekTo(target, true)
      const t0 = Date.now()
      const tick = () => {
        if (Math.abs(this.now() - target) <= SEEK_TOLERANCE) return resolve()
        // Resolve rather than reject on timeout: the playhead is close enough to be useful and
        // failing the whole interaction over a slow seek is worse than a slightly-off preview.
        if (Date.now() - t0 > timeout) return resolve()
        setTimeout(tick, SEEK_POLL_MS)
      }
      setTimeout(tick, SEEK_POLL_MS)
    })
  }

  play() {
    this._intent = 'playing'
    this.yt?.playVideo?.()
  }

  /**
   * Pause, and resolve once the player actually reports it. playRanges awaits this so that a
   * caller checking `paused` right afterwards sees the truth rather than a stale PLAYING.
   */
  pause({ timeout = 2000 } = {}) {
    this._intent = 'paused'
    this.yt?.pauseVideo?.()
    return new Promise(resolve => {
      const t0 = Date.now()
      const tick = () => {
        const S = window.YT?.PlayerState
        const state = this.yt?.getPlayerState?.()
        if (state === S?.PAUSED || state === S?.ENDED || Date.now() - t0 > timeout) return resolve()
        setTimeout(tick, 50)
      }
      tick()
    })
  }

  /** Abandon any in-flight playRanges. */
  cancel() {
    this._playToken += 1
    return this._playToken
  }

  /**
   * Play an ordered list of ranges back to back, then pause — the "play timestamps" button.
   * Polls with requestAnimationFrame rather than a timer so the stop lands as close to the
   * range end as the API's ~250ms time resolution allows.
   */
  async playRanges(ranges, { onEnter, onProgress, onDone } = {}) {
    const token = this.cancel()
    const list = ranges.filter(r => r && r.e > r.s)
    if (!list.length || !this.yt) return

    for (let i = 0; i < list.length; i++) {
      if (token !== this._playToken) return
      const range = list[i]

      await this.seek(range.s)
      if (token !== this._playToken) return
      onEnter?.(i, range)
      this.play()

      const finished = await new Promise(resolve => {
        const tick = () => {
          if (token !== this._playToken) return resolve(false)
          const at = this.now()
          if (at >= range.e) return resolve(true)
          const state = this.yt.getPlayerState?.()
          if (state === window.YT?.PlayerState?.ENDED) return resolve(true)
          onProgress?.(at, i)
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })

      if (!finished || token !== this._playToken) return
    }

    if (token !== this._playToken) return
    await this.pause()
    onDone?.()
  }
}
