// Upload status — renders data/upload-status.json, written by `youtube-sync.mjs --status`.
//
// Read-only and dependency-free. Unlike the rest of this app there is no Apps Script call and no
// gate: the whole page is one fetch of a static file.

const $ = sel => document.querySelector(sel)

// The report lives at the repo root, one level up from videoreview/. Cache-busted because the file
// is rewritten by CI on every sync and a stale copy would quietly show yesterday's backlog.
const SOURCE = `../data/upload-status.json?t=${Date.now()}`

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
