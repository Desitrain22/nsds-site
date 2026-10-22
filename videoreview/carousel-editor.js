// The carousel editor: a full-screen dialog over Tape Review, laid out as the agreed mockup (v3).
//
// What's being edited is a RECIPE, as with reels: the clip's lines (which words, what the caption
// says, where it sits), the still chosen for each and how it's framed, and one caption style. The
// slide you edit on IS the export's markup — carousel-slide.js slideHtml at its native 1080x1350,
// scaled down with a CSS transform — fed the draft's preview frames instead of 4K grabs. Nothing
// renders until Export; the runner then grabs each still from the master and renders the same markup.
//
// Pointer maths: the slide is scaled by k, so a pointer delta of d screen px is d / k slide px, and a
// slide px is a PANEL px (both are 1080 wide) — which is what panCrop and moveCap take.

import { FONTS, fontById, HEX_RE } from './reel.js'
import { formatTimePrecise } from './clips.js'
import {
  PANEL, CAROUSEL_LIMITS, CAROUSEL_DEFAULT_STYLE, DEFAULT_CAP, layout, splitLine, joinLines, deleteLine,
  panCrop, zoomCrop, moveCap, rankCandidates, stillFor, defaultStills, fillerWindow, isSoft, lineWindow,
} from './carousel.js'
import { slideHtml, imgBox } from './carousel-slide.js'

const $ = sel => document.querySelector(sel)
const BUSY = ['drafting', 'queued', 'rendering']
const POLL_MS = 5000
const DRAG_PX = 4          // a press becomes a drag only past this, so a double-click still reaches the caption
const FRAME_FETCHES = 4    // carouselFrame calls in flight at once; Apps Script is slow, not parallel
const THIRDS = ['top', 'middle', 'bottom']
const PLACEHOLDER = 'Double-click to add a caption'
const L = CAROUSEL_LIMITS

// Caption box / text pairs (box, fg).
const BOXES = [['#2E1A42', '#FFFFFF'], ['#000000', '#FFFFFF'], ['#FFFF82', '#2E1A42'], ['#FFFFC0', '#2E1A42']]

let ed = null // the one open editor

// The caption fonts for the <select>; the slide itself declares its own @font-face (slideHtml).
function installFonts() {
  if (document.getElementById('reel-fonts')) return
  const style = document.createElement('style')
  style.id = 'reel-fonts'
  style.textContent = FONTS.map(f =>
    `@font-face { font-family: 'Reel ${f.id}'; src: url('fonts/${f.file}') format('truetype'); font-display: block; }`).join('\n')
  document.head.append(style)
}

const fontsFor = style => ({ caption: `fonts/${fontById(style.font).file}`, bug: 'fonts/AzeretMono-Bold.ttf', icon: '../media/brand/Icon.svg' })
const norm = s => String(s || '').replace(/\s+/g, ' ').trim()
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/**
 * Open the editor for one clip request.
 * @param {{api, show, tape, clip?, row?, ranges, notes, granular, onClose?}} opts
 *   `clip` for a row the app wrote (has clipId); `row` for one typed into the sheet.
 */
export async function openCarouselEditor(opts) {
  installFonts()
  wireOnce()
  if (ed) close(true)
  ed = {
    ...opts,
    requestRanges: opts.ranges,
    draft: null,
    lines: [],
    fillers: [],
    style: { ...CAROUSEL_DEFAULT_STYLE },
    dirty: false,
    edits: 0,       // bumped by every change to the recipe: a save only clears `dirty` if none came after it
    saving: false,  // a save or export is in flight
    redrafting: false,
    keepFiller: new Set(), // filler indices whose still the person chose: a reflow never resets those
    cur: 0,         // the slide on show
    sel: 0,         // the selected panel, counted across all slides
    all: false,     // "Show all" candidates for the selected panel
    editing: null,  // { p, cap, span, before, ph } while a caption is being retyped
    drag: null,
    pointers: new Map(),
    poll: null,
  }
  $('#carousel-title').textContent = `Carousel — ${opts.tape.performer || opts.row?.name || 'clip'}`
  setBanner('')
  setMsg('')
  showPending(true)
  renderPending(null)
  $('#carousel').showModal()
  fit()
  setStatus('')
  await openDraft(false)
}

async function openDraft(redraft) {
  const mine = ed
  try {
    const { draft } = await mine.api.carouselOpen(mine.show, {
      clipId: mine.clip?.clipId || null,
      row: mine.row ? { name: mine.row.name, start: mine.row.start, end: mine.row.end, granular: mine.row.granular } : null,
      tape: { fileId: mine.tape.fileId, name: mine.tape.name, performer: mine.tape.performer, youtubeId: mine.tape.youtubeId || null },
      ranges: mine.requestRanges,
      notes: mine.notes,
      granular: mine.granular,
      redraft,
    })
    if (ed !== mine) return
    if (redraft) mine.dirty = false // only now: a re-draft that never started leaves the edits (and the warning)
    adopt(draft)
    if (draft.requestChanged) {
      setBanner('This request was changed after the draft was made. Re-draft to pick up the new times — your caption style is kept, lines and stills start over.')
    }
  } catch (err) {
    if (ed !== mine) return
    if (!mine.draft) renderPending(null, err.message)
    else if (!$('#carousel-pending').hidden) renderPending(mine.draft, err.message)
    else {
      // Re-draft from the editor: the pending screen isn't showing, so say it where it's seen.
      mine.redrafting = false
      syncStatus()
      setStatus(`Re-draft didn’t start: ${err.message}`, 'error')
      setBanner(`Re-draft didn’t start: ${err.message} Your draft is unchanged.`)
    }
  } finally {
    if (ed === mine && mine.redrafting) { mine.redrafting = false; if (mine.draft) syncStatus() }
  }
}

