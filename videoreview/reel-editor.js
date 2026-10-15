// The reel editor: a full-screen dialog over Tape Review, laid out as the agreed mockup.
//
// What's being edited is a RECIPE, not a video (see videoreview/README.md, "Reels"): the clip's
// ranges, the word-timed transcript, where the caption breaks fall, and the style. The preview is
// the YouTube viewing copy cropped to 9:16 by CSS with captions painted on top from the same
// captionSlices() the export burns in, so nothing renders until Export — and the export runs on
// GitHub Actions against the 4K master in Drive.

import { Player } from './player.js'
import { formatTimePrecise, parseTime } from './clips.js'
import {
  FONTS, fontById, DEFAULT_STYLE, LIMITS, clampStyle, captionSlices, captionAt, wordsInRanges,
  totalLength, toTapeTime, toOutputTime, strokeFor, cropAt,
} from './reel.js'

const $ = sel => document.querySelector(sel)
const BUSY = ['drafting', 'queued', 'rendering']
const POLL_MS = 5000
const GAP_HINT = 0.5

const TEXT_SWATCHES = ['#FFFFFF', '#FFFF82', '#DDEFD1']
const HIGHLIGHT_SWATCHES = ['#FFFF82', '#7EE0FF']

let ed = null // the one open editor

// The fonts come from the same files libass uses on the runner.
function installFonts() {
  if (document.getElementById('reel-fonts')) return
  const style = document.createElement('style')
  style.id = 'reel-fonts'
  style.textContent = FONTS.map(f =>
    `@font-face { font-family: 'Reel ${f.id}'; src: url('fonts/${f.file}') format('truetype'); font-display: block; }`).join('\n')
  document.head.append(style)
}

/**
 * Open the editor for one clip request.
 * @param {{api, show, tape, clip?, row?, ranges, notes, granular, onClose?}} opts
 *   `clip` for a row the app wrote (has clipId); `row` for one typed into the sheet.
 */
export async function openReelEditor(opts) {
  installFonts()
  wireOnce()
  if (ed) close(true)
  ed = {
    ...opts,
    requestRanges: opts.ranges, // the request as it stands now; `ranges` below is what's being edited
    draft: null,
    words: [],
    breaks: new Set(),
    style: { ...DEFAULT_STYLE },
    ranges: [],
    dirty: false,
    t: 0,
    playing: false,
    poll: null,
    player: null,
    playerReady: false,
  }
  $('#reel-title').textContent = `Reel — ${opts.tape.performer || opts.row?.name || 'clip'}`
  setBanner('')
  setMsg('')
  renderAll()
  $('#reel').showModal()
  setStatus('Opening draft…')
  await openDraft(false)
}

async function openDraft(redraft) {
  const mine = ed
  try {
    const { draft } = await mine.api.reelOpen(mine.show, {
      clipId: mine.clip?.clipId || null,
      row: mine.row ? { name: mine.row.name, start: mine.row.start, end: mine.row.end, granular: mine.row.granular } : null,
      tape: { fileId: mine.tape.fileId, name: mine.tape.name, performer: mine.tape.performer, youtubeId: mine.tape.youtubeId || null },
      ranges: mine.requestRanges,
      notes: mine.notes,
      granular: mine.granular,
      redraft,
    })
    if (ed !== mine) return
    adopt(draft)
    if (draft.requestChanged) {
      setBanner('This request was changed after the draft was made. Re-draft to pick up the new times — your style is kept, caption breaks and word fixes start over.')
    }
    loadPreview()
  } catch (err) {
    if (ed !== mine) return
    setStatus('')
    setMsg(err.message, 'error')
  }
}

/** Take a draft from the server as the editor's state (only when nothing local is unsaved). */
function adopt(draft) {
  ed.draft = draft
  if (!ed.dirty) {
    ed.words = (draft.words || []).map(w => ({ ...w }))
    ed.breaks = new Set(draft.breaks || [])
    ed.style = clampStyle(draft.style || {})
    ed.ranges = (draft.ranges || []).map(r => ({ ...r }))
  }
  renderAll()
  syncStatus()
}

// ------------------------------------------------------------------ status --

