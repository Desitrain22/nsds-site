import { SHOWS, BACKEND_URL, showsByYear, getShow, isExcluded, performerName, showLinks, showNotes, sameName } from './shows.js'
import { Api, toImageUrl, invalidate } from './api.js'
import { Player } from './player.js'
import { Nav } from './nav.js'
import {
  newClip, addRange, removeRange, playableRanges, validate, previewRow,
  parseTime, formatTime, formatTimePrecise, legacyRanges, parseGranular, totalDuration,
} from './clips.js'

const $ = sel => document.querySelector(sel)
const CFG_KEY = 'nsds-review-config'

const state = {
  api: null,
  password: '',
  cfg: loadConfig(),
  show: null,
  tapes: [],
  tape: null,
  duration: null,
  clips: [],
  legacy: [],
  player: null,
}

/**
 * Every async hop that can paint a screen goes through this. See nav.js — the short version is
 * that picking a show abandons the tape inside it, and any response that arrives after you've
 * navigated away is dropped instead of being written over the screen you're actually looking at.
 */
const nav = new Nav(['show', 'tape'])

function loadConfig() {
  try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}') } catch { return {} }
}
function saveConfig(cfg) {
  state.cfg = cfg
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg))
}

// ------------------------------------------------------------------ gate + settings --

$('#gate-form').addEventListener('submit', async e => {
  e.preventDefault()
  const err = $('#gate-error')
  err.hidden = true

  state.password = $('#gate-input').value
  // An explicit Settings value is an OVERRIDE (that's how the dev server points the page at its
  // own /api); otherwise the URL committed in shows.js, so performers configure nothing.
  const endpoint = state.cfg.endpoint || BACKEND_URL
  state.api = new Api({ endpoint, password: state.password })

  if (!endpoint) {
    err.textContent = 'No backend URL set yet — open Backend settings first.'
    err.hidden = false
    return
  }

  // Cached reads are keyed by folder, not by credential, so a new passphrase has to start clean.
  invalidate()

  const button = $('#gate-form button[type="submit"]')
  button.disabled = true
  try {
    await state.api.ping()
  } catch (e2) {
    err.textContent = e2.message
    err.hidden = false
    return
  } finally {
    button.disabled = false
  }

  $('#gate').hidden = true
  $('#app').hidden = false
  renderPicker()
  restoreFromUrl()
})

for (const sel of ['#gate-settings', '#open-settings']) {
  $(sel).addEventListener('click', () => {
    $('#cfg-endpoint').value = state.cfg.endpoint || ''
    $('#settings').showModal()
  })
}
$('#cfg-cancel').addEventListener('click', () => $('#settings').close('cancel'))
$('#settings').addEventListener('close', () => {
  if ($('#settings').returnValue !== 'save') return
  saveConfig({ endpoint: $('#cfg-endpoint').value.trim() })
  if (state.api) state.api.endpoint = state.cfg.endpoint
})

// ------------------------------------------------------------------ picker --

let pickedYear = null

function renderPicker() {
  const years = showsByYear()
  const yearBox = $('#years')
  yearBox.textContent = ''
  for (const year of [...years.keys()].sort((a, b) => b - a)) {
    const b = document.createElement('button')
    b.className = 'chip' + (year === pickedYear ? ' on' : '')
    b.textContent = year
    b.addEventListener('click', () => { pickedYear = year; renderPicker() })
    yearBox.append(b)
  }
  if (pickedYear === null) {
    pickedYear = [...years.keys()].sort((a, b) => b - a)[0]
    return renderPicker()
  }

  const showBox = $('#shows')
  showBox.textContent = ''
  for (const show of years.get(pickedYear) || []) {
    const b = document.createElement('button')
    b.className = 'chip' + (state.show?.id === show.id ? ' on' : '')
    b.textContent = show.city ? `${show.label} · ${show.city}` : show.label
    b.addEventListener('click', () => selectShow(show))
    showBox.append(b)
  }
  renderCrumbs()
}

/**
 * Show a message in the tape column, replacing whatever is there.
 * `aria-busy` instead keeps the old grid on screen but inert, so the fetch can't be double-started.
 */
function setTapesMessage(text, tone) {
  const box = $('#tapes')
  box.removeAttribute('aria-busy')
  box.className = `tapes ${tone}`
  box.textContent = text
}