const copyStill = s => (s ? { t: s.t, crop: { cx: s.crop.cx, cy: s.crop.cy, h: s.crop.h }, ...(s.noFace ? { noFace: true } : {}) } : null)
const copyCap = c => ({ x: Number(c?.x ?? DEFAULT_CAP.x), y: Number(c?.y ?? DEFAULT_CAP.y) })
const blankFiller = () => ({ text: '', cap: { ...DEFAULT_CAP }, still: null })

function cleanStyle(st = {}) {
  const hex = (v, fallback) => (HEX_RE.test(String(v)) ? `#${String(v).replace('#', '').toUpperCase()}` : fallback)
  return {
    font: fontById(st.font || CAROUSEL_DEFAULT_STYLE.font).id,
    size: clamp(Number(st.size) || CAROUSEL_DEFAULT_STYLE.size, L.size[0], L.size[1]),
    box: hex(st.box, CAROUSEL_DEFAULT_STYLE.box),
    fg: hex(st.fg, CAROUSEL_DEFAULT_STYLE.fg),
  }
}

/** Take a draft from the server as the editor's state (only when nothing local is unsaved). */
function adopt(draft) {
  ed.draft = draft
  ed.frameAt = new Map((draft.frames || []).map(f => [f.t, f]))
  if (!ed.dirty) {
    ed.lines = (draft.lines || []).map(l => ({ w: [l.w[0], l.w[1]], text: String(l.text ?? ''), cap: copyCap(l.cap), still: copyStill(l.still) }))
    ed.fillers = (draft.fillers || []).map(f => ({ text: String(f.text ?? ''), cap: copyCap(f.cap), still: copyStill(f.still) }))
    ed.style = cleanStyle(draft.style)
    ed.keepFiller = new Set()
    fillStills()
  }
  renderAll()
  syncStatus()
}

// ------------------------------------------------------------------ model helpers --

const words = () => ed.draft?.words || []
const aspect = () => ed.draft.dims.w / ed.draft.dims.h
const placedLines = () => ed.lines.slice(0, L.maxPlaced)
const locked = () => !ed?.draft?.dims || !ed.draft.frames?.length || BUSY.includes(ed.draft.status)

/** Which line or filler panel p (counted across slides) is. */
function panelRef(p) {
  const placed = Math.min(ed.lines.length, L.maxPlaced)
  return p < placed
    ? { kind: 'line', i: p, obj: ed.lines[p] }
    : { kind: 'filler', i: p - placed, obj: ed.fillers[p - placed] || blankFiller() }
}

/** Replace panel p's fields. Never mutates a line, cap or still in place: splitLine shares caps. */
function setPanel(p, patch) {
  const r = panelRef(p)
  ed.edits++
  if (r.kind === 'line') {
    ed.lines = ed.lines.map((l, j) => (j === r.i ? { ...l, ...patch } : l))
  } else {
    const f = [...ed.fillers]
    while (f.length < r.i) f.push(blankFiller())
    f[r.i] = { ...r.obj, ...patch }
    ed.fillers = f
    // Only the person's own actions (a chosen candidate, a pan or zoom) set a filler's still this way.
    if ('still' in patch) ed.keepFiller.add(r.i)
  }
}

const nearestFrame = (frames, t) => frames.reduce((best, f) => (!best || Math.abs(f.t - t) < Math.abs(best.t - t) ? f : best), null)

/**
 * Give every placed line and every filler the layout uses a still if it has none, so Export never
 * meets an empty panel. Lines get defaultStills; fillers the best faces just after the last line (the
 * laugh), a different one each where there are enough.
 */
function fillStills() {
  const d = ed.draft
  if (!d?.dims || !d.frames?.length) return
  const placed = defaultStills(placedLines(), words(), d.frames, aspect(), d.dims.h)
  ed.lines = [...placed, ...ed.lines.slice(L.maxPlaced)]
  const { fillerCount } = layout(ed.lines, ed.fillers)
  if (!fillerCount) return
  const fillers = [...ed.fillers]
  for (let i = 0; i < fillerCount; i++) {
    const f = fillers[i] || blankFiller()
    fillers[i] = f.still ? f : { ...f, still: defaultFillerStill(i, placed) }
  }
  ed.fillers = fillers
}

/** The still filler i gets by default after these placed lines: the i-th best face of the laugh. */
function defaultFillerStill(i, placed) {
  const d = ed.draft
  const win = fillerWindow(words(), placed)
  const cands = rankCandidates(d.frames, win)
  const frame = cands[i] || cands[0] || nearestFrame(d.frames, win.s)
  return frame ? stillFor(frame, aspect(), d.dims.h) : null
}

const sameStill = (a, b) => !!a && !!b && a.t === b.t && ['cx', 'cy', 'h'].every(k => Math.abs(a.crop[k] - b.crop[k]) < 2e-4)

/**
 * Before a split / join / delete: which filler stills were picked automatically from the window after
 * the current last line (so they should follow it if it moves). A still the person chose — this session
 * (keepFiller), or one that isn't the automatic pick (e.g. a saved pan) — stays put.
 */
function fillerSnapshot() {
  if (!ed.draft?.dims || !ed.draft.frames?.length) return null
  const placed = placedLines()
  return {
    s: placed.length ? fillerWindow(words(), placed).s : null,
    auto: ed.fillers.map((f, i) => !ed.keepFiller.has(i) && sameStill(f.still, defaultFillerStill(i, placed))),
  }
}

/** The candidate frames for panel p: the best few in its window, or every face frame there ("Show all"). */
function candidatesFor(p) {
  const r = panelRef(p)
  const frames = ed.draft.frames || []
  const win = r.kind === 'line' ? lineWindow(words(), r.obj) : fillerWindow(words(), placedLines())
  const every = rankCandidates(frames, win, { spacing: 0, limit: Infinity }).sort((a, b) => a.t - b.t)
  let list = ed.all ? every : rankCandidates(frames, win)
  let faceless = false
  if (!list.length) {
    // No face anywhere in the window: offer what was sampled there, centre-cropped.
    faceless = true
    const inside = frames.filter(f => f.t >= win.s && f.t <= win.e)
    list = ed.all ? inside : inside.filter((_, i) => i % Math.max(1, Math.ceil(inside.length / 6)) === 0)
  }
  const cur = r.obj.still && ed.frameAt.get(r.obj.still.t)
  if (cur && !list.includes(cur)) list = [cur, ...list]
  return { list, more: !faceless && every.length > rankCandidates(frames, win).length, faceless, win }
}

