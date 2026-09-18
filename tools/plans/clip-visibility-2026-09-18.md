# Can a past performer see the clips we cut for them?

Audit run 2026-09-18 against live Drive, the MASTER clip tracker
(`1jG5-ytbzxLKsmRYC6HVar-0tbAY0-WBJ9SrAZzBsA_o`) and all 19 per-show request sheets.

## The short version

The Drive side is already right. **145 of the 149 clips in the master tracker are sitting in the
correct show's `completed_clips/` folder**, which is exactly where `listTapes` looks. The four
that aren't are not performer clips at all: two March 2025 (SF) highlight reels, that show's
full-show tape, and Austin's `AustinPROOF.mp4` (his set tape, correctly filed under `tapes/`).

So the column M "Finished clip (Drive link)" backfill is **not** what stands between a performer
and their clips — `renderFinished()` already surfaces `completed_clips/` per performer via
`clipBelongsTo`. Column M only adds the ability to pin one clip to one specific request row.

Unadopted request rows are **not** a blocker either: `app.js` renders them as legacy entries with
name, times, notes, a ▶ Play button and a "Finished clip ↗" anchor. Adoption is polish.

## What actually blocks it

Simulating `clipBelongsTo` over every show: **54 clips would be seen by nobody.** The cause is
almost never software.

| cause | clips | fix |
|---|---|---|
| **The set tape is not in Drive**, so there is no tape to open | **51** | find the footage, or accept |
| Tape filename does not match the performer | 3 | two renames, below |

### The 51 — tape missing, clips exist

| show | clips stranded | who |
|---|---|---|
| July 2024 (NYC) | 10 | Alex, Ash ×2, Carlos ×2, Neal, Shounak, Srishti ×2, Tariq — only `Full Show.mp4` was ever filed |
| June 2026 (NYTW) | 8 | Dan, Nate, Naveed, Neal, Pete, Sarah, Srishti, Yanjaa — only Ben and NealPt2 have tapes |
| February 2026 (NYC) | 8 | Irene ×3, Peter ×3, Dan ×2 — no tapes at all |
| October 2025 (SF + LA) | 7 | Denise Lee ×1, Ryan Sudhakaran ×6 — their tapes are the two missing from that show |
| December 2025 (NYC) | 7 | Neal ×3, Hayden ×2, Yanjaa ×2 — no tapes at all |
| March 2025 (SF) | 6 | Pete ×4, Brook ×2 — only `Full Show.mp4` |
| March 2026 (NYC) | 4 | Pete ×4 — no tapes at all |
| November 2024 (Mango) | 1 | `MechanicalTurkV2.mp4` — no tapes at all |

No code change reaches these. Either the footage gets found and filed into `<show>/tapes/`, or
those performers cannot review a tape for that show.

### The 3 — tape filename mismatch

Both are the tape being named after something other than the performer, so `clipBelongsTo` can
never match:

| show | tape today | should be | unlocks |
|---|---|---|---|
| November 2024 (Roast) | `Sristhi Set.mp4` (`14RAD1ewVrOMR07Nhw6dMgiK__sy13yEp`) | `Srishti Set.mp4` | Srishti's 2 roast clips |
| July 2025 (NYC) | `Doordash Set.mp4` (`1WMA8YtKKdJzXZS5kfNDUcJ_xe3q0lWcC`) | `Aakash Set.mp4` | `Aakash — Parth Patel.mp4` |

Worth doing **before** these two shows upload to YouTube, because `performerFrom(filename)` sets
the video title — otherwise the titles say "Sristhi" and "Doordash" too. Neither tape is on
YouTube yet, and `youtube.csv` is keyed on file id, so a rename is safe.

`Doordash Set.mp4` needs a human call: the July 2025 request sheet also calls that row "Doordash",
so the bit may be filed deliberately under the sketch name rather than the performer's.

## The column M plan (optional, needs ADMIN_KEY)

`tools/plan-clip-links.mjs` regenerates `clip-links-2026-09-18.json`, the `adminSetClipLinks`
payload. It pins a clip to a specific request row only where there is real evidence — a timestamp
in the clip note overlapping the row's range, a distinctive word from the clip name landing in
exactly one of that performer's rows, or the performer having exactly one row. 36 row writes and
16 appended rows for performers with no row; the other 74 clips are deliberately left to the
Finished-clips list rather than guessed at (clips named `AmandaClip1.mp4` carry no signal about
which request produced them). Every decision is recorded in the `.audit.json`.

`adminSetClipLinks` defaults to `dryRun: true` and refuses a row whose column A does not match
`expectName`, so a stale plan cannot corrupt anyone's notes.

## Ordered by value

1. **Merge PR #9** — without it the live site has no Finished-clips UI at all, so none of the 145
   correctly-filed clips are visible to anyone.
2. **Restore the YouTube upload path** (re-consent, publish the consent screen) and drain the 64
   pending tapes — every 2025 tape is still at `0 on YouTube`, so a 2025 performer has no tape to
   open even once the UI ships.
3. **The two renames above** — 3 clips and 2 future video titles.
4. **Decide about the 51** — this is a "where is the footage" question, not an engineering one.
5. **Column M backfill** — genuinely optional; needs ADMIN_KEY from Script Properties.