async function selectShow(show) {
  // Bumps the tape level too: picking a show abandons whatever tape was open inside the old one,
  // so a getClips still in flight for it can no longer land on this screen.
  const token = nav.enter('show')

  state.show = show
  state.tapes = []
  // View-only Drive links for the show. Photos are per show, not per tape, so they live in the bar.
  const links = showLinks(show)
  for (const [id, href] of [['#photos-link', links.photos], ['#clips-link', links.clips], ['#legacy-sheet-link', links.legacySheet]]) {
    const a = $(id)
    a.hidden = !href
    if (href) a.href = href
  }
  closeReview()
  renderPicker()

  const box = $('#tapes')
  if (box.querySelector('.tape')) {
    box.setAttribute('aria-busy', 'true')
  } else {
    setTapesMessage('Loading tapes…', 'muted')
  }

  const res = await nav.settle(token, state.api.listTapes(show))
  if (res.state === 'stale') return
  if (res.state === 'error') {
    setTapesMessage(res.error.message, 'error')
    return
  }

  const { tapes, tapesRoot } = res.value
  state.tapes = (tapes || []).filter(t => !isExcluded(show, t.name))
  const notes = showNotes(show, tapesRoot)
  const note = $('#tapes-note')
  note.hidden = !notes.length
  note.textContent = notes.join(' ')
  renderTapes()
  return state.tapes
}

function renderTapes() {
  const box = $('#tapes')
  box.removeAttribute('aria-busy')
  box.className = 'tapes'
  box.textContent = ''

  if (!state.tapes.length) {
    setTapesMessage('No set tapes in this folder yet.', 'muted')
    return
  }

  for (const tape of state.tapes) {
    const b = document.createElement('button')
    b.className = 'tape'
    b.dataset.fileId = tape.fileId
    const who = document.createElement('strong')
    who.textContent = performerName(state.show, tape.name)
    const meta = document.createElement('span')
    meta.className = 'muted small'
    meta.textContent = `${tape.name} · ${(tape.size / 1e9).toFixed(2)} GB`
    b.append(who, meta)
    if (!tape.youtubeId) {
      const warn = document.createElement('span')
      warn.className = 'warn small'
      warn.textContent = 'not on YouTube yet — nothing to play'
      b.append(warn)
    }
    b.addEventListener('click', () => openTape(tape))
    box.append(b)
  }
  renderTapeSelection()
}

/** Which tape is open, marked without rebuilding the grid. */
function renderTapeSelection() {
  for (const b of $('#tapes').querySelectorAll('.tape')) {
    b.classList.toggle('on', b.dataset.fileId === state.tape?.fileId)
  }
}

// ------------------------------------------------------------------ review --

/**
 * Put the review pane back to empty. Called before every tape opens and whenever one closes, so
 * nothing from the last tape can be read as belonging to this one.
 *
 * Every line here is a thing that used to survive a tape change: the Stop button left over from an
 * interrupted playback, a sheet link pointing at the previous show's spreadsheet, a clock frozen
 * mid-set, the timeline drawn from the last performer's ranges — and the video itself, which
 * `#review.hidden = true` never touched.
 */
function resetReview() {
  state.player?.unload()
  setFrame('idle')
  $('#tape-name').textContent = state.tape?.name || ''
  $('#clock').textContent = formatTimePrecise(0)
  $('#stop-ranges').hidden = true
  $('#timeline').textContent = ''

  const link = $('#sheet-link')
  link.hidden = true
  link.removeAttribute('href')

  const err = $('#player-error')
  err.hidden = true
  err.textContent = ''
  err.className = 'error'
}

/** Leave the review pane entirely — back to just the picker. */
function closeReview() {
  nav.enter('tape')
  state.tape = null
  state.clips = []
  state.legacy = []
  state.duration = null
  $('#review').hidden = true
  resetReview()
  renderClips()
  renderTapeSelection()
}

/** idle | loading | ready | empty. Anything but `ready` covers the iframe — see review.css. */
function setFrame(mode, note = '') {
  $('.frame').dataset.state = mode
  $('#frame-note').textContent = note
}

