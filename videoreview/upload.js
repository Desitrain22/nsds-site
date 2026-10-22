// Videographer upload portal. Pick a show, paste a public folder or WeTransfer link, say whose
// tapes are whose, file it. The transfer itself happens later, off a submission record in Drive.
//
// Gated by its own key, so this page never sees a clip request. See apps-script/Code.gs for why.

import { BACKEND_URL, showsByYear, showFolderName, showLabel } from './shows.js'
import { Api } from './api.js'
import { Nav } from './nav.js'
import { parseShareLink, routeAll, findShowCollision, normalizeCity, guessPerformers, planTapes, pileDest, angleFrom } from './ingest.js'

const $ = sel => document.querySelector(sel)
const CFG_KEY = 'nsds-review-config'
const LAST_JOB = 'nsds-upload-last-key'

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
                     'July', 'August', 'September', 'October', 'November', 'December']

const state = {
  api: null,
  shows: [],
  show: null,        // an existing show record, or a declared { month, year, city, folderName }
  link: null,        // parseShareLink result
  preview: null,     // whatever uploadPreview returned
  rows: [],          // routeAll rows, with .selected
  bySrc: new Map(),  // src -> row
  performers: [],    // the assign board: { id, name, files: [src], main: src, angles: { src: name } }
  submissionKey: null,
}

// Picking a show abandons a preview in flight; pasting a new link abandons the confirm table
// built from the old one. Without this, a slow preview for link A can paint over the table for
// link B and the submit button then files A's files under B's show.
const nav = new Nav(['show', 'preview'])

const loadConfig = () => { try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}') } catch { return {} } }
const fmtGB = n => `${(n / 1e9).toFixed(2)} GB`
const fmtGiB = n => `${(n / 1024 ** 3).toFixed(1)} GiB`

function step(name) {
  for (const id of ['step-show', 'step-link', 'step-confirm', 'step-done']) {
    $(`#${id}`).hidden = id !== name
  }
}

// ------------------------------------------------------------------ gate --

$('#gate-form').addEventListener('submit', async e => {
  e.preventDefault()
  const err = $('#gate-error')
  err.hidden = true
  const endpoint = loadConfig().endpoint || BACKEND_URL
  // Trimmed: the key gets pasted, and a trailing newline is invisible in a password field.
  state.api = new Api({ endpoint, uploadKey: $('#gate-input').value.trim() })
  if (!endpoint) {
    err.textContent = 'This page isn’t set up yet — let Neal know.'
    err.hidden = false
    return
  }
  const button = $('#gate-form button[type="submit"]')
  button.disabled = true
  try {
    // Listing the shows doubles as the key check — the picker needs them anyway.
    const { shows } = await state.api.call('uploadShows', {}, { retries: 1 })
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
  renderMonths()
  renderCrumbs()
  step('step-show')
})

// ------------------------------------------------------------------ step 1: the show --

let pickedYear = null

function renderPicker() {
  const byYear = showsByYear(state.shows)
  // The show being submitted is often for a year with no shows in Drive yet, so the chips cannot
  // come from the data alone.
  const now = new Date().getFullYear()
  const years = [...new Set([...byYear.keys(), now - 1, now, now + 1])].sort((a, b) => b - a)
  if (pickedYear === null) pickedYear = years[0]

  const yearBox = $('#years')
  yearBox.textContent = ''
  for (const year of years) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'chip' + (year === pickedYear ? ' on' : '')
    b.textContent = year
    b.addEventListener('click', () => { pickedYear = year; renderPicker() })
    yearBox.append(b)
  }

  const showBox = $('#shows')
  showBox.textContent = ''
  const mine = byYear.get(pickedYear) || []
  if (!mine.length) {
    const p = document.createElement('p')
    p.className = 'muted small'
    p.textContent = 'No shows filed for that year yet — add one below.'
    showBox.append(p)
  }
  for (const show of mine) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'chip' + (state.show?.folderId === show.folderId ? ' on' : '')
    b.textContent = showLabel(show)
    b.addEventListener('click', () => chooseShow(show))
    showBox.append(b)
  }

  const cities = [...new Set(state.shows.map(s => s.city).filter(Boolean))].sort()
  $('#known-cities').innerHTML = cities.map(c => `<option value="${c}"></option>`).join('')
  $('#new-year').value = $('#new-year').value || pickedYear
}