// ------------------------------------------------------------------ frame images --
//
// Candidate stills come from the backend as base64 JPEGs, one call each, so they're cached by
// fileId for the life of the page and fetched only when on screen: the visible slide and the
// selected panel's strip. An <img data-file> gets its src the moment its frame arrives.

const images = new Map() // fileId -> { url } once fetched (a blob: URL); {} while queued or in flight; { failed }
const queue = []
let active = 0

/** The frame's URL if it's here; otherwise '' and (when `fetch`) ask for it — again, if it failed before. */
function imageUrl(fileId, fetch = true) {
  if (!fileId) return ''
  const hit = images.get(fileId)
  if (hit && !(hit.failed && fetch)) return hit.url || ''
  if (fetch) { images.set(fileId, {}); queue.push(fileId); pump() }
  return ''
}

const frameFailed = fileId => !!images.get(fileId)?.failed

/** Where a frame's "couldn't load" mark goes: the thumbnail, the candidate, or the slide's panel. */
const markHost = img => img.closest('.cz-thumb') || img.closest('.cz-cand') || img.closest('.cz-panel')

/** Mark (or clear) the host of `img`: broken while any frame it shows failed (a thumbnail shows three). */
function markBroken(img) {
  const host = markHost(img)
  host?.classList.toggle('cz-broken', [...host.querySelectorAll('img[data-file]')].some(i => frameFailed(i.dataset.file)))
}

function blobUrl(mime, data) {
  const bin = atob(data)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return URL.createObjectURL(new Blob([bytes], { type: mime || 'image/jpeg' }))
}

function pump() {
  while (active < FRAME_FETCHES && queue.length) {
    const fileId = queue.shift()
    const mine = ed
    if (!mine?.draft) { images.delete(fileId); continue }
    active++
    mine.api.carouselFrame(mine.draft.id, fileId)
      .then(({ mime, data }) => {
        if (ed !== mine) { images.delete(fileId); return } // closed meanwhile: its URLs were revoked
        const url = blobUrl(mime, data)
        images.set(fileId, { url })
        for (const img of document.querySelectorAll(`#carousel img[data-file="${fileId}"]`)) {
          img.src = url
          markBroken(img)
        }
      })
      .catch(() => {
        if (ed !== mine) { images.delete(fileId); return }
        // Marked where it shows; the next render of the slide or strip asks again.
        images.set(fileId, { failed: true })
        for (const img of document.querySelectorAll(`#carousel img[data-file="${fileId}"]`)) markBroken(img)
      })
      .finally(() => { active--; pump() })
  }
}

const fileOf = still => (still && ed.frameAt.get(still.t)?.fileId) || ''

// ------------------------------------------------------------------ status --

function syncStatus() {
  const d = ed.draft
  if (!d) return
  const busy = BUSY.includes(d.status)
  // Until there are stills the editor has nothing to edit: show "making your carousel" instead.
  const making = d.status === 'drafting' || !d.frames?.length || !d.dims
  showPending(making)
  if (making) renderPending(d)
  $('#carousel').dataset.status = d.status
  const last = (d.exports || [])[(d.exports || []).length - 1]
  const lines = {
    drafting: '',
    queued: 'Export queued…',
    rendering: 'Rendering the slides from the full-quality tape — a few minutes.',
    ready: making ? '' : 'Draft ready.',
    done: last ? `Exported v${last.version}.` : 'Exported.',
    failed: `Something went wrong: ${d.error || 'unknown error'}`,
  }
  setStatus(lines[d.status] ?? d.status, d.status === 'failed' ? 'error' : '')
  $('#carousel-redraft').hidden = making || busy || ed.redrafting || !(d.status === 'failed' || d.requestChanged || d.status === 'ready' || d.status === 'done')
  renderExports()
  renderControls()

  clearInterval(ed.poll)
  ed.poll = busy ? setInterval(poll, POLL_MS) : null
}

const STEPS = [
  ['tape', 'Pulling the tape', 'Reading the 4K original from Drive'],
  ['captions', 'Captions', 'Transcribing every word, with its timing'],
  ['stills', 'Stills', 'Finding the performer’s face in every frame, and the best one for each line'],
]
const STEP_ICON = { waiting: '○', running: '', done: '✓', failed: '✕' }

function showPending(on) {
  $('#carousel-pending').hidden = !on
  $('#carousel .cz-grid').hidden = on
}

/** The progress screen. `d` null = still asking the backend; `error` = that ask failed. */
function renderPending(d, error) {
  const p = d?.progress || {}
  const failed = error || (d && d.status === 'failed')
  $('#carousel-pending-title').textContent = failed ? 'That didn’t work' : d ? 'Making your carousel' : 'Opening…'
  const started = p.startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(p.startedAt)) / 60000)) : null
  $('#carousel-pending-lede').textContent = failed
    ? (error || d.error || 'Something went wrong.')
    : d
      ? `Come back in under 5 minutes — it keeps going if you close this.${started !== null ? ` Started ${started < 1 ? 'just now' : `${started} min ago`}.` : ''}`
      : ''
  const list = $('#carousel-steps')
  list.textContent = ''
  if (d && !error) {
    const queued = !p.tape || p.tape === 'waiting'
    STEPS.forEach(([key, label, sub]) => {
      const state = p[key] || 'waiting'
      const li = document.createElement('li')
      li.className = `step ${state}`
      const icon = document.createElement('span')
      icon.className = 'step-icon'
      icon.textContent = STEP_ICON[state]
      const text = document.createElement('span')
      text.className = 'step-text'
      const b = document.createElement('strong')
      b.textContent = label
      const small = document.createElement('small')
      small.textContent = key === 'tape' && queued && d.status === 'drafting' ? 'Waiting for a free runner' : sub
      text.append(b, small)
      li.append(icon, text)
      list.append(li)
    })
  }
  $('#carousel-pending-retry').hidden = !failed || !d
}