function showPlayerMessage(tone, text) {
  const err = $('#player-error')
  err.className = tone === 'warn' ? 'warn small' : 'error'
  err.textContent = text
  err.hidden = false
}

async function openTape(tape) {
  const token = nav.enter('tape')

  // Synchronous teardown, before anything async can start. A slow or failed load used to leave the
  // previous performer's clips in state with their ranges drawn over this tape — and editing one of
  // those cards then rewrote the OTHER tape's sheet row with these timestamps.
  state.tape = tape
  state.clips = []
  state.legacy = []
  state.duration = null
  resetReview()
  renderClips()
  renderTapeSelection()
  renderCrumbs()
  writeUrl()

  $('#review').hidden = false
  if (!state.player) initPlayer()

  // In parallel, not in series. The sheet has no opinion about the video and vice versa, but clips
  // used to wait on YouTube reporting a duration first — which on a cold player is most of the
  // wait, and on a dead video id was the full 20-second timeout.
  await Promise.all([loadVideo(token, tape), loadClips(token)])
}

async function loadVideo(token, tape) {
  if (!tape.youtubeId) {
    setFrame('empty', 'Not on YouTube yet')
    showPlayerMessage('warn',
      `This tape isn't on YouTube yet, so there's nothing to play. ` +
      `The nightly sync (tools/youtube-sync.mjs) uploads a few tapes a day — check back tomorrow.`)
    return
  }

  setFrame('loading', 'Loading tape…')
  const res = await nav.settle(token, state.player.load(tape.youtubeId))
  if (res.state === 'stale') return

  if (res.state === 'error') {
    // Unload rather than leave the failed load's predecessor on screen under this tape's name.
    state.player.unload()
    setFrame('empty', 'Could not load this tape')
    showPlayerMessage('error', res.error.message)
    return
  }
  // load() resolves null when a newer load superseded it; the nav check above normally catches
  // that first, but never trust a duration that isn't a number.
  if (!res.value) return

  state.duration = res.value
  setFrame('ready')
  renderTimeline()
}

function initPlayer() {
  state.player = new Player($('#player-mount'))
  // No timeupdate event on the IFrame API, so poll. 10 Hz is smooth enough to read and cheap.
  // Skipping the write when the text hasn't changed keeps this off the layout path while paused.
  let shown = ''
  setInterval(() => {
    if (!state.player?.hasVideo || $('#review').hidden) return
    const next = formatTimePrecise(state.player.now())
    if (next === shown) return
    shown = next
    $('#clock').textContent = next
  }, 100)
  $('#stop-ranges').addEventListener('click', () => {
    state.player.cancel()
    state.player.pause()
    $('#stop-ranges').hidden = true
  })
}

async function loadClips(token) {
  const list = $('#clip-list')
  if (list.querySelector('.clip')) {
    list.setAttribute('aria-busy', 'true')
  } else {
    list.className = 'clip-list muted'
    list.textContent = 'Loading clips…'
  }

  const res = await nav.settle(token, state.api.getClips(state.show, state.tape.fileId))
  list.removeAttribute('aria-busy')
  if (res.state === 'stale') return
  if (res.state === 'error') {
    list.className = 'clip-list error'
    list.textContent = res.error.message
    return
  }

  const { value } = res
  state.clips = (value.clips || []).map(c => ({
    ...c, dirty: false, saving: false, error: null, readOnly: false,
    ranges: c.ranges?.length ? c.ranges : [{ s: null, e: null }],
    links: c.links || [],
  }))
  state.legacy = value.legacy || []

  const link = $('#sheet-link')
  link.hidden = !value.sheetUrl
  if (value.sheetUrl) link.href = value.sheetUrl

  // An old-format sheet: the backend refuses to read or write it as A–G. Say so, plainly.
  $('#new-clip').disabled = !!value.layoutError
  if (value.layoutError) {
    list.className = 'clip-list muted'
    list.textContent = "This show's request sheet uses an older layout, so clips can't be read or saved here — open the sheet to see the requests."
    return
  }

  list.className = 'clip-list'
  renderClips()
}