let pickedMonth = null

function renderMonths() {
  const box = $('#months')
  box.textContent = ''
  MONTH_NAMES.forEach((name, i) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'chip' + (pickedMonth === i + 1 ? ' on' : '')
    b.textContent = name.slice(0, 3)
    b.title = name
    b.addEventListener('click', () => { pickedMonth = i + 1; renderMonths(); refreshNewShow() })
    box.append(b)
  })
}

/**
 * Live feedback while a new show is declared. The collision check is the point: "June 2026"
 * genuinely has three shows and the city is the only thing telling them apart, so creating a
 * second folder for one that exists is an easy and quiet mistake.
 */
function refreshNewShow() {
  const month = pickedMonth
  const year = Number($('#new-year').value)
  const city = $('#new-city').value
  const name = month && year ? showFolderName({ month, year, city }) : null
  $('#new-preview').textContent = name ? `Folder will be named: ${name}` : 'Pick a month and a year.'

  const warn = $('#new-warn')
  const block = $('#new-block')
  warn.hidden = true
  block.hidden = true
  $('#use-new-show').disabled = !name

  if (!name) return
  const clash = findShowCollision(state.shows, { month, year, city })
  if (clash?.kind === 'exact') {
    block.textContent = `${showLabel(clash.show)} already exists. Use it from the list above instead of making a second folder.`
    block.hidden = false
    $('#use-new-show').disabled = true
  } else if (clash?.kind === 'sameMonth') {
    const others = clash.shows.map(s => s.city || '(no city)').join(', ')
    warn.textContent = `${MONTH_NAMES[month - 1]} ${year} already has ${others}. Make sure "${normalizeCity(city) || 'no city'}" isn't one of those under another name.`
    warn.hidden = false
  }
}

for (const id of ['#new-year', '#new-city']) $(id).addEventListener('input', refreshNewShow)

$('#use-new-show').addEventListener('click', () => {
  const month = pickedMonth
  const year = Number($('#new-year').value)
  const city = $('#new-city').value.trim()
  chooseShow({ month, year, city: city || null, folderName: showFolderName({ month, year, city }), label: `${MONTH_NAMES[month - 1]} ${year}`, isNew: true })
})

function chooseShow(show) {
  nav.enter('show')
  state.show = show
  state.preview = null
  state.rows = []
  state.performers = []
  state.submissionKey = null
  renderPicker()
  renderCrumbs()
  $('#link-detected').hidden = true
  $('#link-error').hidden = true
  step('step-link')
  $('#link-input').focus()
}

// ------------------------------------------------------------------ step 2: the link --

$('#link-input').addEventListener('input', () => {
  const parsed = parseShareLink($('#link-input').value)
  const ok = $('#link-detected')
  const bad = $('#link-error')
  if (!$('#link-input').value.trim()) { ok.hidden = true; bad.hidden = true; return }
  if (parsed.source) {
    ok.textContent = { dropbox: 'Dropbox folder ✓', drive: 'Google Drive folder ✓', wetransfer: 'WeTransfer ✓' }[parsed.source]
    ok.hidden = false
    bad.hidden = true
  } else {
    bad.textContent = parsed.error
    bad.hidden = false
    ok.hidden = true
  }
})

$('#link-form').addEventListener('submit', async e => {
  e.preventDefault()
  const parsed = parseShareLink($('#link-input').value)
  if (!parsed.source) {
    $('#link-error').textContent = parsed.error
    $('#link-error').hidden = false
    return
  }
  state.link = parsed
  const token = nav.enter('preview')
  const btn = $('#link-form button')
  btn.disabled = true
  btn.textContent = 'Reading…'
  try {
    const res = await nav.settle(token, state.api.call('uploadPreview', { link: parsed.normalized }, { retries: 1 }))
    if (res.state === 'stale') return
    if (res.state === 'error') {
      $('#link-error').textContent = res.error.message
      $('#link-error').hidden = false
      return
    }
    state.preview = res.value
    buildRows()
    step('step-confirm')
    renderCrumbs()
  } finally {
    btn.disabled = false
    btn.textContent = 'Look inside ›'
  }
})