function syncStatus() {
  const d = ed.draft
  if (!d) return
  const busy = BUSY.includes(d.status)
  $('#reel').dataset.status = d.status
  const last = (d.exports || [])[(d.exports || []).length - 1]
  const lines = {
    drafting: 'Transcribing the clip — usually 3–6 minutes. You can close this and come back.',
    queued: 'Export queued…',
    rendering: 'Exporting from the full-quality tape — a few minutes.',
    ready: d.words?.length ? 'Draft ready.' : '',
    done: last ? `Exported v${last.version}.` : 'Exported.',
    failed: `Something went wrong: ${d.error || 'unknown error'}`,
  }
  setStatus(lines[d.status] || d.status, d.status === 'failed' ? 'error' : '')
  $('#reel-redraft').hidden = !(d.status === 'failed' || d.requestChanged || d.status === 'ready' || d.status === 'done')
  $('#reel-redraft').textContent = d.words?.length ? 'Re-draft' : 'Try again'
  for (const el of document.querySelectorAll('#reel [data-edit]')) el.disabled = busy || !d.words?.length
  renderExports()

  clearInterval(ed.poll)
  ed.poll = busy ? setInterval(poll, POLL_MS) : null
}

async function poll() {
  const mine = ed
  if (!mine?.draft) return
  try {
    const { draft } = await mine.api.reelGet(mine.draft.id)
    if (ed !== mine) return
    const wasBusy = BUSY.includes(mine.draft.status)
    // A finished draft job brings words; take them even though nothing local could be dirty yet.
    if (wasBusy && mine.draft.status === 'drafting' && draft.status !== 'drafting') ed.dirty = false
    if (draft.status !== mine.draft.status || draft.updatedAt !== mine.draft.updatedAt) adopt(draft)
  } catch { /* keep polling; a blip is not a failure */ }
}

function renderExports() {
  const list = $('#reel-exports')
  list.textContent = ''
  const exports = ed.draft?.exports || []
  $('#reel-exports-panel').hidden = !exports.length
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
    note.textContent = x.linked ? ' · linked in the sheet' : x.linkError ? ` · not linked in the sheet: ${x.linkError}` : ''
    li.append(note)
    list.append(li)
  }
}

// ------------------------------------------------------------------ preview --

async function loadPreview() {
  const mine = ed
  const frame = $('#reel-phone')
  if (!mine.tape.youtubeId) {
    frame.dataset.state = 'empty'
    $('#reel-frame-note').textContent = 'This tape isn’t on YouTube yet, so there’s no preview — Export still works from the original.'
    return
  }
  frame.dataset.state = 'loading'
  $('#reel-frame-note').textContent = 'Loading preview…'
  try {
    if (!mine.player) mine.player = sharedPlayer()
    await mine.player.load(mine.tape.youtubeId)
    if (ed !== mine) return
    mine.playerReady = true
    frame.dataset.state = 'ready'
    seekOutput(0)
  } catch (err) {
    if (ed !== mine) return
    frame.dataset.state = 'empty'
    $('#reel-frame-note').textContent = err.message
  }
}

// One player for the life of the page: the IFrame API replaces its mount element, so it can't be
// rebuilt cleanly each time the dialog opens.
let player = null
function sharedPlayer() {
  if (!player) player = new Player($('#reel-player-mount'), { controls: 0 })
  return player
}

function slices() {
  return captionSlices(ed.words, [...ed.breaks], wordsInRanges(ed.words, ed.ranges))
}

/** Paint the caption for tape time t. */
function paint(t = ed.t) {
  ed.t = t
  const st = ed.style
  const font = fontById(st.font)
  const cap = $('#reel-cap')
  cap.style.fontFamily = `'Reel ${font.id}'`
  cap.style.fontSize = `${st.size}px`
  cap.style.top = `${st.y}%`
  cap.style.webkitTextStrokeWidth = `${strokeFor(st.size)}px`
  cap.style.webkitTextStrokeColor = st.outline
  const track = ed.draft?.track
  $('#reel-phone').style.setProperty('--crop', st.follow && track?.length ? cropAt(track, t, st.crop) : st.crop)

  cap.textContent = ''
  const sl = captionAt(slices(), t)
  if (sl) {
    sl.words.forEach((i, k) => {
      const span = document.createElement('span')
      span.textContent = ed.words[i].text
      span.style.color = st.highlight && i === sl.active ? st.highlight : st.fill
      cap.append(span)
      if (k < sl.words.length - 1) cap.append(' ')
    })
  }
  for (const el of document.querySelectorAll('#reel-tx .w')) {
    const w = ed.words[+el.dataset.i]
    el.classList.toggle('now', t >= w.s && t < w.e + 0.02)
  }
  const total = totalLength(ed.ranges)
  const o = toOutputTime(t, ed.ranges)
  $('#reel-clock').textContent = `${formatTimePrecise(o)} / ${formatTimePrecise(total)}`
  const scrub = $('#reel-scrub')
  scrub.max = String(total)
  if (!ed.scrubbing) scrub.value = String(o)
}