$('#new-clip').addEventListener('click', () => {
  if (!state.tape) return
  const clip = newClip({
    name: performerName(state.show, state.tape.name),
    videoFileId: state.tape.fileId,
  })
  // Seed the first range with the current playhead — you almost always hit "new clip"
  // at the moment you want it to start.
  clip.ranges[0].s = Math.max(0, state.player?.now() ?? 0)
  state.clips.push(clip)
  renderClips()
  const last = $('#clip-list').lastElementChild
  last?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  last?.querySelector('.notes')?.focus()
})

function renderClips() {
  const list = $('#clip-list')
  list.textContent = ''
  state.clips.forEach((clip, i) => list.append(renderClip(clip, i)))
  renderLegacy()
  renderTimeline()
}

function renderClip(clip, index) {
  const node = $('#tpl-clip').content.firstElementChild.cloneNode(true)
  const ranges = playableRanges(clip)

  node.querySelector('.clip-title').textContent = `Clip ${index + 1}`
  node.querySelector('.clip-summary').textContent = ranges.length
    ? `${ranges.length > 1 ? `${ranges.length} parts · ` : ''}${formatTime(totalDuration(ranges))}`
    : 'no ranges yet'
  if (clip.duplicate) node.classList.add('bad')

  // Ranges
  const refresh = () => updateCard(node, clip, index)
  const rangeBox = node.querySelector('.ranges')
  for (const range of clip.ranges) rangeBox.append(renderRange(node, clip, range, refresh))
  syncRangeChrome(node)

  node.querySelector('.add-range').addEventListener('click', () => {
    addRange(clip)
    const added = clip.ranges[clip.ranges.length - 1]
    rangeBox.append(renderRange(node, clip, added, refresh))
    syncRangeChrome(node)
    refresh()
  })

  // Fields
  const notes = node.querySelector('.notes')
  notes.value = clip.notes || ''
  notes.addEventListener('input', () => { clip.notes = notes.value; clip.dirty = true; markDirty(node) })

  const thumb = node.querySelector('.thumb')
  thumb.value = clip.thumb || ''
  thumb.addEventListener('input', () => { clip.thumb = thumb.value; clip.dirty = true; markDirty(node) })

  const links = node.querySelector('.links')
  links.value = (clip.links || []).join('\n')
  let previewTimer
  const syncLinks = () => {
    clip.links = links.value.split('\n').map(s => s.trim()).filter(Boolean)
    clip.dirty = true
    markDirty(node)
    // Debounced: without this, typing a URL fires one image request per keystroke against a
    // truncated address and flashes the fallback each time. `input` already covers paste, so
    // there's no separate paste listener.
    clearTimeout(previewTimer)
    previewTimer = setTimeout(() => renderPreviews(node, clip), 350)
  }
  links.addEventListener('input', syncLinks)
  renderPreviews(node, clip)

  // Actions
  node.querySelector('.play-ranges').addEventListener('click', () => playRanges(playableRanges(clip)))
  node.querySelector('.del').addEventListener('click', () => deleteClip(clip))
  node.querySelector('.save').addEventListener('click', () => saveClip(clip, node))

  const msg = node.querySelector('.clip-msg')
  if (clip.duplicate) {
    msg.textContent = 'This clip id is on more than one row — fix the sheet by hand.'
    msg.className = 'clip-msg small error'
  } else if (clip.dirty) {
    msg.textContent = 'Unsaved'
    msg.className = 'clip-msg small muted'
  }
  return node
}

/**
 * One range row.
 *
 * Its position is read from the DOM at click time rather than captured here, because a row's index
 * changes the moment any earlier row is dropped — a captured `ri` deletes the wrong range on the
 * second removal.
 */