// ------------------------------------------------------------------ step 3: confirm --
//
// Videos go on a board of performer cards (guessPerformers' first guess, then the uploader's
// corrections); photos and unrecognised files stay in plain checklists below it. The uploader never
// sees a Drive path for a tape — planTapes decides those from the board at submit time.

const isVideo = r => r.kind === 'tape' || r.kind === 'extra'
let nextCardId = 1
const newCard = (fields = {}) => ({ id: nextCardId++, name: '', files: [], main: null, angles: {}, ...fields })

function buildRows() {
  const { rows } = routeAll((state.preview.entries || []).map(e => ({ path: e.path, bytes: e.bytes, href: e.href })))
  state.rows = rows.map(r => ({ ...r, selected: true }))
  state.bySrc = new Map(state.rows.map(r => [r.src, r]))
  state.performers = guessPerformers(state.rows).map(p => newCard(p))
  state.submissionKey = crypto.randomUUID()
  renderConfirm()
}

/** The card a file is on, or null when it is in the not-a-set pile. */
const cardOf = src => state.performers.find(p => p.files.includes(src)) || null

/** Move one file onto a card (or into the pile, with `to` null), keeping every card's main valid. */
function moveFile(src, to) {
  const from = cardOf(src)
  if (from === to) return
  if (from) {
    from.files = from.files.filter(s => s !== src)
    if (from.main === src) from.main = from.files[0] || null
  }
  if (to) {
    to.files = [...to.files, src].sort((a, b) => a.localeCompare(b))
    if (!to.main) to.main = src
    else if (!to.angles[src]) to.angles[src] = angleFrom(src, to.name) || String(to.files.length)
  }
  renderConfirm()
}

/** Everything that would be filed right now, and everything stopping it. */
function currentPlan() {
  const plan = planTapes(state.performers, state.bySrc)
  const rest = state.rows
    .filter(r => r.selected && !(isVideo(r) && cardOf(r.src)))
    .map(r => ({ src: r.src, dest: isVideo(r) ? pileDest(r) : r.dest, bytes: r.bytes, href: r.href || null }))
  return { manifest: [...plan.manifest, ...rest], problems: plan.problems }
}

function renderConfirm() {
  renderChecks()
  renderBoard()
  renderGroups()
}

/** The totals, the blockers and the submit bar. Cheap, so it runs on every keystroke. */
function renderChecks() {
  const preview = state.preview
  const { manifest, problems } = currentPlan()
  const selBytes = manifest.reduce((n, r) => n + r.bytes, 0)
  const tapes = manifest.filter(r => r.dest.startsWith('tapes/') && !r.dest.includes('/angles/')).length

  // Reconciliation is load-bearing, not decoration: an incomplete listing means a partial show,
  // and everything missing would look like it was never shot.
  const recon = $('#reconcile')
  recon.textContent = ''
  const head = document.createElement('div')
  head.innerHTML = `<strong>${state.show.folderName || showLabel(state.show)}</strong> — `
    + `${state.rows.length} files · ${fmtGiB(state.rows.reduce((n, r) => n + r.bytes, 0))} found`
  const line = document.createElement('div')
  line.className = 'muted small'
  line.textContent = `${manifest.length} to copy · ${fmtGiB(selBytes)} · ${state.rows.length - manifest.length} skipped`
  recon.append(head, line)
  if (preview.expiresAt) {
    const exp = document.createElement('div')
    exp.className = 'muted small'
    exp.textContent = `This WeTransfer link expires ${new Date(preview.expiresAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}.`
    recon.append(exp)
  }

  if (preview.complete === false) {
    problems.unshift(`This listing is incomplete — ${preview.incomplete?.reason || 'the source did not return everything'}. `
      + 'Submitting now would copy a partial show, and anything missing would look like it was never shot.')
  }
  const dests = manifest.map(r => r.dest)
  const dupes = dests.filter((d, i) => dests.indexOf(d) !== i)
  if (dupes.length) problems.push(`Two files both land on ${[...new Set(dupes)].join(', ')}. Rename one.`)
  if (!tapes) problems.push('No performer has a file yet, so nothing would be reviewable.')

  const blocker = $('#blocker')
  blocker.textContent = ''
  blocker.hidden = !problems.length
  for (const p of problems) {
    const el = document.createElement('p')
    el.textContent = p
    blocker.append(el)
  }
  // Removed from the DOM, not disabled: a disabled button is one devtools attribute away from a
  // partial hundred-gigabyte transfer.
  $('#submit-bar').hidden = problems.length > 0
  $('#submit-summary').textContent = `${tapes} performers · ${fmtGiB(selBytes)}`
}

