import { SHOWS, showsByYear, getShow, isExcluded, performerName, youtubeIdFor } from './shows.js'
import { Api, toImageUrl } from './api.js'
import { Player } from './player.js'
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
  tape: null,
  duration: null,
  clips: [],
  legacy: [],
  player: null,
}

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
  state.api = new Api({ endpoint: state.cfg.endpoint, password: state.password })

  if (!state.cfg.endpoint) {
    err.textContent = 'No backend URL set yet — open Backend settings first.'
    err.hidden = false
    return
  }

  try {
    // listTapes on the first show doubles as the password check.
    await state.api.listTapes(SHOWS[0])
  } catch (e2) {
    err.textContent = e2.message
    err.hidden = false
    return
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

async function selectShow(show) {
  state.show = show
  state.tape = null
  // Hiding the section doesn't stop the audio, and the Stop button goes away with it.
  if (state.player) { state.player.cancel(); state.player.pause() }
  $('#review').hidden = true
  renderPicker()

  const box = $('#tapes')
  box.textContent = 'Loading tapes…'
  box.className = 'tapes muted'

  try {
    const { tapes } = await state.api.listTapes(show)
    const usable = tapes.filter(t => !isExcluded(show, t.name))
    box.className = 'tapes'
    box.textContent = ''

    if (!usable.length) {
      box.className = 'tapes muted'
      box.textContent = 'No set tapes in this folder yet.'
      return
    }

    for (const tape of usable) {
      const b = document.createElement('button')
      b.className = 'tape'
      const who = document.createElement('strong')
      who.textContent = performerName(show, tape.name)
      const meta = document.createElement('span')
      meta.className = 'muted small'
      meta.textContent = `${tape.name} · ${(tape.size / 1e9).toFixed(2)} GB`
      b.append(who, meta)
      if (!tape.isPublic) {
        const warn = document.createElement('span')
        warn.className = 'warn small'
        warn.textContent = 'not shared publicly — the player can’t load this'
        b.append(warn)
      }
      b.addEventListener('click', () => openTape(tape))
      box.append(b)
    }
  } catch (err) {
    box.className = 'tapes error'
    box.textContent = err.message
  }
}

// ------------------------------------------------------------------ review --

async function openTape(tape) {
  // Clear per-tape state FIRST. Otherwise a slow or failed getClips leaves the previous
  // performer's clips in state, their ranges drawn over this tape, and — worst case — editing
  // one of those cards and saving rewrites the OTHER tape's sheet row with these timestamps.
  state.clips = []
  state.legacy = []
  state.duration = null
  if (state.player) { state.player.cancel(); state.player.pause() }
  renderClips()

  state.tape = tape
  $('#review').hidden = false
  $('#tape-name').textContent = tape.name
  $('#player-error').hidden = true
  renderCrumbs()
  writeUrl()

  if (!state.player) initPlayer()

  const videoId = youtubeIdFor(state.show.id, tape.name)
  const err = $('#player-error')
  err.hidden = true
  err.className = 'error'

  if (!videoId) {
    err.className = 'warn small'
    err.textContent =
      `This tape hasn't been uploaded to YouTube yet, so there's nothing to play. ` +
      `Run: node tools/publish-tapes.mjs ${state.show.id}  then paste the id into shows.js.`
    err.hidden = false
    state.duration = null
    await loadClips()
    return
  }

  try {
    state.duration = await state.player.load(videoId)
  } catch (e) {
    state.duration = null
    err.textContent = e.message
    err.hidden = false
  }

  await loadClips()
}

function initPlayer() {
  state.player = new Player($('#player-mount'))
  // No timeupdate event on the IFrame API, so poll. 10 Hz is smooth enough to read and cheap.
  setInterval(() => {
    if (!state.player || $('#review').hidden) return
    $('#clock').textContent = formatTimePrecise(state.player.now())
  }, 100)
  $('#stop-ranges').addEventListener('click', () => {
    state.player.cancel()
    state.player.pause()
    $('#stop-ranges').hidden = true
  })
}

async function loadClips() {
  const list = $('#clip-list')
  list.textContent = 'Loading clips…'
  list.className = 'clip-list muted'
  try {
    const res = await state.api.getClips(state.show, state.tape.fileId)
    state.clips = (res.clips || []).map(c => ({
      ...c, dirty: false, saving: false, error: null, readOnly: false,
      ranges: c.ranges?.length ? c.ranges : [{ s: null, e: null }],
      links: c.links || [],
    }))
    state.legacy = res.legacy || []
    const link = $('#sheet-link')
    link.hidden = !res.sheetUrl
    if (res.sheetUrl) link.href = res.sheetUrl
  } catch (err) {
    list.className = 'clip-list error'
    list.textContent = err.message
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
  clip.ranges.forEach((range, ri) => rangeBox.append(renderRange(clip, range, ri, refresh)))

  node.querySelector('.add-range').addEventListener('click', () => {
    addRange(clip); renderClips()
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

function renderRange(clip, range, ri, refresh) {
  const node = $('#tpl-range').content.firstElementChild.cloneNode(true)
  const label = node.querySelector('.range-label')
  label.textContent = clip.ranges.length > 1 ? `${ri + 1}.` : ''

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

  const drop = node.querySelector('.drop-range')
  drop.hidden = clip.ranges.length <= 1
  drop.addEventListener('click', () => { removeRange(clip, ri); renderClips() })

  return node
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

  try {
    const res = await state.api.saveClip(state.show, clip, state.duration)
    clip.rev = res.rev
    clip.dirty = false
    msg.textContent = `Saved to row ${res.row}`
    msg.className = 'clip-msg small ok'
    const link = $('#sheet-link')
    if (res.sheetUrl) { link.href = res.sheetUrl; link.hidden = false }
    renderTimeline()
  } catch (err) {
    if (err.data?.conflict) {
      msg.textContent = 'That row changed in the sheet since you loaded it. Reload to pick up their edit.'
    } else {
      msg.textContent = err.message
    }
    msg.className = 'clip-msg small error'
  } finally {
    button.disabled = false
  }
}

async function deleteClip(clip) {
  if (!confirm('Delete this clip?')) return
  // Always ask the server, even for a clip that looks unsaved. `clip.rev` is only set once a
  // save resolves, so hitting Save then ✕ would otherwise drop the card locally while the
  // in-flight append lands — leaving an orphan row the app can't see and the editors will cut.
  // deleteClip is idempotent server-side (returns alreadyGone when there is nothing to remove).
  try {
    await state.api.deleteClip(state.show, clip.clipId)
  } catch (err) {
    alert(`Could not delete: ${err.message}`)
    return
  }
  state.clips = state.clips.filter(c => c !== clip)
  renderClips()
}

/** "Peter" vs "Pete" vs "peter " — the same person across two shows' filename conventions. */
function sameName(a, b) {
  const norm = x => String(x || '').toLowerCase().replace(/[^a-z]/g, '')
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return false
  return x === y || x.startsWith(y) || y.startsWith(x)
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
  await selectShow(show)

  const tapeId = params.get('tape')
  if (!tapeId) return
  const { tapes } = await state.api.listTapes(show)
  const tape = tapes.find(t => t.fileId === tapeId && !isExcluded(show, t.name))
  if (tape) openTape(tape)
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
