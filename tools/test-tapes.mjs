#!/usr/bin/env node
// Zero-dep checks for the parts of lib/tapes.mjs that talk to processes. videoreview/test.mjs
// covers the pure logic and deliberately stays pure; this covers the coordination around spawn(),
// which is where the expensive bug was.
//
//   node tools/test-tapes.mjs
//
// It needs ffmpeg only to manufacture a sample; rclone is stubbed, so nothing here touches Drive,
// the network, or a credential.

import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { showStatus, statusPayload, groupTapesByShow } from './lib/tapes.mjs'

const FFMPEG = process.env.NSDS_FFMPEG || '/opt/homebrew/bin/ffmpeg'
let failures = 0
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${name}${detail && !cond ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const run = (cmd, argv, env) => new Promise((res, rej) => {
  const c = spawn(cmd, argv, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  c.stdout.on('data', d => { out += d }); c.stderr.on('data', d => { err += d })
  c.on('error', rej); c.on('close', code => res({ code, out, err }))
})

// ---------------------------------------------------------------- status classification --
//
// Pure, so these run first and unconditionally: an absent ffmpeg must not quietly skip them.

// The upload portal's per-performer layout, as youtube-sync lists it (rclone lsjson from the year
// folder): each performer's main shot is their one tape, and nothing under angles/ is ever uploaded.
{
  const V = 'video/mp4'
  const e = (Path, IsDir = false) => ({ Path, Name: Path.split('/').pop(), IsDir, MimeType: IsDir ? '' : V, ID: Path, Size: 1 })
  const byShow = groupTapesByShow([
    e('October 2026 (NYC)', true), e('October 2026 (NYC)/tapes', true),
    e('October 2026 (NYC)/tapes/Neal/Neal Set.mp4'),
    e('October 2026 (NYC)/tapes/Neal/angles/Neal - Side Shot.mp4'),
    e('October 2026 (NYC)/tapes/Old Flat Set.mp4'),
  ], new Set(['October 2026 (NYC)']))
  const names = (byShow.get('October 2026 (NYC)') || []).map(t => t.name)
  ok('per-performer layout: main shot is a tape, angles/ never is',
     JSON.stringify(names) === JSON.stringify(['Neal Set.mp4', 'Old Flat Set.mp4']), JSON.stringify(names))
}

const show = (label, names) => ({
  label,
  folderId: `folder-${label}`,
  tapes: names.map((name, i) => ({ id: `id-${i}`, name, size: 1e9, path: name, performer: name.replace(/ Set\.mp4$/, '') })),
})
const row = (i, extra = {}) => ({
  file_id: `id-${i}`, filename: 'x.mp4', performer: 'x',
  youtube_id: 'vid', youtube_url: 'https://youtu.be/vid', uploaded_at: '2026-09-18 10:00:00', ...extra,
})

{
  const s = show('May 2026 (Boston)', ['Neal Set.mp4', 'PeteB Set.mp4', 'Full Show.mp4'])
  const st = showStatus(s, [row(0)])
  ok('a tape with a csv row is uploaded', st.items[0].state === 'uploaded', st.items[0].state)
  ok('...and carries its YouTube link', st.items[0].youtubeUrl === 'https://youtu.be/vid', st.items[0].youtubeUrl)
  ok('a tape with no row is pending', st.items[1].state === 'pending', st.items[1].state)
  ok('a full-show tape with no row is held back, not pending',
     st.items[2].state === 'held-back', st.items[2].state)
  ok('counts match the items', st.tapes === 3 && st.uploaded === 1 && st.pending === 1 && st.heldBack === 1,
     JSON.stringify({ t: st.tapes, u: st.uploaded, p: st.pending, h: st.heldBack }))
  ok('the year comes off the label', st.year === 2026, String(st.year))

  // A row without a youtube_id is a half-written attempt, not a finished upload.
  const half = showStatus(s, [row(0, { youtube_id: '' })])
  ok('a row with no youtube_id does not count as uploaded',
     half.items[0].state === 'pending' && half.uploaded === 0, half.items[0].state)
}

{
  // The stale-row case: the csv holds a row for a file id no longer in the folder, which is how
  // March 2026 (SF) reports 14 uploads against 8 tapes.
  const st = showStatus(show('March 2026 (SF)', ['A Set.mp4']), [row(0), row(99)])
  ok('csvRows exposes rows the folder no longer has',
     st.uploaded === 1 && st.csvRows === 2, JSON.stringify({ u: st.uploaded, c: st.csvRows }))
}

{
  const shows = [
    showStatus(show('July 2026 (NYC)', ['A Set.mp4', 'B Set.mp4']), [row(0), row(1)]),
    showStatus(show('July 2024 (NYC)', ['Full Show.mp4']), []),
    showStatus(show('March 2025 (NYC)', ['C Set.mp4']), []),
  ]
  const p = statusPayload(shows, { generatedAt: '2026-09-19T20:00:00.000Z' })
  ok('totals sum across shows',
     p.totals.shows === 3 && p.totals.tapes === 4 && p.totals.uploaded === 2
     && p.totals.pending === 1 && p.totals.heldBack === 1, JSON.stringify(p.totals))
  ok('shows keep discovery order', p.shows.map(s => s.year).join() === '2026,2024,2025',
     p.shows.map(s => s.year).join())
  ok('run is omitted when there is no CI context', !('run' in p))
  ok('generatedAt is a real ISO timestamp', !Number.isNaN(Date.parse(p.generatedAt)), p.generatedAt)
}

// ---------------------------------------------------------------- spawn coordination --

const dir = await mkdtemp(join(tmpdir(), 'nsds-test-'))
try {
  // A real (tiny) mp4, so ffprobe has something with a duration to read.
  const sample = join(dir, 'sample.mp4')
  const made = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'testsrc=duration=3:size=320x240:rate=10', '-c:v', 'libx264', '-movflags', '+faststart', sample])
  if (made.code !== 0) {
    // Skip only this section -- the pure checks above have already run and still have to report.
    console.log(`  SKIP  no usable ffmpeg at ${FFMPEG} — set NSDS_FFMPEG`)
    console.log(failures ? `\n${failures} failing` : '\nall passing (spawn checks skipped)')
    process.exit(failures ? 1 : 0)
  }

  /**
   * REGRESSION: headerDuration must not care which of two 'close' events lands first.
   *
   * It used to end the sink and then wait for it, inside the child's own 'close' handler. But
   * pipe() already ends the sink when stdout ends, so the ordering is a race: macOS reliably
   * resolved it, Linux reliably did not. On a CI runner the sink had already closed before the
   * listener was attached, so it never fired, the promise never settled, and -- with the child
   * reaped, the sink closed and the timeout cleared -- nothing held the event loop open. Node
   * exited 0, mid-run, printing nothing. Six shards did that and reported success.
   *
   * This stubs rclone with a script that closes stdout and only then lingers before exiting,
   * which forces the losing ordering deterministically on any platform.
   */
  const stub = join(dir, 'fake-rclone')
  await writeFile(stub, `#!/bin/sh
cat "$FAKE_SRC"
exec 1>&-
sleep 1
exit 0
`)
  await chmod(stub, 0o755)

  const probe = await run(process.execPath, ['--input-type=module', '-e', `
    import { headerDuration } from ${JSON.stringify(new URL('./lib/tapes.mjs', import.meta.url).href)}
    const d = await headerDuration('ignored/by/the/stub.mp4', 'ignored')
    console.log('DURATION=' + d)
  `], { NSDS_RCLONE: stub, FAKE_SRC: sample })

  const m = /DURATION=([\d.]+)/.exec(probe.out)
  ok('headerDuration resolves when the sink closes before the child exits',
     !!m, `printed nothing (exit ${probe.code}) — the promise never settled, the old bug`)
  if (m) ok('...and reads the real duration', Math.abs(Number(m[1]) - 3) < 1, `got ${m[1]}, want ~3`)

  // A failing rclone must reject rather than hang, so the caller falls back to the slow path.
  const bad = join(dir, 'bad-rclone')
  await writeFile(bad, '#!/bin/sh\nexit 3\n')
  await chmod(bad, 0o755)
  const failed = await run(process.execPath, ['--input-type=module', '-e', `
    import { headerDuration } from ${JSON.stringify(new URL('./lib/tapes.mjs', import.meta.url).href)}
    console.log('RESULT=' + await headerDuration('x.mp4', 'y'))
  `], { NSDS_RCLONE: bad, FAKE_SRC: sample })
  ok('a non-zero rclone returns null instead of hanging',
     /RESULT=null/.test(failed.out), `printed ${JSON.stringify(failed.out.trim())}`)
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} failing` : '\nall passing')
process.exit(failures ? 1 : 0)