async function poll() {
  const mine = ed
  if (!mine?.draft || mine.editing || mine.drag) return
  try {
    const { draft } = await mine.api.carouselGet(mine.draft.id)
    // Never re-render under someone's caret or drag; the next tick will catch up.
    if (ed !== mine || mine.editing || mine.drag) return
    // A finished draft job brings lines; take them even though nothing local could be dirty yet.
    if (mine.draft.status === 'drafting' && draft.status !== 'drafting') ed.dirty = false
    if (draft.status !== mine.draft.status || draft.updatedAt !== mine.draft.updatedAt || draft.status === 'drafting') adopt(draft)
  } catch { /* keep polling; a blip is not a failure */ }
}

const softLabel = i => `slide ${Math.floor(i / 3) + 1} ${THIRDS[i % 3]}`

function renderExports() {
  const list = $('#cz-exports')
  list.textContent = ''
  const exports = ed.draft?.exports || []
  $('#cz-exports-panel').hidden = !exports.length
  for (const x of [...exports].reverse()) {
    const li = document.createElement('li')
    const a = document.createElement('a')
    a.href = x.url
    a.target = '_blank'
    a.rel = 'noopener'
    a.textContent = `${x.name} ↗`
    li.append(a)
    const note = document.createElement('span')
    note.className = 'muted small'
    note.textContent = (x.linked ? ' · linked in the sheet' : x.linkError ? ` · not linked in the sheet: ${x.linkError}` : '')
      + (x.soft?.length ? ` · soft (upscaled): ${x.soft.map(softLabel).join(', ')}` : '')
    li.append(note)
    list.append(li)
  }
}

// ------------------------------------------------------------------ rendering --

function renderAll() {
  const { slides } = layout(ed.lines, ed.fillers)
  const total = slides.length * 3
  ed.cur = clamp(ed.cur, 0, Math.max(0, slides.length - 1))
  ed.sel = total ? clamp(ed.sel, ed.cur * 3, ed.cur * 3 + 2) : 0
  renderSlide()
  renderThumbs()
  renderReserve()
  renderStyle()
  renderSide()
  renderControls()
}

/** slideHtml for slide si, with each panel's <img> tagged by the frame it shows. */
function slideMarkup(el, panels, fetch) {
  const images = panels.map(p => ({ src: imageUrl(fileOf(p.still), fetch), crop: p.still?.crop, aspect: ed.draft?.dims ? aspect() : 1 }))
  el.innerHTML = slideHtml(panels, ed.style, { images, fonts: fontsFor(ed.style) })
  el.querySelectorAll('.cz-panel').forEach((panel, i) => {
    const file = fileOf(panels[i].still)
    if (!file) return
    const img = panel.querySelector('img')
    img.dataset.file = file
    if (frameFailed(file)) markBroken(img)
  })
}

function badgesHtml(p) {
  const s = p.still
  const out = []
  if (!s) out.push('<span class="cz-badge missing">no still</span>')
  else {
    if (ed.draft?.dims && isSoft(s.crop, ed.draft.dims.h)) out.push('<span class="cz-badge" title="Fewer pixels than a sharp panel wants: it will be upscaled">soft</span>')
    if (s.noFace) out.push('<span class="cz-badge noface">no face</span>')
  }
  return out.join('')
}

function renderSlide() {
  const stage = $('#cz-stage')
  ed.editing = null
  const { slides } = layout(ed.lines, ed.fillers)
  const panels = slides[ed.cur] || []
  if (!panels.length) {
    stage.innerHTML = '<div class="cz-slide cz-none"><p>No lines left. Re-draft to start over.</p></div>'
    return
  }
  slideMarkup(stage, panels, true)
  stage.querySelectorAll('.cz-panel').forEach((el, i) => {
    const p = ed.cur * 3 + i
    el.dataset.p = String(p)
    el.classList.toggle('sel', p === ed.sel)
    if (!panels[i].text) {
      // No caption: the export has nothing here, the editor a stand-in to double-click.
      const cap = document.createElement('div')
      cap.className = 'cz-cap cz-ph'
      cap.style.left = `${panels[i].cap.x}%`
      cap.style.top = `${panels[i].cap.y}%`
      const span = document.createElement('span')
      span.textContent = PLACEHOLDER
      cap.append(span)
      el.append(cap)
    }
    const badges = document.createElement('div')
    badges.className = 'cz-badges'
    badges.innerHTML = badgesHtml(panels[i])
    el.append(badges)
  })
}

function renderThumbs() {
  const box = $('#cz-thumbs')
  box.textContent = ''
  const { slides } = layout(ed.lines, ed.fillers)
  if (slides.length < 2) return
  slides.forEach((panels, si) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'cz-thumb' + (si === ed.cur ? ' on' : '')
    b.title = `Slide ${si + 1}`
    const inner = document.createElement('div')
    inner.className = 'cz-scale'
    const n = document.createElement('b')
    n.textContent = String(si + 1)
    b.append(inner, n) // before the markup, so a failed frame marks this button (markHost)
    slideMarkup(inner, panels, false) // only frames already fetched: thumbnails never cost a call
    b.addEventListener('click', () => showSlide(si))
    box.append(b)
  })
}

function renderReserve() {
  const { reserve } = layout(ed.lines, ed.fillers)
  $('#cz-reserve-panel').hidden = !reserve.length
  if (!reserve.length) return
  const n = reserve.length
  $('#cz-reserve-note').textContent = `${n} more line${n === 1 ? '' : 's'} didn’t fit in ${L.maxPlaced / 3} slides — join or delete lines above to bring ${n === 1 ? 'it' : 'them'} in.`
  const list = $('#cz-reserve')
  list.textContent = ''
  list.start = L.maxPlaced + 1 // numbered as lines of the bit: 31, 32, ...
  for (const l of reserve) {
    const li = document.createElement('li')
    li.textContent = l.text
    list.append(li)
  }
}