function seekOutput(o) {
  const t = toTapeTime(o, ed.ranges)
  paint(t)
  if (ed.playerReady) ed.player.seek(t).catch(() => {})
}

async function togglePlay() {
  if (!ed.playerReady) return
  if (ed.playing) {
    ed.playing = false
    ed.player.cancel()
    await ed.player.pause()
    $('#reel-play').textContent = '▶ Play'
    return
  }
  ed.playing = true
  $('#reel-play').textContent = '❚❚ Pause'
  // Play from the current point: the remaining part of the range we're in, then the rest.
  const sorted = [...ed.ranges].sort((a, b) => a.s - b.s)
  const rest = sorted
    .map(r => (ed.t >= r.s && ed.t < r.e - 0.05 ? { s: ed.t, e: r.e } : r))
    .filter(r => r.s >= ed.t - 0.001 || (ed.t >= r.s && ed.t < r.e))
  const queue = rest.length ? rest : sorted
  await ed.player.playRanges(queue, { onProgress: at => paint(at) })
  if (!ed) return
  ed.playing = false
  $('#reel-play').textContent = '▶ Play'
}

// ------------------------------------------------------------------ editing --

function markDirty() {
  ed.dirty = true
  setMsg('Unsaved changes', 'muted')
}

function renderAll() {
  renderTranscript()
  renderStyle()
  renderRanges()
  const notes = [ed.granular, ed.notes].filter(s => String(s || '').trim())
  $('#reel-notes-panel').hidden = !notes.length
  $('#reel-notes').textContent = notes.join('\n')
  paint()
}

function renderTranscript() {
  const tx = $('#reel-tx')
  tx.textContent = ''
  if (!ed.words.length) {
    const p = document.createElement('p')
    p.className = 'muted small'
    p.textContent = ed.draft?.status === 'drafting' ? 'Transcribing…' : 'No transcript yet.'
    tx.append(p)
    return
  }
  const keep = wordsInRanges(ed.words, ed.ranges)
  ed.words.forEach((w, i) => {
    if (i > 0) {
      const gap = w.s - ed.words[i - 1].e
      if (gap >= GAP_HINT) {
        const g = document.createElement('span')
        g.className = 'gap'
        g.textContent = `${gap.toFixed(1)}s`
        tx.append(g)
      }
      const seam = document.createElement('button')
      seam.type = 'button'
      seam.className = 'seam' + (ed.breaks.has(i) ? ' brk' : '')
      seam.title = ed.breaks.has(i) ? 'Remove this caption break' : 'Break the caption here'
      seam.setAttribute('aria-label', seam.title)
      seam.dataset.edit = ''
      seam.addEventListener('click', () => {
        ed.breaks.has(i) ? ed.breaks.delete(i) : ed.breaks.add(i)
        markDirty()
        renderTranscript()
        paint()
      })
      tx.append(seam)
    }
    const el = document.createElement('span')
    el.className = 'w' + (keep[i] ? '' : ' out') + (w.aligned === false ? ' est' : '')
    el.dataset.i = String(i)
    el.textContent = w.text
    el.title = w.aligned === false ? 'Timing estimated (WhisperX couldn’t place this word)' : ''
    el.addEventListener('click', () => {
      if (el.isContentEditable) return
      paint(w.s)
      if (ed.playerReady && !ed.playing) ed.player.seek(w.s).catch(() => {})
    })
    el.addEventListener('dblclick', () => {
      if (BUSY.includes(ed.draft?.status)) return
      el.contentEditable = 'true'
      el.focus()
      document.getSelection().selectAllChildren(el)
    })
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); el.blur() }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); el.textContent = w.text; el.blur() }
    })
    el.addEventListener('blur', () => {
      if (!el.isContentEditable) return
      el.contentEditable = 'false'
      const text = el.textContent.replace(/\s+/g, ' ').trim().slice(0, LIMITS.maxWordLen)
      if (text && text !== w.text) { w.text = text; markDirty() }
      el.textContent = w.text
      paint()
    })
    tx.append(el)
  })
}

