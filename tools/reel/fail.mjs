#!/usr/bin/env node
// Last step of every reel.yml run, only when the job failed or was cancelled: a draft left saying
// "drafting" or "rendering" would leave the editor waiting forever. Marks it failed so it can be
// retried. (Apps Script also treats a busy status older than an hour as stale, for runs that die
// too hard to get here.)
//
//   node tools/reel/fail.mjs <draftFileId>

import { readDraft, patchDraft, workdir } from './lib.mjs'

const id = process.argv[2]
const dir = await workdir()
const draft = await readDraft(id, dir)
if (['drafting', 'queued', 'rendering'].includes(draft.status)) {
  await patchDraft(draft, current => ['drafting', 'queued', 'rendering'].includes(current.status)
    ? { status: 'failed', error: 'the job stopped before finishing — try again' }
    : {}, dir)
  console.log('marked failed')
}