function renderStyle() {
  const st = ed.style
  $('#cz-font').value = st.font
  $('#cz-size').value = String(st.size)
  for (const b of document.querySelectorAll('#cz-box button')) b.classList.toggle('on', b.dataset.box === st.box && b.dataset.fg === st.fg)
}

/** The stills strip and the line card's title, for the selected panel. */
function renderSide() {
  const film = $('#cz-film')
  film.textContent = ''
  const { slides } = layout(ed.lines, ed.fillers)
  if (!slides.length || !ed.draft?.dims) {
    $('#cz-stills-title').textContent = 'Stills'
    $('#cz-line-title').textContent = 'This third'
    $('#cz-all').hidden = true
    return
  }
  const p = ed.sel
  const r = panelRef(p)
  const filler = r.kind === 'filler'
  $('#cz-stills-title').textContent = `Stills for the ${THIRDS[p % 3]} third`
  $('#cz-line-title').textContent = filler ? 'Reaction still (no line of the bit)' : `Line ${r.i + 1} of ${ed.lines.length}`
  const { list, more, faceless, win } = candidatesFor(p)
  $('#cz-stills-note').textContent = faceless
    ? 'No face found in these seconds — these are centre crops of what was sampled.'
    : filler
      ? 'From the 3 seconds after the last line — the laugh. Framed on the face.'
      : 'Pulled from the seconds this line is spoken, framed on the face.'
  $('#cz-all').hidden = !more && !ed.all
  $('#cz-all').textContent = ed.all ? 'Show the best few' : 'Show all'
  if (!list.length) {
    const none = document.createElement('p')
    none.className = 'small muted'
    none.textContent = 'No frames were sampled here.'
    film.append(none)
    return
  }
  const cur = r.obj.still
  for (const f of list) {
    const on = cur && f.t === cur.t
    const crop = on ? cur.crop : stillFor(f, aspect(), ed.draft.dims.h).crop
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'cz-cand' + (on ? ' on' : '')
    b.title = on ? 'The current still — click to reset its framing' : 'Use this still'
    b.disabled = locked()
    const img = document.createElement('img')
    img.alt = ''
    img.dataset.file = f.fileId
    img.src = imageUrl(f.fileId)
    const box = imgBox(crop, aspect())
    Object.assign(img.style, { width: `${box.width}%`, left: `${box.left}%`, top: `${box.top}%` })
    const t = document.createElement('small')
    t.textContent = `+${Math.max(0, f.t - win.s).toFixed(1)}s`
    t.title = formatTimePrecise(f.t)
    b.append(img, t)
    b.addEventListener('click', () => {
      setPanel(p, { still: stillFor(f, aspect(), ed.draft.dims.h) })
      markDirty()
      renderSlide(); renderThumbs(); renderSide(); renderControls()
    })
    film.append(b)
  }
}

/** Every button's enabled state, from the selection, the caret and the draft's status. */
function renderControls() {
  if (!ed) return
  const lock = locked()
  const { slides } = layout(ed.lines, ed.fillers)
  const panels = slides.flat()
  const r = panels.length ? panelRef(ed.sel) : null
  const line = r?.kind === 'line'
  const join = line ? joinBlock(r.i) : 'Pick a line'
  $('#cz-split').disabled = lock || !splitPoint()
  $('#cz-join').disabled = lock || !!join
  $('#cz-join').title = join || 'Join this line with the next one'
  $('#cz-delete').disabled = lock || !line
  $('#cz-clear').disabled = lock || !r?.obj.text
  $('#cz-font').disabled = lock
  $('#cz-size').disabled = lock
  for (const b of document.querySelectorAll('#cz-box button')) b.disabled = lock
  $('#cz-all').disabled = false
  // One request at a time: a Save racing an Export would conflict with itself.
  $('#carousel-save').disabled = lock || ed.saving
  const n = slides.length
  const exp = $('#carousel-export')
  exp.textContent = `Export ${n} slide${n === 1 ? '' : 's'} →`
  exp.disabled = lock || ed.saving || !n || panels.some(x => !x.still)
}

/** Why line i can't be joined with the next, or '' when it can. */
function joinBlock(i) {
  const a = ed.lines[i]
  const b = ed.lines[i + 1]
  if (!b) return 'This is the last line'
  if (a.w[1] !== b.w[0]) return 'There’s a cut between these two lines'
  if ([a.text, b.text].filter(Boolean).join(' ').length > L.maxCaption) return `Together they’d be over ${L.maxCaption} characters`
  return ''
}

function showSlide(si) {
  if (ed.editing) commitEdit()
  ed.cur = si
  ed.sel = si * 3 + (ed.sel % 3)
  ed.all = false
  renderAll()
}

/** Select panel p on the visible slide without re-rendering it (a drag may be starting). */
function select(p) {
  if (p === ed.sel) return
  ed.sel = p
  ed.all = false
  for (const el of document.querySelectorAll('#cz-stage .cz-panel')) el.classList.toggle('sel', +el.dataset.p === p)
  renderSide()
  renderControls()
}

/** Refresh what a drag or zoom changes but leaves in place: badges, thumbnails, the strip. */
function afterGesture(el, p) {
  const badges = el?.querySelector('.cz-badges')
  if (badges) badges.innerHTML = badgesHtml(panelRef(p).obj)
  renderThumbs()
  renderSide()
}

// ------------------------------------------------------------------ editing on the slide --

function markDirty() {
  ed.edits++
  ed.dirty = true
  setMsg('Unsaved changes', 'muted')
}

const slideScale = () => $('#cz-stage').getBoundingClientRect().width / PANEL.w

function placeImg(el, crop) {
  const b = imgBox(crop, aspect())
  Object.assign(el.querySelector('img').style, { width: `${b.width}%`, left: `${b.left}%`, top: `${b.top}%` })
}