function dropTarget(el, card) {
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drop-on') })
  el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop-on') })
  el.addEventListener('drop', e => {
    e.preventDefault()
    el.classList.remove('drop-on')
    const src = e.dataTransfer.getData('text/plain')
    if (state.bySrc.has(src)) moveFile(src, card)
  })
}

function renderBoard() {
  $('#board-wrap').hidden = !state.rows.some(isVideo)
  const board = $('#board')
  board.textContent = ''
  for (const p of state.performers) board.append(renderCard(p))
  const pile = $('#pile')
  pile.textContent = ''
  pile.append(renderPile(state.rows.filter(r => isVideo(r) && !cardOf(r.src))))
}

function renderCard(p) {
  const card = document.createElement('section')
  card.className = 'card'
  card.dataset.card = p.id

  const head = document.createElement('div')
  head.className = 'card-head'
  const name = document.createElement('input')
  name.type = 'text'
  name.className = 'name'
  name.placeholder = 'Performer name'
  name.value = p.name
  // Patched in place, never re-rendered: rebuilding the board here would destroy whatever the
  // uploader just clicked into next, and the first thing they type would go nowhere.
  name.addEventListener('input', () => {
    p.name = name.value
    for (const o of document.querySelectorAll(`select.move option[value="c${p.id}"]`)) o.textContent = p.name || '(no name yet)'
    renderChecks()
  })
  const meta = document.createElement('span')
  meta.className = 'muted small'
  meta.textContent = p.files.length ? fmtGiB(p.files.reduce((n, s) => n + state.bySrc.get(s).bytes, 0)) : ''
  head.append(name, meta)
  if (!p.files.length) {
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'linkish'
    remove.textContent = 'remove'
    remove.addEventListener('click', () => { state.performers = state.performers.filter(x => x !== p); renderConfirm() })
    head.append(remove)
  }
  card.append(head)

  if (!p.files.length) {
    const empty = document.createElement('p')
    empty.className = 'muted small drop-hint'
    empty.textContent = 'Drop this performer’s files here.'
    card.append(empty)
  }
  for (const src of p.files) card.append(renderFile(src, p))
  dropTarget(card, p)
  return card
}

function renderPile(rows) {
  const wrap = document.createElement('section')
  wrap.className = 'group pile'
  const head = document.createElement('div')
  head.className = 'group-head'
  head.innerHTML = `<strong>Not a set</strong> <span class="muted small">${rows.length} files · ${fmtGiB(rows.reduce((n, r) => n + r.bytes, 0))}</span>`
  wrap.append(head)
  const note = document.createElement('p')
  note.className = 'muted small'
  note.textContent = rows.length
    ? 'Sizzles, intros and anything else that isn’t someone’s set. Kept with the show’s extras, never reviewed. Untick a file to skip it entirely.'
    : 'Drag anything that isn’t a performer’s set here.'
  wrap.append(note)
  for (const r of rows) wrap.append(renderFile(r.src, null))
  dropTarget(wrap, null)
  return wrap
}