function renderRange(card, clip, range, refresh) {
  const node = $('#tpl-range').content.firstElementChild.cloneNode(true)

  const startInput = node.querySelector('.start')
  const endInput = node.querySelector('.end')
  startInput.value = range.s === null ? '' : formatTime(range.s)
  endInput.value = range.e === null ? '' : formatTime(range.e)

  const commit = (input, key) => {
    const typed = input.value.trim()
    const parsed = parseTime(typed)
    range[key] = parsed
    clip.dirty = true
    if (parsed === null) {
      // Keep what was typed and flag it, rather than silently blanking the field — the user
      // otherwise can't tell whether the app rejected the entry or ate it.
      input.classList.toggle('bad', typed !== '')
      input.title = typed ? `Couldn't read "${typed}" as a time` : ''
    } else {
      input.value = formatTime(parsed)
      input.classList.remove('bad')
      input.title = ''
    }
    refresh()
  }
  startInput.addEventListener('change', () => commit(startInput, 's'))
  endInput.addEventListener('change', () => commit(endInput, 'e'))

  node.querySelector('.now-start').addEventListener('click', () => {
    range.s = state.player?.now() ?? 0
    startInput.value = formatTime(range.s)
    startInput.classList.remove('bad')
    clip.dirty = true
    refresh()
  })
  node.querySelector('.now-end').addEventListener('click', () => {
    range.e = state.player?.now() ?? 0
    endInput.value = formatTime(range.e)
    endInput.classList.remove('bad')
    clip.dirty = true
    refresh()
  })
  node.querySelector('.play-range').addEventListener('click', () => {
    if (range.s !== null && range.e !== null && range.e > range.s) playRanges([{ s: range.s, e: range.e }])
  })

  node.querySelector('.drop-range').addEventListener('click', () => {
    const at = [...node.parentElement.children].indexOf(node)
    if (at < 0 || clip.ranges.length <= 1) return
    removeRange(clip, at)
    node.remove()
    syncRangeChrome(card)
    refresh()
  })

  return node
}

/**
 * Renumber the rows and hide ✕ when only one is left.
 *
 * Adding or removing a range used to re-render the whole clip list, which threw away every input in
 * it — so the caret jumped out of whatever field you were in, and a half-typed timestamp on another
 * card vanished. Only the chrome actually depends on the count, so only the chrome is updated.
 */
function syncRangeChrome(card) {
  const rows = [...card.querySelectorAll('.range')]
  rows.forEach((row, i) => {
    row.querySelector('.range-label').textContent = rows.length > 1 ? `${i + 1}.` : ''
    row.querySelector('.drop-range').hidden = rows.length <= 1
  })
}

/**
 * Update one card in place.
 *
 * Emphatically NOT a re-render of the list. The timestamp inputs fire on `change`, which the
 * browser dispatches on blur — i.e. between mousedown and mouseup of whatever you clicked
 * next. Re-cloning the list there destroys the element mid-click, so the click never lands:
 * editing an end time and then clicking Save did nothing the first time, and clicking into
 * Notes lost the caret.
 */
function updateCard(node, clip, index) {
  const ranges = playableRanges(clip)
  node.querySelector('.clip-title').textContent = `Clip ${index + 1}`
  node.querySelector('.clip-summary').textContent = ranges.length
    ? `${ranges.length > 1 ? `${ranges.length} parts · ` : ''}${formatTime(totalDuration(ranges))}`
    : 'no ranges yet'
  if (clip.dirty) markDirty(node)
  renderTimeline()
}

function markDirty(node) {
  const msg = node.querySelector('.clip-msg')
  msg.textContent = 'Unsaved'
  msg.className = 'clip-msg small muted'
}

function renderPreviews(node, clip) {
  const box = node.querySelector('.previews')
  box.textContent = ''
  for (const raw of clip.links || []) {
    const src = toImageUrl(raw)
    const wrap = document.createElement('a')
    wrap.href = raw
    wrap.target = '_blank'
    wrap.rel = 'noopener'
    wrap.className = 'preview'
    if (src) {
      const img = document.createElement('img')
      img.src = src
      img.alt = raw
      img.loading = 'lazy'
      // Hotlink-blocked hosts, non-images and dead links all land here.
      img.addEventListener('error', () => {
        wrap.textContent = new URL(raw, location.href).hostname + ' ↗'
        wrap.classList.add('preview-fallback')
      })
      wrap.append(img)
    } else {
      wrap.textContent = raw
      wrap.classList.add('preview-fallback')
    }
    box.append(wrap)
  }
}

async function playRanges(ranges) {
  if (!ranges.length || !state.player) return
  $('#stop-ranges').hidden = false
  // Starting a second clip cancels the first, whose continuation would otherwise hide Stop
  // while the new one is still playing. Only the latest run may hide it.
  const mine = ++playSeq
  await state.player.playRanges(ranges)
  if (mine === playSeq) $('#stop-ranges').hidden = true
}
let playSeq = 0

