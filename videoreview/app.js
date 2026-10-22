import { BACKEND_URL, showsByYear, getShow, showLabel, isExcluded, performerName, showLinks, showNotes, sameName, clipBelongsTo, clipTopic } from './shows.js'
import { Api, toImageUrl, invalidate } from './api.js'
import { Player } from './player.js'
import { Nav } from './nav.js'
import { openReelEditor } from './reel-editor.js'
import { openCarouselEditor } from './carousel-editor.js'
import { linkLabels } from './carousel.js'
import { buildLibrary, searchComedians, normLabel, formatLength, requestsForTape } from './library.js'
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
  shows: [],      // discovered from Drive by the backend on sign-in
  show: null,
  tapes: [],
  tape: null,
  duration: null,
  clips: [],
  legacy: [],
  finished: [],   // the show's finished clips (completed_clips/), from listTapes
  player: null,
  mode: 'show',   // 'show' | 'comedian' — which picker is up; the review pane under it is shared
  library: null,  // { comedians, unmatched } from library.js, once data/upload-status.json loads
  comedian: null, // the comedian whose library is open, or UNMATCHED
}

/**
 * Every async hop that can paint a screen goes through this. See nav.js — the short version is
 * that picking a show abandons the tape inside it, and any response that arrives after you've
 * navigated away is dropped instead of being written over the screen you're actually looking at.
 */
const nav = new Nav(['show', 'tape'])

// The backend URL is baked into shows.js. A localStorage override under CFG_KEY still wins (that
// is how the dev server points the page at its own /api), but there is no UI for it any more —
// performers should never see a settings screen.
function loadConfig() {
  try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}') } catch { return {} }
}

// ------------------------------------------------------------------ gate --