function renderStyle() {
  const st = ed.style
  $('#reel-font').value = st.font
  $('#reel-size').value = String(st.size)
  $('#reel-y').value = String(st.y)
  $('#reel-crop').value = String(st.crop)
  const tracked = !!ed.draft?.track?.length
  $('#reel-follow').checked = st.follow && tracked
  $('#reel-follow').closest('label').hidden = !tracked
  $('#reel-crop').closest('label').classList.toggle('dim', st.follow && tracked)
  $('#reel-fill-custom').value = st.fill.toLowerCase()
  if (st.highlight) $('#reel-hl-custom').value = st.highlight.toLowerCase()
  for (const b of document.querySelectorAll('#reel-fill button')) b.classList.toggle('on', b.dataset.c === st.fill)
  for (const b of document.querySelectorAll('#reel-hl button')) b.classList.toggle('on', (b.dataset.c || null) === st.highlight)
}

function renderRanges() {
  const box = $('#reel-ranges')
  box.textContent = ''
  const span = ed.draft?.source?.span
  ed.ranges.forEach((r, i) => {
    const row = document.createElement('div')
    row.className = 'trim'
    const label = document.createElement('span')
    label.className = 'muted small'
    label.textContent = ed.ranges.length > 1 ? `Part ${i + 1}` : 'Clip'
    row.append(label)
    for (const key of ['s', 'e']) {
      const input = document.createElement('input')
      input.type = 'text'
      input.inputMode = 'decimal'
      input.value = formatTimePrecise(r[key])
      input.dataset.edit = ''
      input.addEventListener('change', () => {
        const v = parseTime(input.value)
        const lo = span ? span.s - LIMITS.trimSlack : 0
        const hi = span ? span.e + LIMITS.trimSlack : Infinity
        const other = key === 's' ? r.e : r.s
        const okay = v !== null && v >= lo && v <= hi && (key === 's' ? v < other : v > other)
        if (!okay) {
          input.value = formatTimePrecise(r[key])
          setMsg(`Trims can reach at most ${LIMITS.trimSlack}s past the request, and a part must end after it starts.`, 'error')
          return
        }
        r[key] = v
        markDirty()
        renderTranscript()
        paint()
      })
      row.append(input)
      if (key === 's') {
        const arrow = document.createElement('span')
        arrow.className = 'muted'
        arrow.textContent = '→'
        row.append(arrow)
      }
    }
    box.append(row)
  })
}

function edit() {
  const st = ed.style
  return {
    breaks: [...ed.breaks].sort((a, b) => a - b),
    words: ed.words.map(w => w.text),
    style: { font: st.font, size: st.size, y: st.y, fill: st.fill, highlight: st.highlight, outline: st.outline, crop: st.crop, follow: st.follow },
    ranges: [...ed.ranges].sort((a, b) => a.s - b.s),
  }
}

async function save(render) {
  const mine = ed
  if (!mine.draft) return
  const button = render ? $('#reel-export') : $('#reel-save')
  button.disabled = true
  setMsg(render ? 'Starting the export…' : 'Saving…', 'muted')
  try {
    const call = render ? mine.api.renderReel.bind(mine.api) : mine.api.reelSave.bind(mine.api)
    const res = await call(mine.draft.id, mine.draft.rev, edit())
    if (ed !== mine) return
    mine.dirty = false
    if (res.draft) adopt(res.draft)
    else { mine.draft.rev = res.rev; if (render) { mine.draft.status = 'queued'; syncStatus() } }
    setMsg(render ? 'Export started.' : 'Saved.', 'muted')
  } catch (err) {
    if (ed !== mine) return
    setMsg(err.data?.conflict
      ? 'Someone else saved this draft meanwhile. Close and reopen it to see their version (your changes here will be lost).'
      : err.message, 'error')
  } finally {
    button.disabled = false
    if (ed === mine) syncStatus()
  }
}

// ------------------------------------------------------------------ chrome --

function setStatus(text, tone = '') {
  const el = $('#reel-status')
  el.textContent = text
  el.className = `small ${tone || 'muted'}`
}

function setMsg(text, tone = '') {
  const el = $('#reel-msg')
  el.textContent = text
  el.className = `small ${tone}`
}

