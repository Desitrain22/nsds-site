// Drive plumbing for the reel jobs (tools/reel/draft.mjs, render.mjs), run by .github/workflows/reel.yml.
//
// The workflow is dispatched with nothing but a draft's Drive FILE ID — the repo is public, so are
// its Actions logs and workflow inputs, and a transcript has no business in either. Everything else
// is read from the draft. Never log draft contents from here: counts and ids only.

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rclone, inFolder, REMOTE, run } from '../lib/tapes.mjs'

export { run }
export const FFMPEG = process.env.NSDS_FFMPEG || 'ffmpeg'

export const DRIVE_ID_RE = /^[\w-]{20,80}$/

export async function workdir() {
  return mkdtemp(join(tmpdir(), 'reel-'))
}

/** The draft JSON, by file id. */
export async function readDraft(id, dir) {
  if (!DRIVE_ID_RE.test(id)) throw new Error('bad draft id')
  const local = join(dir, `draft-${Date.now()}.json`)
  await rclone(['backend', 'copyid', `${REMOTE}:`, id, local], { quiet: true })
  const draft = JSON.parse(await readFile(local, 'utf8'))
  draft.id = id
  return draft
}

/**
 * Merge `patch` (an object, or a function of the current draft) into the draft as it stands NOW,
 * then write it back in place.
 *
 * Re-reading first matters: Apps Script may have touched the file since this job started (a poll
 * appending a link, say). Only the fields a job owns are patched; the editor's fields are left as
 * they are. rclone overwrites a same-named Drive file in place, so the file id — the draft id —
 * survives the write.
 */
export async function patchDraft(draft, patch, dir) {
  const current = await readDraft(draft.id, dir)
  const next = { ...current, ...(typeof patch === 'function' ? patch(current) : patch), updatedAt: new Date().toISOString() }
  delete next.requestChanged
  const local = join(dir, `${draft.key}.json`)
  await writeFile(local, JSON.stringify(next))
  await rclone(['copyto', ...inFolder(draft.folders.drafts), local, `${REMOTE}:${draft.key}.json`], { quiet: true })
  return next
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
    s.on('error', reject)
  })
}

/**
 * Serve the master over local HTTP so ffmpeg can seek with byte ranges instead of the runner
 * downloading a multi-gigabyte 4K tape (a runner has ~14 GB of disk). `rclone serve` addresses files
 * by name, so first confirm that name in the parent folder is exactly one file, and that it is the
 * file id the draft was made from.
 */
export async function serveMaster(draft) {
  const { fileId, name, parentId } = draft.master || {}
  if (!DRIVE_ID_RE.test(fileId || '') || !DRIVE_ID_RE.test(parentId || '')) throw new Error('draft has no master')
  const listing = JSON.parse(await rclone(['lsjson', ...inFolder(parentId), '--files-only', `${REMOTE}:`], { quiet: true }))
  const same = listing.filter(f => f.Name === name)
  if (same.length !== 1 || String(same[0].ID).split('\t')[0] !== fileId) {
    throw new Error('the master tape was moved, renamed or duplicated since this draft was made')
  }

  const port = await freePort()
  const child = spawn(process.env.NSDS_RCLONE || 'rclone', [
    'serve', 'http', ...inFolder(parentId), `${REMOTE}:`,
    '--addr', `127.0.0.1:${port}`, '--read-only', '--vfs-cache-mode', 'off', '--dir-cache-time', '1h',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', d => { stderr += d })

  const url = `http://127.0.0.1:${port}/${encodeURIComponent(name)}`
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`rclone serve exited: ${stderr.trim().split('\n').pop()}`)
    try {
      const res = await fetch(url, { method: 'HEAD' })
      if (res.ok) return { url, stop: () => child.kill() }
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500))
  }
  child.kill()
  throw new Error('rclone serve never came up')
}

/** Names already in a Drive folder (for versioning). */
export async function listNames(folderId) {
  const out = await rclone(['lsf', ...inFolder(folderId), '--files-only', `${REMOTE}:`], { quiet: true })
  return out.split('\n').map(s => s.trim()).filter(Boolean)
}

/** Upload a finished file and return its Drive id. */
export async function upload(local, folderId, name) {
  await rclone(['copyto', ...inFolder(folderId), local, `${REMOTE}:${name}`], { quiet: true })
  const listing = JSON.parse(await rclone(['lsjson', ...inFolder(folderId), '--files-only', `${REMOTE}:`], { quiet: true }))
  const hit = listing.find(f => f.Name === name)
  if (!hit) throw new Error('upload did not land')
  return String(hit.ID).split('\t')[0]
}

/** One line, no transcript: what a failed job leaves in the draft for the editor to show. */
export const shortError = err => String(err?.message || err).split('\n')[0].slice(0, 300)