$('#gate-form').addEventListener('submit', async e => {
  e.preventDefault()
  const err = $('#gate-error')
  err.hidden = true

  state.password = $('#gate-input').value
  const endpoint = state.cfg.endpoint || BACKEND_URL
  state.api = new Api({ endpoint, password: state.password })

  if (!endpoint) {
    err.textContent = 'This page isn’t set up yet — let Neal know.'
    err.hidden = false
    return
  }

  // Cached reads are keyed by folder, not by credential, so a new passphrase has to start clean.
  invalidate()
  requestCache.clear()

  const button = $('#gate-form button[type="submit"]')
  button.disabled = true
  try {
    // Discovering the shows doubles as the password check.
    const { shows } = await state.api.listShows()
    state.shows = shows || []
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

// ------------------------------------------------------------------ picker --

let pickedYear = null

function renderPicker() {
  const years = showsByYear(state.shows)
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
    b.className = 'chip' + (state.show?.folderId === show.folderId ? ' on' : '')
    b.textContent = showLabel(show)
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
  // renderCrumbs decides whether they show.
  const links = showLinks(show)
  for (const [id, href] of [['#photos-link', links.photos], ['#clips-link', links.clips], ['#legacy-sheet-link', links.legacySheet]]) {
    const a = $(id)
    if (href) a.href = href
    else a.removeAttribute('href')
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

  const { tapes, tapesRoot, finishedClips } = res.value
  state.finished = finishedClips || []
  state.tapes = (tapes || []).filter(t => !isExcluded(t.name))
  const notes = showNotes(show, state.tapes)
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
    setTapesMessage('No set tapes for this show.', 'muted')
    return
  }

  for (const tape of state.tapes) {
    const b = document.createElement('button')
    b.className = 'tape'
    b.dataset.fileId = tape.fileId
    // Just the performer. The filename, size and Drive sharing state are ours to worry about.
    const who = document.createElement('strong')
    who.textContent = performerName(tape.name)
    b.append(who)
    if (!tape.youtubeId) {
      const soon = document.createElement('span')
      soon.className = 'soon small'
      soon.textContent = 'video coming soon'
      b.append(soon)
    }
    b.addEventListener('click', () => openTape(tape))
    box.append(b)
  }
  renderTapeSelection()
}

/** Which tape is open, marked without rebuilding the grid — in either picker. */
function renderTapeSelection() {
  for (const b of $('#tapes').querySelectorAll('.tape')) {
    b.classList.toggle('on', b.dataset.fileId === state.tape?.fileId)
  }
  renderSetSelection()
}

// ------------------------------------------------------------- by comedian --

// The tapes the roster can't place (comedians.js) sit at the end of the comedian list as one more
// "person", so the same library view lists them. Shown, never dropped: a set missing from
// someone's library is the failure this whole tab exists to prevent.
const UNMATCHED = { key: null, name: 'Unmatched tapes' }

$('#mode-show').addEventListener('click', () => { setMode('show'); writeUrl() })
$('#mode-comedian').addEventListener('click', () => { setMode('comedian'); writeUrl() })

/** Swap pickers. Nothing navigates: a tape that's open stays open under either one. */
function setMode(mode) {
  state.mode = mode
  for (const [id, m] of [['#mode-show', 'show'], ['#mode-comedian', 'comedian']]) {
    $(id).classList.toggle('on', m === mode)
    $(id).setAttribute('aria-pressed', String(m === mode))
  }
  $('#picker').hidden = mode !== 'show'
  $('#comedian-panel').hidden = mode !== 'comedian'
  renderCrumbs()
  if (mode === 'comedian') loadLibrary()
  // Show mode never pays for the cards' sheet reads: anything still queued for them stops here.
  else stopRequests()
}

function setNote(sel, text, tone = 'muted') {
  const p = $(sel)
  p.hidden = !text
  p.className = `small ${tone}`
  p.textContent = text
}

let libraryLoad = null

/**
 * The comedian index, built from data/upload-status.json — the file CI republishes after every
 * YouTube sync, so it is as fresh as the last sync. Fetched once; a failure is reported in this
 * panel only and forgotten, so the next visit to the tab tries again. Show mode never waits on it.
 */
async function loadLibrary() {
  if (!libraryLoad) {
    setNote('#comedians-note', 'Loading comedians…')
    libraryLoad = fetch(new URL('../data/upload-status.json', location.href), { cache: 'no-cache' })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then(status => { state.library = buildLibrary(status) })
  }
  try {
    await libraryLoad
  } catch (err) {
    libraryLoad = null
    setNote('#comedians-note', `Couldn’t load the comedian list (${err.message}). Try again in a minute, or use By show.`, 'error')
    return null
  }
  setNote('#comedians-note', state.library.comedians.length || state.library.unmatched.length
    ? '' : 'No comedians in the list yet — use By show.')
  if (state.comedian && !combo.open) comboInput.value = state.comedian.name
  // Clicked into the dropdown before the list had loaded: open it now rather than on the next key.
  if (document.activeElement === comboInput && !combo.open) openCombo(combo.query)
  renderLibrary()
  return state.library
}

// ------------------------------------------------------- comedian dropdown --
//
// A combobox, not a wall of chips: 60-odd names didn't fit on a phone. Focus stays in the input
// throughout — the highlighted option is aria-activedescendant, never focused — so typing keeps
// filtering while the arrows move. Picking someone goes through selectComedian like everything else.

const combo = { open: false, query: '', options: [], active: -1 }
const comboInput = $('#comedian-search')
const comboList = $('#comedian-list')

/** [{ comedian, count }] for the list as filtered by what's typed; Unmatched tapes last. */
function comboOptions(query) {
  if (!state.library) return []
  const options = searchComedians(state.library.comedians, query).map(c => ({ comedian: c, count: c.sets.length }))
  // Kept in view while searching if one of its raw labels matches: "Dan" should find the Dan
  // nobody has said which Dan is yet.
  const { unmatched } = state.library
  const q = normLabel(query)
  if (unmatched.length && (!q || unmatched.some(s => normLabel(s.label).includes(q)))) {
    options.push({ comedian: UNMATCHED, count: unmatched.length })
  }
  return options
}

function openCombo(query = combo.query) {
  if (!state.library) return
  // Opened rather than typed into: start from an empty box with the picked name as its
  // placeholder, so typing begins a new search instead of appending to the old name.
  if (!query) comboInput.value = ''
  comboInput.placeholder = state.comedian ? state.comedian.name : 'Pick a comedian…'
  combo.query = query
  combo.options = comboOptions(query)
  // While filtering, Enter takes the first match; with nothing typed, the list opens on whoever is
  // already picked so the arrows start from there.
  combo.active = query.trim() ? (combo.options.length ? 0 : -1)
    : combo.options.findIndex(o => o.comedian === state.comedian)
  combo.open = true
  renderCombo()
}

/** Close the list; the box goes back to showing whoever is picked. */
function closeCombo() {
  combo.open = false
  combo.active = -1
  combo.query = ''
  comboInput.value = state.comedian ? state.comedian.name : ''
  // Picked or Escaped with focus still here: the next key starts a new search rather than
  // appending to the name ("Yanjaa Westgated" matches no one).
  if (document.activeElement === comboInput) comboInput.select()
  renderCombo()
}

function renderCombo() {
  comboList.textContent = ''
  const show = combo.open && combo.options.length > 0
  comboList.hidden = !show
  comboInput.setAttribute('aria-expanded', String(show))
  comboInput.removeAttribute('aria-activedescendant')
  combo.options.forEach(({ comedian, count }, i) => {
    if (!show) return
    const li = document.createElement('li')
    // Named for the person, not the position, so aria-activedescendant changes (and is announced)
    // when typing puts someone new at the top.
    li.id = `comedian-opt-${comedian.key ?? 'unmatched'}`
    li.setAttribute('role', 'option')
    li.setAttribute('aria-selected', String(i === combo.active))
    li.className = (comedian === UNMATCHED ? 'unmatched' : '') + (comedian === state.comedian ? ' on' : '')
    const n = document.createElement('span')
    n.className = 'muted small'
    n.textContent = comedian === UNMATCHED ? ` · ${count}` : ` · ${count} set${count === 1 ? '' : 's'}`
    li.append(comedian.name, n)
    li.addEventListener('click', () => pickOption(i))
    comboList.append(li)
    if (i === combo.active) comboInput.setAttribute('aria-activedescendant', li.id)
  })
  comboList.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  const query = combo.query.trim()
  if (state.library) {
    setNote('#comedians-note', combo.open && !combo.options.length
      ? (query ? `No one matches “${query}”.` : 'No comedians in the list yet — use By show.')
      : '')
  }
}

function pickOption(i) {
  const option = combo.options[i]
  if (!option) return
  // Picked first, so closeCombo puts the new name in the box (and selects it).
  selectComedian(option.comedian)
  closeCombo()
}

// mousedown would blur the input, and the blur closes the list before the click lands. On the whole
// list, not each option: its padding and scrollbar take mousedowns too.
comboList.addEventListener('mousedown', e => e.preventDefault())
comboInput.addEventListener('focus', () => openCombo(''))
comboInput.addEventListener('click', () => { if (!combo.open) openCombo('') })
comboInput.addEventListener('input', () => openCombo(comboInput.value))
// Tab away, or a click anywhere outside: either way the input loses focus.
comboInput.addEventListener('blur', () => closeCombo())
comboInput.addEventListener('keydown', e => {
  const n = combo.options.length
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    if (!combo.open) return openCombo(combo.query)
    if (!n) return
    combo.active = e.key === 'ArrowDown'
      ? Math.min(combo.active + 1, n - 1)
      : Math.max(combo.active - 1, 0)
    renderCombo()
  } else if (e.key === 'Enter') {
    if (!combo.open) return
    e.preventDefault()
    if (combo.active >= 0) pickOption(combo.active)
  } else if (e.key === 'Escape') {
    if (!combo.open) return
    e.preventDefault()
    closeCombo()
  }
})
$('#comedian-toggle').addEventListener('mousedown', e => e.preventDefault())
$('#comedian-toggle').addEventListener('click', () => {
  if (combo.open) return closeCombo()
  if (document.activeElement === comboInput) openCombo('')
  else comboInput.focus() // the focus handler opens it
})

function selectComedian(comedian) {
  // Someone else's library is a new screen, the way a new show is in show mode: close the tape
  // that was open. closeReview also bumps the tape generation, which drops a set still opening
  // from the previous library (see openSet).
  if (comedian !== state.comedian) closeReview()
  state.comedian = comedian
  if (!combo.open) comboInput.value = comedian.name
  renderLibrary()
  renderCrumbs()
  writeUrl()
}

/** "also filed as Yanjaa, YanjaaW" — the aliases that aren't just the name re-punctuated. */
function alsoFiledAs(comedian) {
  const seen = new Set([normLabel(comedian.name)])
  const other = (comedian.aliases || []).filter(a => !seen.has(normLabel(a)) && seen.add(normLabel(a)))
  return other.length ? `also filed as ${other.join(', ')}` : ''
}

function renderLibrary() {
  const c = state.comedian
  const grid = $('#sets')
  grid.textContent = ''
  setNote('#library-msg', '')
  $('#library').hidden = !c || !state.library
  if ($('#library').hidden) return stopRequests()

  const sets = c === UNMATCHED ? state.library.unmatched : c.sets
  const count = `${sets.length} ${c === UNMATCHED ? 'tape' : 'set'}${sets.length === 1 ? '' : 's'}`
  $('#library-name').textContent = c.name
  $('#library-meta').textContent = c === UNMATCHED
    ? `${count} not yet matched to a comedian`
    : [count, alsoFiledAs(c)].filter(Boolean).join(' · ')
  for (const set of sets) grid.append(setCard(set, c))
  renderSetSelection()
  // A deep link's library can land after the user has already switched to By show, which never
  // pays for the cards' sheet reads; setMode('comedian') renders again on the way back.
  if (state.mode === 'comedian') fillRequests()
  else stopRequests()
}

/** One set: thumbnail, where it was, which part. Unmatched tapes lead with their raw label instead. */
function setCard(set, comedian) {
  const show = getShow(state.shows, set.folderId)
  const where = show ? showLabel(show) : set.show
  const b = document.createElement('button')
  b.className = 'set-card'
  b.dataset.folderId = set.folderId
  b.dataset.filename = set.filename

  const thumb = document.createElement('span')
  thumb.className = 'thumb'
  if (set.youtubeId) {
    const img = document.createElement('img')
    img.src = `https://i.ytimg.com/vi/${encodeURIComponent(set.youtubeId)}/mqdefault.jpg`
    img.alt = '' // the card's own text names the set
    img.loading = 'lazy'
    img.addEventListener('error', () => { img.remove(); thumb.textContent = 'no preview' })
    thumb.append(img)
  } else {
    thumb.classList.add('soon')
    thumb.textContent = 'video coming soon'
  }

  const title = document.createElement('strong')
  title.textContent = comedian === UNMATCHED ? set.label : where
  b.append(thumb, title)
  const sub = [comedian === UNMATCHED ? where : set.part, formatLength(set.durationSec)].filter(Boolean).join(' · ')
  if (sub) {
    const s = document.createElement('span')
    s.className = 'muted small'
    s.textContent = sub
    b.append(s)
  }
  const reqs = document.createElement('span')
  reqs.className = 'reqs small'
  b.append(reqs)
  b.addEventListener('click', () => openSet(set))
  return b
}

// ---------------------------------------------------- clip requests on cards --
//
// Each card says how many requests its tape has, how many are finished, and where they sit. That
// is a sheet read per show — listTapes for the tape's file id (the status file has none), getClips
// for every row in the show — so it runs only while a library is on screen, three shows at a time,
// and is remembered per show for the session. A save or delete in the review pane marks that show
// stale (requestsChanged) so the card catches up. A show that fails just leaves its cards bare (or
// on the last numbers it had); the card still opens.

const REQUEST_SHOWS_AT_ONCE = 3
// folderId -> { promise, pending, value: { tapes, sheet } | { layoutError } | null, failed, stale }
const requestCache = new Map()
// Bumped by every library render and by leaving the tab. Queued shows stop when it moves on, and a
// response only paints while the render that asked for it is still the current one.
let requestsGen = 0

const stopRequests = () => { requestsGen++ }

function loadRequests(folderId) {
  const had = requestCache.get(folderId)
  if (had?.pending && !had.stale) return had.promise
  const show = getShow(state.shows, folderId)
  // A refresh keeps the old numbers on the card until the new ones land, or if it fails.
  const entry = { pending: true, value: had?.value ?? null, failed: false, stale: false }
  // A save can't change the tape list, so a refresh re-reads only the sheet. That read has to be a
  // new one: getClips coalesces, and joining a flight that left before the save would bring back
  // the old count with nothing left marked stale to correct it.
  const known = had?.value?.tapes
  if (had?.pending) invalidate(`clips:${folderId}:`)
  entry.promise = Promise.all([known ? { tapes: known } : state.api.listTapes(show), state.api.getClips(show)]).then(
    ([{ tapes }, sheet]) => {
      // An old-format sheet is listed as unreadable in the review pane; claiming "no requests
      // yet" for it would be wrong, so its cards stay bare. It will say the same thing every
      // time, so that is remembered, not retried.
      entry.value = sheet.layoutError ? { layoutError: true }
        : { tapes: (tapes || []).filter(t => !isExcluded(t.name)), sheet }
    },
    () => { entry.failed = true },
  ).finally(() => { entry.pending = false })
  requestCache.set(folderId, entry)
  return entry.promise
}

/** Paint every card from what's known, then fetch the shows that aren't — at most three at once. */
function fillRequests() {
  const gen = ++requestsGen
  const want = []
  for (const card of $('#sets').querySelectorAll('.set-card')) {
    paintRequests(card)
    const id = card.dataset.folderId
    const entry = requestCache.get(id)
    // A failure is retried on the next render rather than remembered.
    const needed = !entry || entry.pending || entry.stale || entry.failed
    if (needed && !want.includes(id) && getShow(state.shows, id)) want.push(id)
  }
  let next = 0
  const worker = async () => {
    while (next < want.length && gen === requestsGen) {
      const id = want[next++]
      await loadRequests(id)
      if (gen === requestsGen) paintShow(id)
    }
  }
  for (let i = 0; i < REQUEST_SHOWS_AT_ONCE; i++) worker()
}

function paintShow(folderId) {
  for (const card of $('#sets').querySelectorAll('.set-card')) {
    if (card.dataset.folderId === folderId) paintRequests(card)
  }
}

/** "2 clip requests · 1 finished" and up to three spans; "…" while loading; nothing on failure. */
function paintRequests(card) {
  const box = card.querySelector('.reqs')
  if (!box) return
  box.textContent = ''
  const entry = requestCache.get(card.dataset.folderId)
  if (!entry?.value) {
    if (!entry || (entry.pending && !entry.failed)) {
      if (getShow(state.shows, card.dataset.folderId)) box.append(line(['…'], 'muted'))
    }
    return
  }
  if (entry.value.layoutError) return
  // The same exact-name rule openSet uses: two tapes with one name, or none, shows nothing.
  const tapes = entry.value.tapes.filter(t => t.name === card.dataset.filename)
  if (tapes.length !== 1) return
  const { count, finished, spans } = requestsForTape(entry.value.sheet, tapes[0])
  box.append(count
    ? line([`${count} clip request${count === 1 ? '' : 's'}`, finished ? `${finished} finished` : ''])
    : line(['no requests yet'], 'muted'))
  if (spans.length) {
    const shown = spans.slice(0, 3).map(s => `${s.start}–${s.end}`)
    if (spans.length > 3) shown[2] += ` +${spans.length - 3} more`
    box.append(line(shown, 'spans'))
  }
}

/** One line of " · "-separated parts that wraps only between parts, never inside "1 finished". */
function line(parts, className) {
  const span = document.createElement('span')
  if (className) span.className = className
  parts.filter(Boolean).forEach((text, i) => {
    if (i) span.append(' · ')
    const part = document.createElement('span')
    part.textContent = text
    span.append(part)
  })
  return span
}

/** A request was saved or deleted in `show`: its counts are out of date. */
function requestsChanged(show) {
  const entry = show && requestCache.get(show.folderId)
  if (!entry) return
  entry.stale = true
  if (state.mode === 'comedian' && !$('#library').hidden) fillRequests()
}

function renderSetSelection() {
  for (const b of $('#sets').querySelectorAll('.set-card')) {
    b.classList.toggle('on', !!state.tape && b.dataset.folderId === state.show?.folderId && b.dataset.filename === state.tape.name)
  }
}

/**
 * Open a set through the same path show mode takes — selectShow, then openTape — so the tape's
 * Drive id comes from listTapes behind the passphrase, never from the public status file.
 *
 * That file can trail Drive by a day. The show it names may be missing from listShows (a renamed
 * folder, the six-hour discovery cache) and the filename may be gone (a renamed tape); both say so
 * here. Neither falls back to a near match: the wrong tape means notes saved against someone
 * else's set.
 */
async function openSet(set) {
  // The message sits above the grid and the card clicked may be far below it: bring it into view.
  const fail = text => {
    setNote('#library-msg', text, 'error')
    $('#library-msg').scrollIntoView({ block: 'nearest' })
  }
  const show = getShow(state.shows, set.folderId)
  if (!show) {
    fail('This show isn’t available yet — it may have been renamed in Drive. Try again later, or look under By show.')
    return
  }
  setNote('#library-msg', 'Opening…')
  pickedYear = show.year
  // selectShow enters a new show generation and closes the open tape before its first await, so a
  // token taken straight after the call belongs to this click. Picking another show, set or
  // comedian moves the generation on, and this one's late tape list then opens nothing.
  const pending = selectShow(show)
  const token = nav.token('tape')
  const tapes = await pending
  if (!nav.alive(token)) return
  if (!tapes) {
    // selectShow reports a listTapes failure into the tape column, which this tab hides.
    fail($('#tapes').textContent || 'Couldn’t load this show’s tapes.')
    return
  }
  const matches = tapes.filter(t => t.name === set.filename)
  if (matches.length !== 1) {
    fail(matches.length
      ? `${showLabel(show)} has ${matches.length} tapes called “${set.filename}” — pick the right one under By show.`
      : `“${set.filename}” isn’t in ${showLabel(show)} any more — it was probably renamed since this list was refreshed. Look under By show.`)
    return
  }
  setNote('#library-msg', '')
  // openTape un-hides the review pane before its first await; it opens below the whole grid, so
  // scroll to it or a click on a card far down looks like it did nothing.
  const opening = openTape(matches[0])
  $('#review').scrollIntoView({ block: 'start', behavior: 'smooth' })
  await opening
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
  $('#tape-name').textContent = state.tape ? performerName(state.tape.name) : ''
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
      'The video for this tape is still being uploaded — check back in a day or two. ' +
      'Your clip requests and finished clips are on the right.')
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
    clipLinks: c.clipLinks || [],
  }))
  state.legacy = value.legacy || []

  const link = $('#sheet-link')
  link.hidden = !value.sheetUrl
  if (value.sheetUrl) link.href = value.sheetUrl

  // An old-format sheet: the backend refuses to read or write it as A–G. Say so, plainly.
  $('#new-clip').disabled = !!value.layoutError
  if (value.layoutError) {
    list.className = 'clip-list muted'
    list.textContent = 'This show’s request sheet is in an older format, so requests can’t be edited here — open the sheet instead.'
    return
  }

  list.className = 'clip-list'
  renderClips()
}