/** One file, on a card (`card`) or in the pile (null). Draggable, with a menu for touch screens. */
function renderFile(src, card) {
  const row = state.bySrc.get(src)
  const el = document.createElement('div')
  el.className = 'file'
  el.draggable = true
  el.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/plain', src)
    e.dataTransfer.effectAllowed = 'move'
    el.classList.add('dragging')
  })
  el.addEventListener('dragend', () => el.classList.remove('dragging'))

  const pick = document.createElement('label')
  pick.className = 'pick small'
  const input = document.createElement('input')
  if (card) {
    input.type = 'radio'
    input.name = `main-${card.id}`
    input.checked = card.main === src
    input.addEventListener('change', () => {
      const was = card.main
      card.main = src
      if (was && !card.angles[was]) card.angles[was] = angleFrom(was, card.name) || String(card.files.length)
      renderConfirm()
    })
    pick.append(input, document.createTextNode(' main'))
  } else {
    input.type = 'checkbox'
    input.checked = row.selected
    input.addEventListener('change', () => { row.selected = input.checked; renderChecks() })
    pick.append(input, document.createTextNode(' copy'))
  }

  const name = document.createElement('span')
  name.className = 'src small'
  name.textContent = src.split('/').pop()
  name.title = src

  const label = document.createElement('span')
  label.className = 'what'
  if (card && card.main !== src) {
    const angle = document.createElement('input')
    angle.type = 'text'
    angle.className = 'angle'
    angle.placeholder = 'angle name'
    angle.value = card.angles[src] || ''
    angle.addEventListener('input', () => { card.angles[src] = angle.value; renderChecks() })
    label.append(angle)
  } else if (card) {
    label.classList.add('muted', 'small')
    label.textContent = 'reviewed and clipped'
  } else {
    label.classList.add('muted', 'small')
    label.textContent = row.kind === 'tape' ? 'kept as an extra' : row.why
  }

  const size = document.createElement('span')
  size.className = 'muted small size'
  size.textContent = fmtGB(row.bytes)

  const menu = document.createElement('select')
  menu.className = 'move small'
  menu.title = 'Move to…'
  for (const p of state.performers) menu.append(new Option(p.name || '(no name yet)', `c${p.id}`, false, p === card))
  menu.append(new Option('Not a set', 'pile', false, !card), new Option('+ New performer…', 'new'))
  menu.addEventListener('change', () => {
    if (menu.value === 'new') {
      const fresh = newCard()
      state.performers.push(fresh)
      moveFile(src, fresh)
      document.querySelector(`[data-card="${fresh.id}"] input.name`)?.focus()
      return
    }
    moveFile(src, menu.value === 'pile' ? null : state.performers.find(p => `c${p.id}` === menu.value))
  })

  el.append(pick, name, label, size, menu)
  return el
}

$('#add-performer').addEventListener('click', () => {
  const fresh = newCard()
  state.performers.push(fresh)
  renderBoard()
  document.querySelector(`[data-card="${fresh.id}"] input.name`)?.focus()
})

const BUCKETS = [
  ['photo', 'Photos', 'Stills. Copied as-is.'],
  ['other', 'Other files', 'Not a photo or a video. Copied alongside the extras so nothing is lost.'],
]

function renderGroups() {
  const box = $('#groups')
  box.textContent = ''
  for (const [kind, title, why] of BUCKETS) {
    const mine = state.rows.filter(r => r.kind === kind)
    if (!mine.length) continue
    box.append(renderGroup(kind, title, why, mine))
  }
}

function renderGroup(kind, title, why, rows) {
  const wrap = document.createElement('section')
  wrap.className = 'group'
  const bytes = rows.reduce((n, r) => n + r.bytes, 0)

  const head = document.createElement('div')
  head.className = 'group-head'
  head.innerHTML = `<strong>${title}</strong> <span class="muted small">${rows.length} files · ${fmtGiB(bytes)}</span>`
  const all = document.createElement('button')
  all.type = 'button'; all.className = 'linkish'; all.textContent = 'all'
  all.addEventListener('click', () => { rows.forEach(r => { r.selected = true }); renderConfirm() })
  const none = document.createElement('button')
  none.type = 'button'; none.className = 'linkish'; none.textContent = 'none'
  none.addEventListener('click', () => { rows.forEach(r => { r.selected = false }); renderConfirm() })
  head.append(all, none)
  wrap.append(head)

  const note = document.createElement('p')
  note.className = 'muted small'
  note.textContent = why
  wrap.append(note)

  // A hundred photos are a count, not a list.
  const listed = kind === 'photo' && rows.length > 12
  const host = listed ? document.createElement('details') : wrap
  if (listed) {
    const sum = document.createElement('summary')
    sum.textContent = `show the ${rows.length} files`
    host.append(sum)
    wrap.append(host)
  }
  for (const row of rows) host.append(renderRow(row))
  return wrap
}