async function saveClip(clip, node) {
  const msg = node.querySelector('.clip-msg')
  const problem = validate(clip, state.duration)
  if (problem) {
    msg.textContent = problem
    msg.className = 'clip-msg small error'
    return
  }

  const button = node.querySelector('.save')
  button.disabled = true
  msg.textContent = 'Saving…'
  msg.className = 'clip-msg small muted'

  // The write itself is never abandoned — it is already in flight against the right sheet and must
  // be allowed to land. Only the UI it reports into is conditional: a save that resolves after you
  // moved on would otherwise point the header's sheet link at the show you just left.
  const token = nav.token('tape')
  const res = await nav.settle(token, state.api.saveClip(state.show, clip, state.duration))
  if (res.state === 'stale') return

  button.disabled = false
  if (res.state === 'error') {
    msg.textContent = res.error.data?.conflict
      ? 'That row changed in the sheet since you loaded it. Reload to pick up their edit.'
      : res.error.message
    msg.className = 'clip-msg small error'
    return
  }

  clip.rev = res.value.rev
  clip.dirty = false
  msg.textContent = `Saved to row ${res.value.row}`
  msg.className = 'clip-msg small ok'
  const link = $('#sheet-link')
  if (res.value.sheetUrl) { link.href = res.value.sheetUrl; link.hidden = false }
  renderTimeline()
}

async function deleteClip(clip) {
  if (!confirm('Delete this clip?')) return
  // Always ask the server, even for a clip that looks unsaved. `clip.rev` is only set once a
  // save resolves, so hitting Save then ✕ would otherwise drop the card locally while the
  // in-flight append lands — leaving an orphan row the app can't see and the editors will cut.
  // deleteClip is idempotent server-side (returns alreadyGone when there is nothing to remove).
  const token = nav.token('tape')
  const res = await nav.settle(token, state.api.deleteClip(state.show, clip.clipId))
  // The row is gone from the sheet either way; if the user has since moved on there is simply no
  // list left to take it out of.
  if (res.state === 'stale') return
  if (res.state === 'error') {
    alert(`Could not delete: ${res.error.message}`)
    return
  }
  state.clips = state.clips.filter(c => c !== clip)
  renderClips()
}

/** Legacy rows belonging to the tape that's open. */
function myLegacy() {
  if (!state.tape || !state.show) return []
  const who = performerName(state.show, state.tape.name)
  return state.legacy.filter(row => sameName(row.name, who))
}

// Rows already in the sheet that the app didn't write. Shown so you can see and replay
// them, but never rewritten — their timestamps are free text we can only guess at.
function renderLegacy() {
  const box = $('#legacy-list')
  box.textContent = ''
  if (!state.legacy.length) return

  // Legacy rows carry no video_file_id, so the server can't scope them to a tape. Match on the
  // performer name instead: without this, every performer's rows show up under every tape with
  // a play button that runs their timecodes against the wrong video.
  const mine = myLegacy()
  const others = state.legacy.length - mine.length

  if (mine.length) {
    const h = document.createElement('h3')
    h.textContent = 'Already in the sheet'
    const note = document.createElement('p')
    note.className = 'muted small'
    note.textContent = 'Typed straight into the sheet. Read-only here — edit those in the sheet.'
    box.append(h, note)
  }

  if (others) {
    const p = document.createElement('p')
    p.className = 'muted small'
    p.textContent = `${others} more row${others === 1 ? '' : 's'} in this sheet belong to other ` +
      `performers — open the sheet to see them.`
    box.append(p)
  }

  for (const row of mine) {
    const ranges = legacyRanges(row)
    const g = parseGranular(row.granular)
    const item = document.createElement('div')
    item.className = 'legacy'

    const head = document.createElement('div')
    head.className = 'legacy-head'
    const who = document.createElement('strong')
    who.textContent = row.name || '(no name)'
    const span = document.createElement('span')
    span.className = 'muted small'
    span.textContent = `${row.start || '?'} → ${row.end || '?'}`
    head.append(who, span)

    if (ranges.length) {
      const play = document.createElement('button')
      play.className = 'linkish'
      play.textContent = '▶ Play'
      play.addEventListener('click', () => playRanges(ranges))
      head.append(play)
    }
    item.append(head)

    if (row.notes) {
      const p = document.createElement('p')
      p.className = 'small'
      p.textContent = row.notes
      item.append(p)
    }
    if (g.kind === 'subtractive' || g.kind === 'advice') {
      const p = document.createElement('p')
      p.className = 'muted small'
      p.textContent =
        g.kind === 'subtractive'
          ? `Removals applied from: “${g.raw}”`
          : `Note in the granular column: “${g.raw}”`
      item.append(p)
    }
    box.append(item)
  }
}

