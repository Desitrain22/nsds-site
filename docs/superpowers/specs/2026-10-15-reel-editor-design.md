# Reel editor — design

Turn a clip request in a show's Tape Requests sheet into a finished 9:16 clip for Instagram
Reels, TikTok and YouTube Shorts: a draft the engine makes on its own, a browser editor where
anyone with the Tape Review passphrase can fix the captions, and an Export button that renders
the MP4.

Status: design, approved for planning once Neal signs off on this document.
Mockup the editor was agreed from: `.superpowers/brainstorm/87689-1792101787/content/caption-editor.html`
(local, not committed — open it in a browser via the brainstorm companion, or read the source).

Throughout, **decided** means Neal said so in the design conversation; **builder's call** means
it was settled while writing this document and can be revisited without asking him.

---

## 1. Why

Today a clip goes out like this: a performer marks in/out points in Tape Review, the row lands in
the show's Tape Requests sheet (columns A–G plus machine columns H–L), and an editor uses that row
*as a guideline* — plus their own judgement about stand-up — to cut the clip by hand in CapCut or
similar, then pastes the finished Drive link into column M.

The engine is meant to **produce that clip from the row** — at minimum a draft an editor tightens,
ideally good enough to post with no editor at all (decided). The one thing people will
reliably want to change by hand is **caption cadence**: which words share the screen. Comedians
regroup `w1 w2 w3 / w4 w5 w6 / w7` into `w1 w2 / w3 w4 w5 / w6 w7` to land a punchline, exactly
the way CapCut lets you (decided — this is the reason WhisperX was chosen: word-level timing
survives regrouping, so captions stay synced at render).

### Success looks like
- Someone opens a clip request, waits a few minutes for a draft, regroups a few caption breaks,
  maybe swaps a font, presses Export, and gets a postable 1080×1920 MP4 in the show's
  `completed_clips/` folder.
- The preview they edited against is what comes out. No surprises after export.

### Goals
1. Auto-draft a vertical clip from a request row: the row's ranges, its column-D cuts, a 9:16 crop,
   word-timed captions, and the NSDS bug.
2. A browser editor (agreed mockup) where captions can be regrouped, words corrected, and style
   changed, with a live preview.
3. Export renders a final MP4 with FFmpeg against the **Drive master**, versioned, never
   overwriting.
4. A `/render-reel` POST that validates every parameter from the editor, including converting hex
   colours to FFmpeg/ASS `&H00BBGGRR&` (decided).
5. Built on the existing infrastructure: Apps Script backend, the request sheets, Drive masters,
   YouTube viewing copies, GitHub Actions (decided).