/**
 * moveCap, then keep the caption's whole box inside its panel: a wide caption near x = 10 or 90 would
 * otherwise hang off the side and be clipped (in the preview and the export alike).
 */
function capInside(cap, capEl) {
  const half = capEl.offsetWidth / 2 / PANEL.w * 100 // offsetWidth is layout px: unaffected by the scale
  const lo = Math.max(L.capX[0], half)
  const hi = Math.min(L.capX[1], 100 - half)
  const tall = Math.min(L.capY[1], Math.max(L.capY[0], capEl.offsetHeight / PANEL.h * 100))
  return { x: lo <= hi ? clamp(cap.x, lo, hi) : 50, y: clamp(cap.y, tall, L.capY[1]) }
}

/** After a restyle: pull the visible slide's captions back inside their panels at the new size. */
function reclampCaps() {
  for (const el of document.querySelectorAll('#cz-stage .cz-panel')) {
    const capEl = el.querySelector('.cz-cap:not(.cz-ph)')
    if (!capEl) continue
    const p = +el.dataset.p
    const cap = panelRef(p).obj.cap
    const next = capInside(cap, capEl)
    if (next.x === cap.x && next.y === cap.y) continue
    setPanel(p, { cap: next })
    capEl.style.left = `${next.x}%`
    capEl.style.top = `${next.y}%`
  }
}

function onDown(e) {
  const el = e.target.closest('.cz-panel')
  if (!el || !ed) return
  if (e.target.closest('.cz-cap.editing')) return // placing the caret
  if (ed.editing) commitEdit()
  const p = +el.dataset.p
  if (el.classList.contains('cz-broken')) imageUrl(el.querySelector('img')?.dataset.file) // ask for it again
  select(p)
  if (locked() || (e.pointerType === 'mouse' && e.button !== 0)) return
  if (e.isPrimary) ed.pointers.clear() // a first finger (or the mouse) starts a fresh gesture
  ed.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  const r = panelRef(p)
  if (ed.pointers.size === 2 && r.obj.still) {
    // Two fingers: pinch to zoom the photo about their midpoint.
    const [a, b] = [...ed.pointers.values()]
    ed.drag = { pinch: true, p, el, crop: r.obj.still.crop, d0: Math.hypot(a.x - b.x, a.y - b.y) || 1 }
    for (const id of ed.pointers.keys()) el.setPointerCapture?.(id)
    return
  }
  const cap = e.target.closest('.cz-cap')
  ed.drag = {
    p, el, id: e.pointerId, x: e.clientX, y: e.clientY, k: slideScale(), moved: false,
    cap: cap ? { el: cap, start: r.obj.cap } : null,
    crop: r.obj.still?.crop || null,
  }
}

function onMove(e) {
  const d = ed?.drag
  if (!d) return
  if (ed.pointers.has(e.pointerId)) ed.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (d.pinch) {
    if (ed.pointers.size < 2) return
    const [a, b] = [...ed.pointers.values()]
    const rect = d.el.getBoundingClientRect()
    const px = clamp(((a.x + b.x) / 2 - rect.left) / rect.width, 0, 1)
    const py = clamp(((a.y + b.y) / 2 - rect.top) / rect.height, 0, 1)
    const crop = zoomCrop(d.crop, Math.hypot(a.x - b.x, a.y - b.y) / d.d0, px, py, aspect())
    setPanel(d.p, { still: { ...panelRef(d.p).obj.still, crop } })
    placeImg(d.el, crop)
    d.moved = true
    return
  }
  if (e.pointerId !== d.id) return
  if (!d.moved) {
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_PX) return
    d.moved = true
    d.el.setPointerCapture(d.id)
    d.el.classList.add('dragging')
  }
  const dx = (e.clientX - d.x) / d.k
  const dy = (e.clientY - d.y) / d.k
  if (d.cap) {
    const cap = capInside(moveCap(d.cap.start, dx, dy), d.cap.el)
    setPanel(d.p, { cap })
    d.cap.el.style.left = `${cap.x}%`
    d.cap.el.style.top = `${cap.y}%`
  } else if (d.crop) {
    const crop = panCrop(d.crop, dx, dy, aspect())
    setPanel(d.p, { still: { ...panelRef(d.p).obj.still, crop } })
    placeImg(d.el, crop)
  }
}

function onUp(e) {
  if (!ed) return
  ed.pointers.delete(e.pointerId)
  const d = ed.drag
  if (!d || (!d.pinch && e.pointerId !== d.id)) return
  if (d.pinch && ed.pointers.size) return // the last finger ends the pinch
  ed.drag = null
  d.el.classList.remove('dragging')
  if (d.moved) { markDirty(); afterGesture(d.el, d.p) }
}

let wheelTimer = null
function onWheel(e) {
  const el = e.target.closest('.cz-panel')
  if (!el || !ed || locked() || e.target.closest('.cz-cap')) return
  const p = +el.dataset.p
  const still = panelRef(p).obj.still
  if (!still) return
  e.preventDefault()
  select(p)
  // A trackpad pinch arrives as a ctrl+wheel with small deltas; a mouse wheel as big ones.
  const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))
  const rect = el.getBoundingClientRect()
  const crop = zoomCrop(still.crop, factor, (e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height, aspect())
  setPanel(p, { still: { ...still, crop } })
  placeImg(el, crop)
  markDirty()
  clearTimeout(wheelTimer)
  wheelTimer = setTimeout(() => { if (ed) afterGesture(el, p) }, 250)
}

function onDblClick(e) {
  const cap = e.target.closest('.cz-cap')
  if (!cap || !ed || locked() || cap.classList.contains('editing')) return
  const p = +cap.closest('.cz-panel').dataset.p
  const span = cap.querySelector('span')
  ed.editing = { p, cap, span, before: panelRef(p).obj.text, ph: cap.classList.contains('cz-ph') }
  cap.classList.add('editing')
  span.contentEditable = 'plaintext-only'
  span.focus()
  getSelection().selectAllChildren(span) // a placeholder is selected, so typing replaces it
  renderControls()
}