function renderRow(row) {
  const el = document.createElement('div')
  el.className = 'row'
  const box = document.createElement('input')
  box.type = 'checkbox'
  box.checked = row.selected
  box.addEventListener('change', () => { row.selected = box.checked; renderChecks() })

  const src = document.createElement('span')
  src.className = 'src small'
  src.textContent = row.src
  src.title = row.why

  const arrow = document.createElement('span')
  arrow.className = 'muted'
  arrow.textContent = '→'

  const dest = document.createElement('span')
  dest.className = 'small'
  dest.textContent = row.dest

  const size = document.createElement('span')
  size.className = 'muted small size'
  size.textContent = fmtGB(row.bytes)

  el.append(box, src, arrow, dest, size)
  return el
}

// ------------------------------------------------------------------ submit --

$('#submit-btn').addEventListener('click', async () => {
  const btn = $('#submit-btn')
  const err = $('#submit-error')
  err.hidden = true
  btn.disabled = true
  btn.textContent = 'Filing…'
  const { manifest } = currentPlan()
  try {
    const res = await state.api.call('uploadCreateShow', {
      submissionKey: state.submissionKey,
      month: state.show.month, year: state.show.year, city: state.show.city,
      folderName: state.show.folderName || undefined,
      // The preview's link wins when it sends one: a we.tl short link comes back expanded.
      source: state.link.source, link: state.preview.link || state.link.normalized,
      manifest,
    })
    localStorage.setItem(LAST_JOB, state.submissionKey)
    history.replaceState(null, '', `?job=${encodeURIComponent(state.submissionKey)}`)
    renderDone(res)
    step('step-done')
    renderCrumbs()
  } catch (e) {
    err.textContent = e.message
    err.hidden = false
  } finally {
    btn.disabled = false
    btn.textContent = 'Start the transfer ›'
  }
})

function renderDone(res) {
  const show = res.show || {}
  if (show.folderId) {
    const a = $('#show-folder-link')
    a.href = `https://drive.google.com/drive/folders/${show.folderId}`
    a.hidden = false
  }
  if (show.sheetUrl) {
    const a = $('#sheet-link')
    a.href = show.sheetUrl
    a.hidden = false
  }
  const body = $('#done-body')
  body.textContent = ''
  const lines = [
    res.duplicate
      ? 'This was already filed — nothing was created twice.'
      : `${show.created ? 'Created' : 'Found'} ${show.folderName}, with its tapes, photos, extras and completed_clips folders and a clip-request sheet.`,
    `${(res.manifest || []).length} files queued.`,
  ]
  if ((res.existing || []).length) {
    lines.push(`${res.existing.length} files are already in that folder and will be skipped if they match on size.`)
  }
  lines.push('The copy runs off this record — it does not need this tab open. '
    + 'Once tapes land in Drive, the nightly sync mirrors them to YouTube, '
    + 'so a show is usually reviewable the next morning rather than immediately.')
  for (const text of lines) {
    const p = document.createElement('p')
    p.textContent = text
    body.append(p)
  }
  const keep = document.createElement('p')
  keep.className = 'muted small'
  keep.textContent = `Reference: ${res.submissionId}`
  body.append(keep)
}

// ------------------------------------------------------------------ chrome --

function renderCrumbs() {
  const bits = ['Submit footage']
  if (state.show) bits.push(state.show.folderName || showLabel(state.show))
  if (state.preview) bits.push(`${state.rows.length} files`)
  const box = $('#crumbs')
  box.textContent = ''
  bits.forEach((text, i) => {
    if (i) {
      const sep = document.createElement('span')
      sep.className = 'muted'
      sep.textContent = ' / '
      box.append(sep)
    }
    const s = document.createElement('span')
    s.textContent = text
    box.append(s)
  })
}
