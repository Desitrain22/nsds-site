// Upload status — renders data/upload-status.json, written by `youtube-sync.mjs --status`.
//
// Read-only and dependency-free. Unlike the rest of this app there is no Apps Script call and no
// gate: the whole page is one fetch of a static file.

const $ = sel => document.querySelector(sel)

// The report lives at the repo root, one level up from videoreview/. Cache-busted because the file
// is rewritten by CI on every sync and a stale copy would quietly show yesterday's backlog.
const SOURCE = `../data/upload-status.json?t=${Date.now()}`
// Written by `nsds_ingest.mjs --status` while the upload queue drains. Optional: no file, no section.
const INGEST_SOURCE = `../data/ingest-status.json?t=${Date.now()}`

const STATE_LABEL = {
  uploaded: 'on YouTube',
  pending: 'waiting',
  'held-back': 'held back',
}

/** "2026-09-20T20:08:39.094Z" -> "Sep 20, 20:08" in the reader's zone. */
function when(iso) {
  const d = new Date(iso)
  if (Number.isNaN(+d)) return iso || 'unknown'
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/**
 * The health banner.
 *
 * A failed sync is the single most important thing this page can say, because every other number
 * on it will look merely slow rather than stuck. Absent `run` means the report was generated off a
 * laptop, where there is no run to report on.
 */
function renderHealth(run) {
  const box = $('#health')
  if (!run) return
  box.hidden = false
  // "skipped" is a status_only refresh: no sync ran in this run, which is not a failure and must
  // not paint the banner red -- crying wolf here would cost the banner its meaning on the night
  // it matters.
  const skipped = run.sync === 'skipped'
  const bad = !skipped && run.sync !== 'success'
  box.classList.toggle('health--bad', bad)
  box.replaceChildren()

  const line = document.createElement('p')
  line.className = bad ? 'error' : skipped ? 'muted' : 'ok'
  line.textContent = bad
    ? `The last sync did not succeed (${run.sync}) — the backlog below is not moving.`
    : skipped
      ? 'Report refreshed on its own; no sync ran in this run.'
      : 'Last sync completed.'
  box.append(line)

  if (run.adopt && run.adopt !== 'success' && run.adopt !== 'unknown') {
    const a = document.createElement('p')
    a.className = 'warn small'
    a.textContent = `The adopt pass also reported "${run.adopt}", so newly uploaded tapes may not be recorded yet.`
    box.append(a)
  }

  if (run.url) {
    const a = document.createElement('a')
    a.className = 'linkish small'
    a.href = run.url
    a.target = '_blank'
    a.rel = 'noopener'
    a.textContent = `Run ${run.id} ↗`
    box.append(a)
  }
}

function renderShow(show) {
  const node = $('#tpl-show').content.firstElementChild.cloneNode(true)
  node.querySelector('.show-name').textContent = show.label
  node.querySelector('.show-count').textContent = `${show.uploaded}/${show.tapes}`

  // Progress is measured against the tapes we actually intend to upload, so the four full-show
  // tapes do not sit forever as an unfillable remainder on a show that has nothing left to do.
  const target = show.tapes - show.heldBack
  const pct = target ? Math.round((show.uploaded / target) * 100) : 0
  node.querySelector('.bar-fill').style.width = `${pct}%`

  const todo = node.querySelector('.show-todo')
  if (show.pending) {
    todo.textContent = `${show.pending} to go`
    todo.classList.add('warn')
  } else if (!target) {
    // Every tape here is a full show. Calling that "done" reads as "uploaded", which it is not.
    todo.textContent = 'held back'
    todo.classList.add('muted')
  } else {
    todo.textContent = 'done'
    todo.classList.add('ok')
  }

  // Anything with work left opens by default: the page exists to show what is stuck, and a
  // finished show is a one-line fact that does not need its eleven rows expanded.
  node.open = show.pending > 0
  node.classList.toggle('show--done', show.pending === 0)

  const list = node.querySelector('.items')
  for (const item of show.items) {
    const li = document.createElement('li')
    li.className = `item item--${item.state}`

    const name = document.createElement('span')
    name.className = 'item-name'
    name.textContent = item.performer
    li.append(name)

    const state = document.createElement('span')
    state.className = 'item-state small'
    state.textContent = STATE_LABEL[item.state] || item.state
    li.append(state)

    if (item.youtubeUrl) {
      const a = document.createElement('a')
      a.className = 'linkish small'
      a.href = item.youtubeUrl
      a.target = '_blank'
      a.rel = 'noopener'
      a.textContent = 'watch ↗'
      li.append(a)
    }
    list.append(li)
  }

  // More csv rows than tapes means rows survive for file ids the folder no longer has -- leftovers
  // from the Drive reorg's renames and duplicates. Said plainly, because "14 of 8 uploaded" would
  // otherwise read as progress.
  if (show.csvRows > show.uploaded) {
    const n = show.csvRows - show.uploaded
    const p = node.querySelector('.stale')
    p.hidden = false
    p.textContent = `${n} stale row(s) in youtube.csv — recorded uploads whose tape is no longer in this folder.`
    // Also flag it on the closed summary: these shows are the ones marked done, so the warning
    // would otherwise only exist inside a section nobody has a reason to open.
    const flag = document.createElement('span')
    flag.className = 'warn small stale-flag'
    flag.textContent = `⚠ ${n} stale`
    flag.title = 'youtube.csv has rows for tapes no longer in this folder'
    node.querySelector('.show-count').after(flag)
  }
  return node
}

function render(data) {
  const t = data.totals
  $('#totals').textContent =
    `${t.uploaded} on YouTube · ${t.pending} pending · ${t.heldBack} held back · ${t.tapes} tapes`
  $('#generated').textContent = `generated ${when(data.generatedAt)}`
  renderHealth(data.run)

  const host = $('#shows')
  host.removeAttribute('aria-busy')
  host.replaceChildren()

  // Grouped by year, newest first — which is the order the report already arrives in, since
  // discovery walks the year roots newest-first.
  const years = [...new Set(data.shows.map(s => s.year))]
  for (const year of years) {
    const h = document.createElement('h2')
    h.className = 'year'
    h.textContent = year ?? 'undated'
    host.append(h)
    for (const show of data.shows.filter(s => s.year === year)) host.append(renderShow(show))
  }
}

// ------------------------------------------------------------------ the upload queue --

const SOURCE_LABEL = { wetransfer: 'WeTransfer', dropbox: 'Dropbox', drive: 'Drive' }
const fmtGiB = n => `${(n / 1024 ** 3).toFixed(1)} GiB`

/** "4 min ago" / "3 h ago" — the queue is about now, so a relative time reads faster than a date. */
function ago(iso) {
  const ms = Date.now() - Date.parse(iso)
  if (!(ms >= 0)) return when(iso)
  const min = Math.round(ms / 60000)
  if (min < 1) return 'just now'
  if (min < 90) return `${min} min ago`
  const h = Math.round(min / 60)
  return h < 36 ? `${h} h ago` : when(iso)
}

/** What each state says on the right, and how loudly. */
function ingestState(sub) {
  switch (sub.state) {
    case 'copying': return [`${sub.filesDone}/${sub.filesTotal} copied`, 'warn']
    case 'paused': return [`${sub.filesDone}/${sub.filesTotal} · paused`, 'warn']
    case 'queued': return ['queued', 'muted']
    case 'incomplete': return [`${sub.errors} failed`, 'error']
    case 'complete': return ['in Drive', 'ok']
    default: return [sub.state, 'muted']
  }
}

function renderIngestRow(sub) {
  const row = document.createElement('div')
  row.className = `show ingest-row ingest--${sub.state}`
  const head = document.createElement('div')
  head.className = 'show-head'

  const name = document.createElement('span')
  name.className = 'show-name'
  name.textContent = sub.show || 'unnamed show'
  const count = document.createElement('span')
  count.className = 'show-count muted small'
  const n = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`
  count.textContent = `${n(sub.performers, 'performer')} · ${n(sub.filesTotal, 'file')} · ${fmtGiB(sub.bytes)}`
    + (sub.source ? ` · ${SOURCE_LABEL[sub.source] || sub.source}` : '')
  const spacer = document.createElement('span')
  spacer.className = 'spacer'
  const track = document.createElement('span')
  track.className = 'bar-track'
  track.setAttribute('aria-hidden', 'true')
  const fill = document.createElement('span')
  fill.className = 'bar-fill'
  fill.style.width = `${sub.filesTotal ? Math.round((sub.filesDone / sub.filesTotal) * 100) : 0}%`
  track.append(fill)
  const [label, tone] = ingestState(sub)
  const todo = document.createElement('span')
  todo.className = `show-todo small ${tone}`
  todo.textContent = label
  head.append(name, count, spacer, track, todo)

  const notes = [`submitted ${ago(sub.submittedAt)}`]
  if (sub.lastProgressAt && sub.state !== 'queued') notes.push(`last progress ${ago(sub.lastProgressAt)}`)
  if (sub.state === 'paused') notes.push('no run is copying it right now — the next hourly run picks it up where it stopped')
  if (sub.state === 'queued') notes.push('starts on the next hourly run, after anything already copying')
  if (sub.errors) notes.push(`${sub.errors} file(s) failed, last ${sub.lastError?.dest || ''} — retried on the next run`)
  const note = document.createElement('p')
  note.className = 'muted small ingest-note'
  note.textContent = notes.join(' · ')

  row.append(head, note)
  return row
}

async function renderIngest() {
  let data
  try {
    const res = await fetch(INGEST_SOURCE)
    if (!res.ok) return
    data = await res.json()
  } catch { return }
  const subs = data.submissions || []
  if (!subs.length) return
  $('#ingest-list').replaceChildren(...subs.map(renderIngestRow))
  $('#ingest-updated').textContent = `Updated ${ago(data.generatedAt)}.`
  $('#ingest').hidden = false
}

// Independent of the YouTube report: either file can be missing without hiding the other.
renderIngest()

try {
  const res = await fetch(SOURCE)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  render(await res.json())
} catch (err) {
  $('#shows').removeAttribute('aria-busy')
  $('#totals').textContent = ''
  const box = $('#load-error')
  box.hidden = false
  box.textContent = `Could not load the status report (${err.message}). `
    + 'It is written by `node tools/youtube-sync.mjs --status`, which CI runs after each sync — '
    + 'if this is a fresh checkout, that file may not exist yet.'
}