/** Finish retyping a caption: keep the text (or put it back, on Escape), in place. */
function commitEdit(revert = false) {
  const e = ed?.editing
  if (!e) return
  ed.editing = null
  const { p, cap, span } = e
  span.contentEditable = 'false'
  cap.classList.remove('editing')
  let text = revert ? e.before : norm(span.textContent)
  if (e.ph && text === PLACEHOLDER) text = ''
  text = text.slice(0, L.maxCaption)
  if (text !== e.before) { setPanel(p, { text }); markDirty() }
  // Rewritten in place, not re-rendered: a drag may be starting on this very panel.
  span.textContent = text || PLACEHOLDER
  cap.classList.toggle('cz-ph', !text)
  getSelection()?.removeAllRanges()
  renderThumbs()
  renderControls()
}

/**
 * Where Split would cut the caption being edited: { text, at } with `at` a word boundary in the
 * normalised text, or null when the caret isn't in a line's caption or sits at either end (splitLine
 * would make an empty half).
 */
function splitPoint() {
  const e = ed?.editing
  if (!e) return null
  const r = panelRef(e.p)
  if (r.kind !== 'line' || r.obj.w[1] - r.obj.w[0] < 2) return null
  const sel = getSelection()
  if (!sel?.rangeCount || !e.span.contains(sel.focusNode)) return null
  const text = norm(e.span.textContent)
  if (e.ph && text === PLACEHOLDER) return null
  const range = document.createRange()
  range.selectNodeContents(e.span)
  range.setEnd(sel.focusNode, sel.focusOffset)
  let at = norm(range.toString()).length
  if (!at) return null
  while (at < text.length && text[at] !== ' ') at++ // mid-word: cut after the word
  return at < text.length ? { text, at } : null
}

// ------------------------------------------------------------------ line controls --

/** After a split / join / delete: give new lines stills, reflow three to a slide, select panel p. */
function reflow(p, snap) {
  // The last placed line moved: automatic filler stills follow the new laugh window.
  const placed = placedLines()
  if (snap && (placed.length ? fillerWindow(words(), placed).s : null) !== snap.s) {
    ed.fillers = ed.fillers.map((f, i) => (snap.auto[i] ? { ...f, still: null } : f))
  }
  fillStills()
  ed.sel = Math.max(0, p)
  ed.cur = Math.floor(ed.sel / 3)
  ed.all = false
  markDirty()
  renderAll()
}

function doSplit() {
  const sp = splitPoint()
  if (!sp) return
  const { p } = ed.editing
  const i = panelRef(p).i
  commitEdit()
  const snap = fillerSnapshot()
  const out = splitLine(ed.lines, words(), i, sp.at)
  // splitLine hands the first half the original cap object; give both halves their own.
  ed.lines = out.map((l, j) => (j === i || j === i + 1 ? { ...l, cap: { ...l.cap } } : l))
  reflow(p + 1, snap)
}

function doJoin() {
  const r = panelRef(ed.sel)
  if (r.kind !== 'line' || joinBlock(r.i)) return
  const a = ed.lines[r.i]
  const b = ed.lines[r.i + 1]
  const snap = fillerSnapshot()
  const out = joinLines(ed.lines, words(), r.i)
  // joinLines puts a space between the two texts even when one is empty; and the cap is a's object.
  ed.lines = out.map((l, j) => (j === r.i ? { ...l, text: [a.text, b.text].filter(Boolean).join(' '), cap: { ...a.cap } } : l))
  reflow(ed.sel, snap)
}

function doDelete() {
  const r = panelRef(ed.sel)
  if (r.kind !== 'line') return
  const snap = fillerSnapshot()
  ed.lines = deleteLine(ed.lines, r.i)
  reflow(Math.min(ed.sel, Math.max(0, ed.lines.length - 1)), snap)
}

function doClear() {
  setPanel(ed.sel, { text: '' })
  markDirty()
  renderAll()
}

// ------------------------------------------------------------------ save / export --

function edit() {
  const still = copyStill
  const cap = c => ({ x: c.x, y: c.y })
  return {
    lines: ed.lines.map(l => ({ w: [l.w[0], l.w[1]], text: l.text, cap: cap(l.cap), still: still(l.still) })),
    fillers: ed.fillers.slice(0, L.maxFillers).map(f => ({ text: f.text, cap: cap(f.cap), still: still(f.still) })),
    style: { font: ed.style.font, size: ed.style.size, box: ed.style.box, fg: ed.style.fg },
  }
}

/**
 * Save (or save and export). The editor stays live while the request is out, so it notes how many edits
 * it sent: if more came in meanwhile, the response's rev is taken but the recipe on screen is kept, and
 * still unsaved — adopting the server's copy would quietly revert them.
 */
async function save(render) {
  const mine = ed
  if (!mine.draft || mine.saving) return
  if (mine.editing) commitEdit()
  const sent = mine.edits
  mine.saving = true
  renderControls()
  setMsg(render ? 'Starting the export…' : 'Saving…', 'muted')
  try {
    const call = render ? mine.api.renderCarousel.bind(mine.api) : mine.api.carouselSave.bind(mine.api)
    const res = await call(mine.draft.id, mine.draft.rev, edit())
    if (ed !== mine) return
    const later = mine.edits !== sent
    mine.dirty = later // a change since (even a drag still under way) keeps the screen's recipe
    if (res.draft) adopt(res.draft) // keeps the local recipe while dirty, takes rev/status/exports
    else { mine.draft.rev = res.rev; if (render) mine.draft.status = 'queued' }
    if (later) setMsg(render ? 'Export started with what you had when you pressed it — changes since are kept here, unsaved.' : 'Saved — but you changed things since; those aren’t saved yet.', 'muted')
    else setMsg(render ? 'Export started.' : 'Saved.', 'muted')
  } catch (err) {
    if (ed !== mine) return
    if (err.data?.conflict) {
      // Not necessarily someone else (another tab, or a save whose answer got lost): don't say what was lost.
      setBanner('This carousel was saved from somewhere else meanwhile, so this save was refused. Your changes are still here, unsaved. To see the saved version, close and reopen it — reopening drops what’s on screen.')
      setMsg('Not saved.', 'error')
    } else if (err.data && err.data.rev !== undefined) {
      // Saved, but the export never started (GitHub refused the job): take the new rev and the
      // failed status, or the next save would be refused as a conflict with this one.
      mine.dirty = mine.edits !== sent
      if (err.data.draft) adopt(err.data.draft)
      else mine.draft.rev = err.data.rev
      setMsg(`Saved, but the export didn’t start: ${err.message}`, 'error')
    } else setMsg(err.message, 'error')
  } finally {
    if (ed === mine) { mine.saving = false; syncStatus() }
  }
}