function setBanner(text) {
  $('#reel-banner').hidden = !text
  $('#reel-banner').textContent = text
}

function close(force = false) {
  if (!ed) return
  if (!force && ed.dirty && !confirm('Close without saving your changes to this reel?')) return
  clearInterval(ed.poll)
  ed.player?.cancel()
  ed.player?.unload()
  const done = ed.onClose
  ed = null
  $('#reel-phone').dataset.state = 'idle'
  if ($('#reel').open) $('#reel').close()
  done?.()
}

let wired = false
function wireOnce() {
  if (wired) return
  wired = true

  const fontSel = $('#reel-font')
  for (const f of FONTS) {
    const o = document.createElement('option')
    o.value = f.id
    o.textContent = f.label
    o.style.fontFamily = `'Reel ${f.id}'`
    fontSel.append(o)
  }
  fontSel.addEventListener('change', () => {
    const f = fontById(fontSel.value)
    ed.style.font = f.id
    ed.style.size = f.size // each face has its own natural size; the slider still adjusts after
    renderStyle(); markDirty(); paint()
  })
  const slider = (id, key) => $(id).addEventListener('input', e => { ed.style[key] = +e.target.value; markDirty(); paint() })
  slider('#reel-size', 'size')
  slider('#reel-y', 'y')
  slider('#reel-crop', 'crop')
  $('#reel-size').min = String(LIMITS.size[0]); $('#reel-size').max = String(LIMITS.size[1])
  $('#reel-y').min = String(LIMITS.y[0]); $('#reel-y').max = String(LIMITS.y[1])

  const swatches = (box, colours, key, allowOff) => {
    for (const c of colours) {
      const b = document.createElement('button')
      b.type = 'button'
      b.dataset.c = c
      b.dataset.edit = ''
      b.style.background = c
      b.title = c
      b.addEventListener('click', () => { ed.style[key] = c; renderStyle(); markDirty(); paint() })
      box.append(b)
    }
    if (allowOff) {
      const b = document.createElement('button')
      b.type = 'button'
      b.dataset.c = ''
      b.dataset.edit = ''
      b.className = 'off'
      b.title = 'No highlight'
      b.addEventListener('click', () => { ed.style[key] = null; renderStyle(); markDirty(); paint() })
      box.append(b)
    }
  }
  swatches($('#reel-fill'), TEXT_SWATCHES, 'fill', false)
  swatches($('#reel-hl'), HIGHLIGHT_SWATCHES, 'highlight', true)
  $('#reel-fill-custom').addEventListener('input', e => { ed.style.fill = e.target.value.toUpperCase(); renderStyle(); markDirty(); paint() })
  $('#reel-hl-custom').addEventListener('input', e => { ed.style.highlight = e.target.value.toUpperCase(); renderStyle(); markDirty(); paint() })
  $('#reel-follow').addEventListener('change', e => { ed.style.follow = e.target.checked; renderStyle(); markDirty(); paint() })
  // Grabbing the slider means "I'll place it myself".
  $('#reel-crop').addEventListener('pointerdown', () => { if (ed.style.follow) { ed.style.follow = false; renderStyle() } })
  $('#reel-safe').addEventListener('change', e => $('#reel-phone').classList.toggle('show-safe', e.target.checked))

  $('#reel-play').addEventListener('click', togglePlay)
  $('#reel-restart').addEventListener('click', () => seekOutput(0))
  const scrub = $('#reel-scrub')
  scrub.addEventListener('input', () => { ed.scrubbing = true; paint(toTapeTime(+scrub.value, ed.ranges)) })
  scrub.addEventListener('change', () => { ed.scrubbing = false; seekOutput(+scrub.value) })

  $('#reel-save').addEventListener('click', () => save(false))
  $('#reel-export').addEventListener('click', () => save(true))
  $('#reel-redraft').addEventListener('click', () => {
    if (ed.words.length && !confirm('Re-draft from the request? Caption breaks and word fixes start over; your style is kept.')) return
    ed.dirty = false
    setBanner('')
    setStatus('Starting a new draft…')
    openDraft(true)
  })
  $('#reel-close').addEventListener('click', () => close())
  $('#reel').addEventListener('cancel', e => { e.preventDefault(); close() })
}

/** Exposed for the dev server's selftest. */
export const _reelState = () => ed