$('#new-clip').addEventListener('click', () => {
  if (!state.tape) return
  const clip = newClip({
    name: performerName(state.tape.name),
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
  renderFinished()
  renderTimeline()
  if (!state.clips.length && !myLegacy().length && state.tape) {
    const p = document.createElement('p')
    p.className = 'hint muted small'
    p.textContent = 'No clip requests yet. Play the tape, hit “+ New clip” where a bit starts, and “now” to mark the in and out points.'
    list.append(p)
  }
}

/** "Finished clip ↗" / "View carousel ↗" anchors for the Drive links in the sheet's Finished clip column. */
function renderClipLinks(box, urls) {
  box.textContent = ''
  const labels = linkLabels(urls || [])
  ;(urls || []).forEach((url, i) => {
    const a = document.createElement('a')
    a.href = url
    a.target = '_blank'
    a.rel = 'noopener'
    a.textContent = labels[i]
    box.append(a)
  })
}

function renderClip(clip, index) {
  const node = $('#tpl-clip').content.firstElementChild.cloneNode(true)
  const ranges = playableRanges(clip)

  node.querySelector('.clip-title').textContent = `Clip ${index + 1}`
  node.querySelector('.clip-summary').textContent = ranges.length
    ? `${ranges.length > 1 ? `${ranges.length} parts · ` : ''}${formatTime(totalDuration(ranges))}`
    : 'no ranges yet'
  if (clip.duplicate) node.classList.add('bad')
  renderClipLinks(node.querySelector('.clip-links'), clip.clipLinks)

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
  // A reel is made from the request as it is in the sheet. Unsaved changes are saved first rather
  // than refused: refusing put a red line at the foot of the card, far from the button, and read as
  // "Create clip does nothing".
  const reelBtn = node.querySelector('.make-reel')
  const carouselBtn = node.querySelector('.make-carousel')
  // Shared by Create clip and Create carousel: duplicate check, save-first, no-ranges check.
  // Resolves to the playable ranges, or null when it has already said why not.
  async function readyToDraft(btn, label) {
    const msg = node.querySelector('.clip-msg')
    if (clip.duplicate) {
      msg.textContent = 'This request appears twice in the sheet — fix that first.'
      msg.className = 'clip-msg small error'
      msg.scrollIntoView({ block: 'nearest' })
      return null
    }
    if (clip.rev === undefined || clip.dirty) {
      // Both buttons, not just the one pressed: a click on the other mid-save would start a second
      // save of the same row (a self-conflict) and open its editor on a request not yet saved.
      const both = [reelBtn, carouselBtn]
      both.forEach(b => { b.disabled = true })
      btn.textContent = 'Saving…'
      const saved = await saveClip(clip, node)
      both.forEach(b => { b.disabled = false })
      btn.textContent = label
      if (!saved) { msg.scrollIntoView({ block: 'nearest' }); return null }
    }
    const ranges = playableRanges(clip)
    if (!ranges.length) {
      msg.textContent = 'Add a start and end time first.'
      msg.className = 'clip-msg small error'
      msg.scrollIntoView({ block: 'nearest' })
      return null
    }
    return ranges
  }
  reelBtn.addEventListener('click', async () => {
    const ranges = await readyToDraft(reelBtn, 'Create clip')
    if (ranges) openReel({ clip, ranges, notes: clip.notes, granular: clip.granular })
  })
  carouselBtn.addEventListener('click', async () => {
    const ranges = await readyToDraft(carouselBtn, 'Create carousel')
    if (ranges) openCarousel({ clip, ranges, notes: clip.notes, granular: clip.granular })
  })
  node.querySelector('.del').addEventListener('click', () => deleteClip(clip))
  node.querySelector('.save').addEventListener('click', () => saveClip(clip, node))

  const msg = node.querySelector('.clip-msg')
  if (clip.duplicate) {
    msg.textContent = 'This clip appears twice in the sheet — ask Neal to fix it.'
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

/** Save a request. Resolves true once the sheet has it; false (with the reason on the card) if not. */
async function saveClip(clip, node) {
  const msg = node.querySelector('.clip-msg')
  const problem = validate(clip, state.duration)
  if (problem) {
    msg.textContent = problem
    msg.className = 'clip-msg small error'
    return false
  }

  const button = node.querySelector('.save')
  button.disabled = true
  msg.textContent = 'Saving…'
  msg.className = 'clip-msg small muted'

  // The write itself is never abandoned — it is already in flight against the right sheet and must
  // be allowed to land. Only the UI it reports into is conditional: a save that resolves after you
  // moved on would otherwise point the header's sheet link at the show you just left.
  const token = nav.token('tape')
  const show = state.show
  const res = await nav.settle(token, state.api.saveClip(show, clip, state.duration))
  // A stale save may still have landed — the library's counts for that show go stale either way.
  if (res.state !== 'error') requestsChanged(show)
  if (res.state === 'stale') return false

  button.disabled = false
  if (res.state === 'error') {
    msg.textContent = res.error.data?.conflict
      ? 'Someone edited this request in the sheet just now. Reload the page to see it.'
      : res.error.message
    msg.className = 'clip-msg small error'
    return false
  }

  clip.rev = res.value.rev
  clip.dirty = false
  msg.textContent = 'Saved'
  msg.className = 'clip-msg small ok'
  const link = $('#sheet-link')
  if (res.value.sheetUrl) { link.href = res.value.sheetUrl; link.hidden = false }
  renderTimeline()
  return true
}

async function deleteClip(clip) {
  if (!confirm('Delete this clip?')) return
  // Always ask the server, even for a clip that looks unsaved. `clip.rev` is only set once a
  // save resolves, so hitting Save then ✕ would otherwise drop the card locally while the
  // in-flight append lands — leaving an orphan row the app can't see and the editors will cut.
  // deleteClip is idempotent server-side (returns alreadyGone when there is nothing to remove).
  const token = nav.token('tape')
  const show = state.show
  const res = await nav.settle(token, state.api.deleteClip(show, clip.clipId))
  if (res.state !== 'error') requestsChanged(show)
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
/** Open the reel editor over the review, pausing the tape underneath. */
function openReel({ clip = null, row = null, ranges, notes, granular }) {
  if (!state.show || !state.tape || !ranges.length) return
  state.player?.cancel()
  state.player?.pause()
  openReelEditor({
    api: state.api,
    show: state.show,
    tape: { ...state.tape, performer: performerName(state.tape.name) },
    clip,
    row,
    ranges,
    notes,
    granular,
  })
}

/** Open the carousel editor over the review, pausing the tape underneath. */
function openCarousel({ clip = null, row = null, ranges, notes, granular }) {
  if (!state.show || !state.tape || !ranges.length) return
  state.player?.cancel()
  state.player?.pause()
  openCarouselEditor({
    api: state.api,
    show: state.show,
    tape: { ...state.tape, performer: performerName(state.tape.name) },
    clip,
    row,
    ranges,
    notes,
    granular,
  })
}

function myLegacy() {
  if (!state.tape || !state.show) return []
  const who = performerName(state.tape.name)
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

  if (mine.length) {
    const h = document.createElement('h3')
    h.textContent = 'Already in the sheet'
    const note = document.createElement('p')
    note.className = 'muted small'
    note.textContent = 'These were typed straight into the request sheet — edit them there.'
    box.append(h, note)
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
    const hasTimes = row.start || row.end || (row.granular && /\d/.test(row.granular))
    // A row with no times but a finished-clip link is just "here is your clip".
    span.textContent = hasTimes ? `${row.start || '?'} → ${row.end || '?'}` : ''
    head.append(who, span)
    if (row.clipLinks?.length) {
      const links = document.createElement('span')
      links.className = 'clip-links small'
      renderClipLinks(links, row.clipLinks)
      head.append(links)
    }

    if (ranges.length) {
      const play = document.createElement('button')
      play.className = 'linkish'
      play.textContent = '▶ Play'
      play.addEventListener('click', () => playRanges(ranges))
      const reel = document.createElement('button')
      reel.className = 'linkish'
      reel.textContent = 'Create clip'
      reel.title = 'Draft a vertical clip (Reels / TikTok / Shorts) from this request'
      reel.addEventListener('click', () => openReel({ row, ranges, notes: row.notes, granular: row.granular }))
      const carousel = document.createElement('button')
      carousel.className = 'linkish'
      carousel.textContent = 'Create carousel'
      carousel.title = 'Draft an Instagram carousel (4:5 slides) from this request'
      carousel.addEventListener('click', () => openCarousel({ row, ranges, notes: row.notes, granular: row.granular }))
      head.append(play, reel, carousel)
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

/**
 * The performer's finished clips from the show's completed_clips/ folder that no request row
 * already links to. Editors sometimes cut a clip nobody formally asked for; this is where it shows.
 */
function renderFinished() {
  const box = $('#finished-list')
  box.textContent = ''
  if (!state.tape || !state.show) return
  const who = performerName(state.tape.name)
  const linked = new Set([...state.clips, ...myLegacy()].flatMap(r => r.clipLinks || []).map(u => (u.match(/\/d\/([\w-]{10,})/) || [])[1] || u))
  const mine = (state.finished || []).filter(f => clipBelongsTo(f.name, who) && !linked.has(f.fileId))
  if (!mine.length) return
  const wrap = document.createElement('div')
  wrap.className = 'finished'
  const h = document.createElement('h3')
  h.textContent = 'Finished clips'
  const ul = document.createElement('ul')
  for (const f of mine) {
    const li = document.createElement('li')
    const a = document.createElement('a')
    a.href = f.url
    a.target = '_blank'
    a.rel = 'noopener'
    a.textContent = `${clipTopic(f.name)} \u2197`
    li.append(a)
    ul.append(li)
  }
  wrap.append(h, ul)
  box.append(wrap)
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
  const bits = ['Clip Requests']
  if (state.mode === 'comedian') {
    // Clip Requests / Yanjaa Westgate / May 2026 · Boston. The performer is only added when the
    // open tape isn't one of the library's own sets (unmatched, or opened from By show).
    if (state.comedian) bits.push(state.comedian.name)
    if (state.tape) {
      bits.push(showLabel(state.show))
      const own = state.comedian?.sets?.some(s => s.folderId === state.show.folderId && s.filename === state.tape.name)
      if (!own) bits.push(performerName(state.tape.name))
    }
  } else {
    if (state.show) bits.push(showLabel(state.show))
    if (state.tape) bits.push(performerName(state.tape.name))
  }
  // The bar's show links follow the crumbs: in comedian mode a show is only on screen once a tape
  // in it is open, and a link into the last library's show would point somewhere not shown.
  const showInView = !!state.show && (state.mode !== 'comedian' || !!state.tape)
  for (const id of ['#photos-link', '#clips-link', '#legacy-sheet-link']) {
    $(id).hidden = !showInView || !$(id).hasAttribute('href')
  }
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
  // ?comedian= is the link to send someone. Show mode writes exactly what it always has; comedian
  // mode only names a show once a tape in it is open, so a bare library link stays bare.
  const byComedian = state.mode === 'comedian'
  if (byComedian && state.comedian?.key) params.set('comedian', state.comedian.key)
  if (state.show && (!byComedian || state.tape)) params.set('show', state.show.folderId)
  if (state.tape) params.set('tape', state.tape.fileId)
  history.replaceState(null, '', `?${params}`)
}

async function restoreFromUrl() {
  const params = new URLSearchParams(location.search)
  // A comedian link opens their library first; show and tape below then restore as they always
  // have. Without one, none of this runs.
  if (params.has('comedian')) {
    const token = nav.token('tape')
    setMode('comedian')
    const library = await loadLibrary()
    // Clicked something while the list loaded — that wins.
    if (!nav.alive(token)) return
    const key = params.get('comedian')
    const comedian = library?.comedians.find(c => c.key === key)
    if (comedian) selectComedian(comedian)
    else if (library) setNote('#comedians-note', `No comedian “${key}” in the list — pick one above.`, 'error')
  }

  const show = getShow(state.shows, params.get('show'))
  if (!show) return
  pickedYear = show.year

  // selectShow returns the list it just fetched. This used to call listTapes a SECOND time for the
  // same folder — so every deep link and every reload paid for two full Drive listings.
  const tapes = await selectShow(show)
  if (!tapes) return

  const tapeId = params.get('tape')
  if (!tapeId) return
  // Only open it if the user hasn't already picked something else while the list was loading.
  if (state.show?.folderId !== show.folderId || state.tape) return
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