### Non-goals (v1)
- Posting to Instagram/TikTok/YouTube. Output stops at a Drive MP4.
- Automatic reframing / face or speaker tracking. The crop is centred with a manual left–right
  slider (builder's call).
- CapCut extras: zooms, emoji, sound effects, music, B-roll, transitions.
- Interpreting judgement-call notes ("end on the laugh", "punchier"). They are shown to the person
  editing, not acted on. Only mechanical notes are automated (§6).
- Approval workflow. **Anyone with the passphrase can export; once it's ready, it's ready**
  (decided).
- YouTube or Drive auto-captions. Drive has no API for its captions; YouTube's need a broader OAuth
  scope and are phrase-timed. **WhisperX only** (decided).

### Anti-goals — failure even if it technically works
- Writing to columns A–L of any row, or overwriting anything an editor wrote in column M.
- Overwriting an earlier export, or touching the masters.
- An export that looks materially different from the preview (different breaks, position or font).
- Running anything on Neal's laptop. The MacBook is a work machine and sleeps; every job runs in
  GitHub Actions (standing rule for NSDS).
- Transcripts, clip contents or secrets appearing in GitHub Actions logs or workflow inputs — the
  repo (`Desitrain22/nsds-site`) is **public**, so its Actions logs are public.

---

## 2. What exists (read before building)

- `videoreview/` — Tape Review: plain HTML/CSS/ES modules, no build step. `index.html` + `app.js`
  is the review page; clip cards show "Finished clip ↗" from column M; rows typed straight into the
  sheet show under "Already in the sheet" (read-only in the app). See `videoreview/README.md`,
  especially *How clips land in the sheet* and *Rules that keep the sheet safe*.
- `videoreview/apps-script/Code.gs` — the only backend. One web app URL; `doPost` parses a JSON body
  and routes on `body.action`. Secrets are script properties (`PASSWORD`, `ADMIN_KEY`, `UPLOAD_KEY`).
  `saveClip` / `getClips` define the clip shape (`clipId`, `ranges` as `{s,e}` seconds,
  `videoFileId`, `rev`). Column D parsing (`parseGranularGs`, `subtractRangesGs`) already
  distinguishes additive ranges, `remove …` cuts, and free-text advice.
- `player.js` — the YouTube IFrame player wrapper used for review. Tapes play from **unlisted
  YouTube copies** (1080p) because Drive can't serve video to a page (README explains why).
- Drive layout: `Media/<year>/<show>/{tapes,photos,completed_clips,extras}` plus the request sheet
  and `youtube.csv` (Drive file id → YouTube id). `listFinishedClips` lists videos in
  `completed_clips/`.
- `.github/workflows/youtube-sync.yml` — the pattern to copy for a job that reads Drive masters:
  rclone configured entirely from env/secrets (`NSDS_RCLONE_TOKEN` or `NSDS_DRIVE_SA_JSON`),
  ffmpeg on `ubuntu-latest`. Masters are large (4K, ~76 Mbps; a tape is gigabytes).
- `tools/deploy-backend.sh` / `deploy-backend.yml` — how `Code.gs` gets deployed (clasp).
- Prior art: `media/reels/*.mp4` are the editors' finished reels. Their caption style is a tall
  condensed face in white caps with a heavy black outline, two lines, centred horizontally at
  roughly 55–60% of frame height — **not** at the bottom, because the platforms' own UI covers the
  bottom ~20% and the right edge.
- Brand: `style.css` tokens (purple `#2E1A42`, yellow `#FFFF82`, pale yellow `#FFFFC0`, pale cyan
  `#DDEFD1`); site font Azeret Mono; logo `media/brand/Icon.svg`.

---

## 3. The editor (decided, from the mockup)

A full-screen editor inside Tape Review (a `<dialog>` — builder's call; first drafted as a separate
`reel.html`, but in-app it reuses the passphrase gate, API client and player), reached from a
**"Make reel"** button on every clip card — app-written clips *and* the "Already in the sheet" rows, since those are most of the
existing requests (builder's call). Same passphrase gate as Tape Review.

Layout, as in the mockup:

- **Preview** — a 9:16 phone-shaped frame playing the clip, captions drawn live on top, the bug in
  the top-right. Play/pause, restart, scrub.
- **Caption breaks** — the transcript as a row of words. Clicking the gap between two words adds
  or removes a break (`/`); each group is what's on screen together. Clicking a word seeks to it.
  Double-clicking a word edits its text; **its timing stays** (no re-transcription). Pauses ≥ 0.5 s
  are shown between words as a hint for where breaks belong.
- **Style** — font dropdown, size, vertical position, text colour, "current word" highlight colour
  (or off), and a toggle to overlay the platforms' UI safe-zone.
- **Save draft** / **Export MP4**.

Additions not in the mockup (builder's call):
- **Crop slider** — horizontal position of the 9:16 window, default centred.
- **Trim** — nudge each range's in/out point. Changes the reel only; the sheet row is never edited.
- **Notes panel** — the row's column E and any un-automated column D text, read-only, so the person
  editing sees the performer's intent.
- **Export status** — after Export: queued → rendering → done (link to the MP4) or failed (reason).

Defaults (builder's call, matching current reels): font Bebas Neue, size so ~3 words fit a line,
white fill, black outline, current word in brand yellow `#FFFF82`, vertical centre at 58%, all caps.

Font list (builder's call — all free/OFL from Google Fonts, so the same files are used by the
browser and by FFmpeg): **Bebas Neue, Anton, Archivo Black, Montserrat ExtraBold, Azeret Mono.**

### The bug (decided)
Every clip: the NSDS logo (`media/brand/Icon.svg`) with **"A.U Tech Comedy Show"** set in the brand
font (Azeret Mono, bold), top-right corner, faded (~70% opacity in the mockup). Text exactly as
Neal wrote it.

---

## 4. Drafts are recipes, not videos (builder's call)

"The output should be a video, but one that's still editable" is met by keeping the editable thing
a **recipe** and rendering video only on Export. Nothing renders while someone is editing.

A draft is one JSON file per clip, stored in Drive in a new per-show folder
(`Media/<year>/<show>/reel_drafts/`, name is the builder's call), holding at least:

```
source      showFolderId, sheet row reference, clipId (or a minted id for legacy rows),
            master fileId, youtubeId
ranges      [{s, e}]  — from the row, after column-D cuts and trims
words       [{text, s, e, aligned: bool}]  — tape-time seconds
breaks      [word indices that start a new group]
style       {font, size, y, fill, highlight, outline, crop}
notes       raw column D/E text, for display
status      drafting | ready | rendering | done | failed, + error, + exports [{version, fileId, at}]
rev         bumped per save; mismatch = someone else saved (same idea as column J)
```

**Preview** plays the YouTube viewing copy inside the phone frame, cropped to 9:16 by CSS
(scale to fill height, translate by the crop slider), jumping across the ranges, with captions
drawn as HTML exactly like the mockup. Edits are instant.

**Export** renders from the **Drive master**, not the YouTube copy (builder's call): a 9:16 slice of
1080p is only 608 px wide and looks soft blown up to 1080×1920; a slice of a 4K master is ~1215 px
and scales down cleanly. If a master is below 1920 px tall, render anyway and say so in the export
status.

**Legacy rows** (typed into the sheet, no `clipId`) get a draft keyed by a minted id plus a
reference back to the row (builder decides the reference — e.g. sheet id + row fingerprint of
A–C). The draft never writes to the row to create that link.

---

## 5. Export and `/render-reel`

### Where it runs
Nothing NSDS runs is a long-lived server: Pages is static, Apps Script can't run FFmpeg (6-minute
limit, no binaries), and the laptop is off-limits. So (builder's call):

```
reel.html ──POST──► Apps Script (validates, writes recipe to Drive, dispatches)
                         └──► GitHub Actions workflow_dispatch  (inputs: draft file id ONLY)
                                  └──► runner: rclone reads master + recipe, ffmpeg renders,
                                       uploads MP4 to completed_clips/, updates draft status
reel.html ──poll──► Apps Script reelStatus ──► draft JSON status
```

- **`/render-reel`** is literally reachable: Apps Script passes anything after `/exec` as
  `e.pathInfo`, so `POST <exec-url>/render-reel` routes to a `renderReel` handler. Also route
  `body.action === 'renderReel'` so it fits the existing client pattern (builder's call).
- The dispatch uses a **fine-grained GitHub token scoped to this repo, Actions: write only**, stored
  as a script property (new secret; one-time setup in `SETUP.md`). `workflow_dispatch` only sees
  workflows on the default branch (`main`).
- **Only the draft's Drive file id goes in the dispatch.** The runner reads the recipe from Drive.
  Never echo recipe contents, transcripts or tokens in the job.
- The same workflow file (or a sibling) runs the **first-draft** job (§6).
- Status is written back into the draft JSON by the runner; the page polls through Apps Script.

### Safe parameter extraction (decided requirement; specifics are builder's call)
`renderReel` accepts a JSON body (the existing client's format) and rejects anything not on an
allowlist — unknown keys are an error, not ignored:

| field | rule |
|---|---|
| `password` | `checkPassword`, as every other action |
| `draftId` | must be a Drive file id inside a show's `reel_drafts/` under `MEDIA_ROOT_ID` (`assertUnderMediaRoot`) |
| `rev` | must match the stored draft; otherwise `conflict` |
| `font` | exact match against the font list in §3 |
| `size`, `y`, `crop` | numbers, clamped to fixed ranges |
| `fill`, `highlight`, `outline` | `^#?[0-9A-Fa-f]{6}$` (highlight may be `null` = off) → converted to ASS colour |
| `breaks` | sorted unique integers within `[1, words.length)` |
| `words` | same count as stored; text ≤ 40 chars each, timings unchanged from the stored draft (text edits only) |
| `ranges` | each within the tape duration and within a bounded trim of the original row's ranges |

**Hex → ASS colour.** ASS/libass colours are `&HAABBGGRR&`, alpha first and *inverted* (00 =
opaque), then blue, green, red. So `#FFFF00` → `&H0000FFFF&`; brand yellow `#FFFF82` →
`&H0082FFFF&`. Validate first, then `'&H00' + b + g + r + '&'`, uppercase.

**Caption text is data, not markup.** In ASS, `{` opens an override block and `\N`/`\n`/`\h` are
escapes, so a word like `{\c&H0000FF&}` would restyle the render. Escape or strip `{`, `}` and `\` in
every word before it is written into the `.ass` file. Every external command is run with an argv
array, never a shell string.

### Render (builder's call on exact flags; these are the requirements)
1. Fetch the master **without downloading the whole tape** where possible (runner disk is
   ~14 GB free; tapes are many GB): e.g. `rclone serve http --read-only` on localhost and let
   ffmpeg seek with `-ss` before `-i`, or `rclone cat --offset/--count` around the ranges.
2. For each range: trim, crop `crop=ih*9/16:ih:x` where `x = (iw - ih*9/16) * crop` (decided
   expression, centred by default), scale to 1080×1920. Concatenate ranges as hard jump cuts, with
   a very short audio fade at each join to avoid clicks.
3. Remap word timings from tape time to output time (subtracting removed gaps).
4. Generate an `.ass` file from words + breaks + style: one Dialogue event per group spanning its
   words; for the current-word highlight, one event per word-interval with that word's colour
   overridden (not `\k` karaoke, which fills cumulatively — the mockup highlights only the current
   word). Alignment centred, vertical position from `y`, outline width scaled from size.
5. Burn captions with the `subtitles`/`ass` filter pointing `fontsdir` at the bundled font files.
6. Overlay the bug: `Icon.svg` rasterised to PNG (commit the PNG) at ~70% opacity, plus "A.U Tech
   Comedy Show" in Azeret Mono via `drawtext` (or baked into the PNG — builder's call), top-right
   with a margin clear of the platforms' top UI.
7. Encode: H.264 High, yuv420p, 1080×1920, source frame rate (29.97), AAC 48 kHz,
   `-movflags +faststart`.

### Output and versions (decided: versioned; naming is builder's call)
- Written to the show's `completed_clips/` as `<Performer> - <clip name> vN.mp4`, N = next unused.
  Never overwrite.
- The new link is **appended** to that row's column M, never replacing an editor's link (builder's
  call — M already holds multiple links and the card renders "Finished clip 1 / 2 ↗"). This is the
  first app write into a human-facing column; do it under `withLock`, re-locate the row inside the
  lock (by `clipId`, or the legacy row reference), and refuse if the row can't be found uniquely.
- The export is also recorded in the draft's `exports` list.

---

## 6. The first draft (engine)

Triggered the first time someone opens "Make reel" on a clip with no draft (builder's call; a
nightly sweep that pre-drafts new rows is a reasonable later addition). The page shows "drafting —
a few minutes" until it's ready.

1. **Ranges.** Start from the row: app rows use `ranges_json` (column I); legacy rows use B/C and
   column D, through the existing parse rules — additive sub-ranges become the ranges,
   `remove a-b` subtracts, free text is kept as a note. Respect every rule in *Rules that keep the
   sheet safe* (never re-derive B/C from D, bound by duration, etc.).
2. **Transcribe** just that audio (ranges plus a little padding) with **WhisperX** on CPU
   (`--device cpu --compute_type int8`; model size is builder's call — accuracy on noisy club audio
   matters more than speed, and only a minute or two of audio is processed). Cache the model between
   runs (`actions/cache`).
3. **Unalignable words.** WhisperX cannot time words with digits or symbols ("2014", "$13.60") —
   common in stand-up. Give them interpolated timings between neighbours and mark `aligned: false`.
4. **Mechanical notes.** `cut pauses` (and close variants) → remove gaps over a threshold between
   words, producing more ranges. Anything else in the notes is left for the person editing.
5. **Auto-grouping** — up to ~3 words or ~16 characters per group, always breaking on pauses
   ≥ 0.5 s and after sentence punctuation. People will regroup; it only needs to be a sane start.
6. Write the draft JSON, status `ready`.

---

## 7. Constraints

- No build step, plain ES modules, same as Tape Review. `reel.html` needs a real origin (the dev
  server), like the rest of `videoreview/`.
- `videoreview/dev-server.mjs` stands in for Apps Script locally; extend it to fake `renderReel`
  and draft storage so the editor works undeployed.
- Literals shared between `Code.gs` and the browser (font list, colour regex, ranges) must be
  byte-identical, enforced by `videoreview/test.mjs` the way existing shared literals are.
- Git: this repo belongs to the personal account — commits and pushes via `gituse personal`.
- Apps Script limits: 6-minute executions, ~50 MB responses, `LockService` for writes. The Apps Script
  side does no media work.
- Drive File Stream on the laptop is unreliable; nothing here should depend on it.

---

## 8. Engines considered

- **FFmpeg + libass** — crop, trim/concat, burned-in ASS captions, overlay. Covers all rendering.
- **WhisperX** (BSD-2) — Whisper transcription + wav2vec2 forced alignment for word timestamps;
  runs on CPU. Chosen (decided).
- **OpenMontage** — rejected. An agent-orchestrated system for *generating* videos (AI video/image
  providers, TTS, Remotion), AGPL-3.0. Wrong shape for cutting real footage, and heavy.
- YouTube auto-captions — rejected (decided): phrase-level timing, needs a new OAuth scope.
- Drive auto-captions — no API.

---

## 9. Left to the builder

Model size; exact FFmpeg flags and bitrate; how the master is streamed; the draft folder name and
legacy-row reference format; polling interval; the grouping heuristic's thresholds; whether the
bug text is drawn or baked; test strategy (at minimum: hex→ASS conversion, ASS escaping,
allowlist rejection, time remapping across cuts, grouping, and unaligned-word interpolation, all
in `test.mjs` style with real fixtures).
