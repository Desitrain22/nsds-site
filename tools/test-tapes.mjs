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

const dir = await mkdtemp(join(tmpdir(), 'nsds-test-'))
try {
  // A real (tiny) mp4, so ffprobe has something with a duration to read.
  const sample = join(dir, 'sample.mp4')
  const made = await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'testsrc=duration=3:size=320x240:rate=10', '-c:v', 'libx264', '-movflags', '+faststart', sample])
  if (made.code !== 0) {
    console.log(`  SKIP  no usable ffmpeg at ${FFMPEG} — set NSDS_FFMPEG`)
    process.exit(0)
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