// Clip ranges drawn over the tape's length, so you can see coverage at a glance.
function renderTimeline() {
  const box = $('#timeline')
  box.textContent = ''
  if (!state.duration) return
  const all = [
    ...state.clips.flatMap(c => playableRanges(c).map(r => ({ ...r, kind: 'app' }))),
    ...myLegacy().flatMap(r => legacyRanges(r).map(x => ({ ...x, kind: 'legacy' }))),
  ]
  for (const r of all) {
    const bar = document.createElement('span')
    bar.className = `tl ${r.kind}`
    bar.style.left = `${(r.s / state.duration) * 100}%`
    bar.style.width = `${Math.max(0.4, ((r.e - r.s) / state.duration) * 100)}%`
    bar.title = `${formatTime(r.s)} – ${formatTime(r.e)}`
    bar.addEventListener('click', () => playRanges([{ s: r.s, e: r.e }]))
    box.append(bar)
  }
}

// ------------------------------------------------------------------ chrome --

function renderCrumbs() {
  const box = $('#crumbs')
  box.textContent = ''
  const bits = ['Tape Review']
  if (state.show) bits.push(state.show.city ? `${state.show.label} · ${state.show.city}` : state.show.label)
  if (state.tape) bits.push(performerName(state.show, state.tape.name))
  bits.forEach((text, i) => {
    if (i) {
      const sep = document.createElement('span')
      sep.className = 'sep'
      sep.textContent = '/'
      box.append(sep)
    }
    const s = document.createElement('span')
    s.textContent = text
    box.append(s)
  })
}

function writeUrl() {
  const params = new URLSearchParams()
  if (state.show) params.set('show', state.show.id)
  if (state.tape) params.set('tape', state.tape.fileId)
  history.replaceState(null, '', `?${params}`)
}

async function restoreFromUrl() {
  const params = new URLSearchParams(location.search)
  const show = getShow(params.get('show'))
  if (!show) return
  pickedYear = show.year

  // selectShow returns the list it just fetched. This used to call listTapes a SECOND time for the
  // same folder — so every deep link and every reload paid for two full Drive listings.
  const tapes = await selectShow(show)
  if (!tapes) return

  const tapeId = params.get('tape')
  if (!tapeId) return
  // Only open it if the user hasn't already picked something else while the list was loading.
  if (state.show?.id !== show.id || state.tape) return
  const tape = tapes.find(t => t.fileId === tapeId)
  if (tape) await openTape(tape)
}

// Keyboard review shortcuts, only when not typing in a field.
document.addEventListener('keydown', e => {
  if (!state.player || $('#review').hidden) return
  // Buttons keep focus after a click in Chrome, so without excluding them Space would toggle
  // the video instead of re-activating the button the user just used.
  if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(e.target.tagName)) return
  if (e.target.closest?.('dialog')) return

  const p = state.player
  const step = e.shiftKey ? 5 : 1 / 29.97
  if (e.key === ' ') {
    e.preventDefault()
    p.paused ? p.play() : p.pause()
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    p.seek(Math.max(0, p.now() - step))
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    p.seek(p.now() + step)
  } else if (e.key === 'j' || e.key === 'l' || e.key === 'k') {
    const rates = [0.25, 0.5, 1, 1.5, 2]
    const current = state.player.yt?.getPlaybackRate?.() ?? 1
    let next = 1
    if (e.key === 'j') next = rates[Math.max(0, rates.indexOf(current) - 1)] ?? 0.5
    if (e.key === 'l') next = rates[Math.min(rates.length - 1, rates.indexOf(current) + 1)] ?? 2
    state.player.yt?.setPlaybackRate?.(next)
    if (e.key === 'k') p.paused ? p.play() : p.pause()
  }
})
