#!/usr/bin/env node
// Last step of every reel.yml run, only when the job failed or was cancelled: a draft left saying
// "drafting" or "rendering" would leave the editor waiting forever. Marks it failed so it can be
// retried. (Apps Script also treats a busy status older than an hour as stale, for runs that die
// too hard to get here.)
//
//   node tools/reel/fail.mjs <draftFileId> [kind]

import { readDraft, patchDraft } from './lib.mjs'

const kind = process.argv[3] || 'reel'
const draft = await readDraft(process.argv[2], kind)
if (['drafting', 'queued', 'rendering'].includes(draft.status)) {
  await patchDraft(draft, { status: 'failed', error: 'the job stopped before finishing — try again' }, kind)
  console.log('marked failed')
}