// ------------------------------------------------------------------ chrome --

function setStatus(text, tone = '') {
  const el = $('#carousel-status')
  el.textContent = text
  el.className = `small ${tone || 'muted'}`
}

function setMsg(text, tone = '') {
  const el = $('#carousel-msg')
  el.textContent = text
  el.className = `small ${tone}`
}

function setBanner(text) {
  $('#carousel-banner').hidden = !text
  $('#carousel-banner').textContent = text
}

/** Size the slide to the dialog: k is the slide's on-screen scale (≈ 0.4). */
function fit() {
  const dlg = $('#carousel')
  const byH = (dlg.clientHeight - 210) / 1350
  const byW = (Math.min(innerWidth, dlg.clientWidth || innerWidth) - 40) / 1080
  const k = clamp(innerWidth <= 860 ? byW : Math.min(byH, byW), 0.22, 0.42)
  dlg.style.setProperty('--k', k.toFixed(4))
}

function close(force = false) {
  if (!ed) return
  if (ed.editing) commitEdit()
  if (!force && ed.dirty && !confirm('Close without saving your changes to this carousel?')) return
  clearInterval(ed.poll)
  // The frames belong to this draft: forget them (and free their blob: URLs); a reopen asks again.
  queue.length = 0
  for (const { url } of images.values()) if (url) URL.revokeObjectURL(url)
  images.clear()
  const done = ed.onClose
  ed = null
  if ($('#carousel').open) $('#carousel').close()
  done?.()
}

let wired = false
function wireOnce() {
  if (wired) return
  wired = true

  const fontSel = $('#cz-font')
  for (const f of FONTS) {
    const o = document.createElement('option')
    o.value = f.id
    o.textContent = f.label
    o.style.fontFamily = `'Reel ${f.id}'`
    fontSel.append(o)
  }
  const restyle = patch => {
    ed.style = { ...ed.style, ...patch }
    markDirty(); renderStyle(); renderSlide(); reclampCaps(); renderThumbs(); renderControls()
    // A new face measures differently once it has loaded: clamp again then.
    document.fonts?.load(`800 ${ed.style.size}px 'cz-cap'`).then(() => { if (ed && !ed.drag && !ed.editing) { reclampCaps(); renderThumbs() } }, () => {})
  }
  fontSel.addEventListener('change', () => restyle({ font: fontById(fontSel.value).id }))
  const size = $('#cz-size')
  size.min = String(L.size[0])
  size.max = String(L.size[1])
  size.addEventListener('input', () => restyle({ size: +size.value }))
  for (const [box, fg] of BOXES) {
    const b = document.createElement('button')
    b.type = 'button'
    b.dataset.box = box
    b.dataset.fg = fg
    b.dataset.edit = ''
    b.style.background = box
    b.style.setProperty('--fg', fg)
    b.title = `${box} box, ${fg} text`
    b.addEventListener('click', () => restyle({ box, fg }))
    $('#cz-box').append(b)
  }

  const stage = $('#cz-stage')
  stage.addEventListener('pointerdown', onDown)
  stage.addEventListener('pointermove', onMove)
  // Releases are heard on the window: a press that never became a drag isn't captured, and one let go
  // outside the slide must still end, or the next hover would drag with no button held.
  addEventListener('pointerup', onUp)
  addEventListener('pointercancel', onUp)
  stage.addEventListener('wheel', onWheel, { passive: false })
  stage.addEventListener('dblclick', onDblClick)
  stage.addEventListener('keydown', e => {
    if (!ed?.editing) return
    if (e.key === 'Enter') { e.preventDefault(); commitEdit() }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); commitEdit(true) }
  })
  stage.addEventListener('focusout', e => { if (ed?.editing && e.target === ed.editing.span) commitEdit() })
  document.addEventListener('selectionchange', () => { if (ed?.editing) renderControls() })

  // Split works on the caret, so pressing it must not take focus from the caption being edited.
  $('#cz-split').addEventListener('mousedown', e => e.preventDefault())
  $('#cz-split').addEventListener('click', doSplit)
  $('#cz-join').addEventListener('click', doJoin)
  $('#cz-delete').addEventListener('click', doDelete)
  $('#cz-clear').addEventListener('click', doClear)
  $('#cz-all').addEventListener('click', () => { ed.all = !ed.all; renderSide() })

  $('#carousel-save').addEventListener('click', () => save(false))
  $('#carousel-export').addEventListener('click', () => save(true))
  $('#carousel-redraft').addEventListener('click', () => {
    if (ed.lines.length && !confirm('Re-draft from the request? Lines, captions and stills start over; your caption style is kept.')) return
    ed.redrafting = true
    $('#carousel-redraft').hidden = true
    setBanner('')
    setStatus('Starting a new draft…')
    openDraft(true)
  })
  $('#carousel-close').addEventListener('click', () => close())
  $('#carousel-pending-retry').addEventListener('click', () => {
    setBanner('')
    renderPending(null)
    openDraft(true)
  })
  $('#carousel').addEventListener('cancel', e => { e.preventDefault(); if (ed?.editing) commitEdit(true); else close() })
  addEventListener('resize', () => { if (ed) fit() })
}

/** Exposed for scratch harnesses and the dev server's selftest. */
export const _carouselState = () => ed
