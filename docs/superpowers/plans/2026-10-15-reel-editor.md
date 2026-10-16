# Reel Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a Tape Requests row into an editable 9:16 reel draft (WhisperX captions), edited in the browser and exported to a versioned MP4 in the show's `completed_clips/`.

**Architecture:** One pure ES module (`videoreview/reel.js`) holds every rule shared by the browser, the tests and the GitHub runner: fonts, hex→ASS colour, ASS escaping, grouping, caption timing, time remapping, the `.ass` file and the ffmpeg argv. Apps Script stores drafts as JSON in `<show>/reel_drafts/`, validates, and dispatches `.github/workflows/reel.yml` with only a draft file id. The runner (`tools/reel/*.mjs` + `transcribe.py`) reads the draft and master through rclone, writes results back to Drive. The editor is a full-screen `<dialog>` inside Tape Review (not a separate page — reuses the gate, API client and player).

**Tech Stack:** Plain ES modules, Apps Script (V8), Node 20 on ubuntu-latest, FFmpeg (apt, with libass + drawtext), rclone, WhisperX (Python 3.11, CPU int8), librsvg (`rsvg-convert`).

**Spec:** `docs/superpowers/specs/2026-10-15-reel-editor-design.md`

## Global Constraints

- No build step; browser code is ES modules served as-is (`videoreview/`).
- Output: 1080×1920, H.264 High, yuv420p, 29.97 fps (source rate), AAC 48 kHz, `-movflags +faststart`.
- Crop expression: `crop=ih*9/16:ih:x` with `x = (iw - ih*9/16) * crop`, `crop` ∈ [0,1], default 0.5.
- ASS colour: `&H00BBGGRR&`, uppercase hex. `#FFFF00` → `&H0000FFFF&`; `#FFFF82` → `&H0082FFFF&`.
- Fonts (id → file → ASS Fontname, read from each file's name ID 1):
  `bebas` BebasNeue-Regular.ttf "Bebas Neue" · `anton` Anton-Regular.ttf "Anton" ·
  `archivo` ArchivoBlack-Regular.ttf "Archivo Black" · `montserrat` Montserrat-ExtraBold.ttf
  "Montserrat Thin ExtraBold" · `azeret` AzeretMono-Bold.ttf "Azeret Mono Thin". ASS `Bold=0` for all
  (each family has one face; Bold=1 would synthesise).
- Bug text exactly `A.U` / `Tech Comedy Show`, Azeret Mono, ~70% opacity, top-right, with `media/brand/Icon.svg`.
- Defaults: font `bebas`, size 44 (preview px on a 300-px-wide frame; ×3.6 for 1080), y 58 (% of height), fill `#FFFFFF`, highlight `#FFFF82`, outline `#000000`, crop 0.5.
- Max 10 ranges, total ≤ 180 s; trims may move a range edge at most 5 s beyond the row's original span.
- Never put recipe contents, transcripts or tokens in workflow inputs or logs (public repo).
- Never write columns A–L; column M is append-only via rich text, under `withLock`.
- Exports never overwrite: `<Performer> - <m>m<ss> reel vN.mp4`, N = next unused in `completed_clips/`.
- Commits via `gituse personal`.

## Review Focus

1. A caption word containing `{`, `}` or `\` (e.g. a mis-hear like `{\b1}`) must render as literal text, not restyle — test in Task 1 (`assEscape`) and Task 2 (`buildAss`).
2. A word whose timing falls inside a removed gap (column-D cut or cut pauses) must not appear in the export or the preview — Task 1 `wordsInRanges`.
3. WhisperX words with no timing ("2014", "$13") must still get monotonic times — Task 1 `fillTimings`, including a leading and trailing unaligned word.
4. A render request whose `words` differ in count or timing from the stored draft must be refused, not re-timed — Task 3 `validateReelEdit` test.
5. A legacy row whose key no longer matches exactly one sheet row (someone edited it) must not get a link appended to the wrong row — Task 3 `appendExportLinkGs` refuses; covered by a test on `legacyKey` stability in Task 1.

---

### Task 1: `reel.js` — shared rules

**Files:**
- Create: `videoreview/reel.js`, `videoreview/fonts/*.ttf` (already downloaded, OFL), `videoreview/fonts/OFL.txt`
- Test: `videoreview/test.mjs` (new group `reel`)

**Interfaces — Produces:**
- `FONTS: {id, label, file, assName, css}[]` (order = dropdown order; `css` is the @font-face family `Reel <Label>`)
- `HEX_RE = /^#?[0-9A-Fa-f]{6}$/`
- `hexToAss(hex: string): string` — throws on invalid
- `assEscape(text: string): string` — libass has no escape for `\`, so replace `\`→`∖` (U+2216), `{`→`(`, `}`→`)`, and collapse whitespace.
- `fillTimings(words: {text, s?, e?}[]): {text, s, e, aligned}[]`
- `autoBreaks(words): number[]` — indices that start a group; rules: ≤3 words, ≤16 chars, break on gap ≥ 0.5 s, break after `.?!`
- `groups(words, breaks): number[][]`
- `wordsInRanges(words, ranges): boolean[]` — word kept iff its midpoint lies in a range
- `cutPauses(ranges, words, {gap = 0.6, pad = 0.15}): ranges` and `wantsCutPauses(notes: string): boolean` (`/\b(cut|remove|trim|tighten)\b[^.]*\bpauses?\b/i`)
- `toOutputTime(t, ranges): number|null`, `totalLength(ranges)`
- `captionSlices(words, breaks, keep?: boolean[]): {s, e, words: number[], active: number|null}[]` in tape time; a group shows from its first word's `s` until `min(next group s, last word e + 0.6)`; `active` = word with `s ≤ t < e + 0.02`
- `captionAt(slices, t): slice|null`
- `legacyKey(row: {name,start,end,granular}): string` — `'row-' + 8-hex FNV-1a` of `[name,start,end,granular].map(trim).join('|')`
- `DEFAULT_STYLE`, `clampStyle(style): style`

- [ ] **Step 1: Write failing tests** in `test.mjs`: `hexToAss('#FFFF00') === '&H0000FFFF&'`, `hexToAss('ffff82') === '&H0082FFFF&'`, throws on `'#FFF'`/`'red'`; `assEscape('{\\b1}hi')` contains no `{`, `}` or `\`; `fillTimings` with `[{text:'in',s:0,e:.2},{text:'2014'},{text:'we',s:1,e:1.2}]` gives `2014` s=.2 e=1 aligned:false, and leading/trailing unaligned words get ≥0.2 s slots and stay monotonic; `autoBreaks` on the mockup's 26-word fixture equals the mockup's auto result (`[3,6,9,...]` adjusted for the gap/punctuation rules — assert breaks at 4 (`engineer,` ends), 19 (0.7 s gap before `and`)); `wordsInRanges` drops a word inside a `remove` gap; `toOutputTime(195.2, [{s:158.4,e:176},{s:195.2,e:210}])` ≈ 17.6; `captionSlices` highlights exactly one word per slice and never shows a group before its first word; `legacyKey` stable across whitespace changes; `FONTS` files all exist on disk.
- [ ] **Step 2:** `node videoreview/test.mjs` → new cases FAIL (module missing).
- [ ] **Step 3:** Implement `videoreview/reel.js` with the signatures above.
- [ ] **Step 4:** `node videoreview/test.mjs` → all PASS.
- [ ] **Step 5:** Commit `feat(reel): shared caption/timing rules and fonts`.

### Task 2: `.ass` file and ffmpeg argv

**Files:** Modify `videoreview/reel.js`; Test `videoreview/test.mjs`

**Interfaces — Produces:**
- `buildAss(draft): string` — `PlayResX 1080`, `PlayResY 1920`, `WrapStyle 0`, one `Style: Reel` from `draft.style` (size×3.6, outline = size×3.6/14, MarginL/R 65, Alignment 5), one `Dialogue` per caption slice in **output** time with `{\pos(540,Y)}`, upper-cased escaped words, the active word wrapped in `{\c<hl>}…{\c<fill>}`
- `ffmpegArgs(draft, {input: string, ass: string, fontsDir: string, icon: string, out: string}): string[]` — one `-ss s -to e -i <input>` per range; filter graph: per range `crop`→`scale=1080:1920`→`setsar=1`, audio `afade` in/out 0.015 s; `concat=n=k:v=1:a=1`; `ass=<ass>:fontsdir=<fontsDir>`; icon overlay at `colorchannelmixer=aa=0.7`; two `drawtext` lines (fontfile AzeretMono-Bold.ttf, `alpha=0.7`, fontsize 31, white, shadow); encode per Global Constraints
- `nextVersionName(performer, firstStart, existingNames): string`

- [ ] **Step 1: Failing tests:** `buildAss` of a fixture has `PlayResY: 1920`, `Fontname` "Bebas Neue" in the Style line, `&H0082FFFF&` on the active word, no Dialogue starting before 0 or after `totalLength`, and a word `{x}` appears as `(X)`; `ffmpegArgs` contains exactly k `-i`, the string `crop=ih*9/16:ih:`, `scale=1080:1920`, `+faststart`, and never contains a shell metacharacter-joined string (it is an array); `nextVersionName('Pete', 158.4, ['Pete - 2m38 reel v1.mp4'])` → `'Pete - 2m38 reel v2.mp4'`.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS.
- [ ] **Step 5: Smoke render** (if an ffmpeg with libass is available): `node tools/reel/render.mjs --local <testsrc.mp4>` renders a 3-second clip; otherwise this is verified by the first CI run (Task 4).
- [ ] **Step 6:** Commit `feat(reel): ASS captions and ffmpeg graph`.

### Task 3: Apps Script — drafts, `/render-reel`, dispatch, column M

**Files:** Modify `videoreview/apps-script/Code.gs`; Test `videoreview/test.mjs` (literal parity + static checks)

**Interfaces — Produces (actions, all behind `checkPassword`):**
- `reelOpen {folderId, sheetId, showLabel, completedClipsFolderId, clipId?|row?, tape:{fileId,name,performer,youtubeId}, ranges, notes, granular}` → `{ok, draft}`; finds `<reel_drafts>/<key>.json` (key = `clipId` or `legacyKey(row)` computed server-side by `legacyKeyGs`), else creates it with `status:'drafting'` and dispatches `{job:'draft'}`. Validates ranges with the Global limits.
- `reelGet {draftId}` → `{ok, draft}`; if `status==='done'` and the newest export is unlinked, runs `appendExportLinkGs` first.
- `reelSave {draftId, rev, breaks, words(text only), style, ranges}` → `{ok, rev}`; `conflict` on rev mismatch.
- `renderReel` (also `POST …/exec/render-reel` via `e.pathInfo`) — `validateReelEditGs` (allowlist; unknown keys → error; font id ∈ FONT_IDS; colours `HEX_RE` → `hexToAssGs`; breaks sorted unique in range; words same count, text ≤ 40 chars, timings unchanged; ranges within ±5 s of `draft.source.span`; clamp size 18–96, y 30–85, crop 0–1) then saves, sets `status:'queued'`, dispatches `{job:'render'}`.
- `dispatchReelGs(job, draftFileId)` — `UrlFetchApp.fetch('https://api.github.com/repos/Desitrain22/nsds-site/actions/workflows/reel.yml/dispatches', {method:'post', headers:{Authorization:'Bearer '+GITHUB_DISPATCH_TOKEN, Accept:'application/vnd.github+json'}, payload: JSON.stringify({ref:'main', inputs:{job, draft: draftFileId}})})`; missing token → `{ok:false, error:'reel rendering is not set up yet (GITHUB_DISPATCH_TOKEN)'}`.
- `appendExportLinkGs(draft)` — under the existing lock; row by `findRowsByClipId` or by recomputing `legacyKeyGs` over rows; exactly one match or refuse; rebuilds M's `RichTextValue` keeping every existing link run and appending `\nReel vN` linked to the export.
- Literals `REEL_FONT_IDS`, `REEL_HEX_RE` byte-identical with `reel.js` (test enforces).

- [ ] **Step 1: Failing tests:** literal parity (`REEL_FONT_IDS` equals `FONTS.map(f=>f.id)` JSON; `REEL_HEX_RE` source equals `HEX_RE.source`); `hexToAssGs` and `legacyKeyGs` evaluated from the `.gs` text via `new Function` agree with `hexToAss`/`legacyKey` on fixtures; `validateReelEditGs` (extracted the same way) rejects an unknown key, a bad font, `#FFF`, changed word timing, an out-of-bounds trim, and accepts the fixture.
- [ ] **Step 2:** FAIL. **Step 3:** implement in `Code.gs`, route actions in `doPost`. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(reel): Apps Script draft store, render-reel route, dispatch`.

### Task 4: Runner — draft and render jobs

**Files:** Create `tools/reel/lib.mjs` (rclone helpers: `readDraft(id)`, `writeDraft(draft)`, `serveFolder(folderId) → {url, stop}`), `tools/reel/draft.mjs`, `tools/reel/render.mjs`, `tools/reel/transcribe.py`, `.github/workflows/reel.yml`

**Interfaces:** consumes Task 1/2 exports; draft JSON shape from spec §4 plus `source.span`, `master:{fileId,name,parentId}`, `folders:{drafts, completed}`.

- [ ] **draft.mjs:** read draft → ffmpeg extracts 16 kHz mono WAV of `span ± 5 s` from the served master → `python transcribe.py wav json` (whisperx `medium.en`, `cpu`, `int8`, align with English wav2vec2; prints nothing but counts) → offset times → `fillTimings` → apply `cutPauses` if `wantsCutPauses(notes)` → `autoBreaks` → status `ready` (re-read draft before writing; only touch `words`, `breaks`, `ranges`, `status`, `error`). Any failure → `status:'failed'`, `error` = first line of the message (no transcript).
- [ ] **render.mjs:** read draft → status `rendering` → serve master → write `.ass` (`buildAss`) → rasterise `media/brand/Icon.svg` with `rsvg-convert -w 86` → `ffmpeg …ffmpegArgs` → `rclone lsf` completed folder → `nextVersionName` → upload → append `{version, fileId, name, at, linked:false}` to `exports`, `status:'done'`. `--local <file>` flag renders a fixture without Drive (for Step 5 of Task 2).
- [ ] **reel.yml:** `workflow_dispatch` inputs `job` (draft|render) and `draft`; `concurrency: reel-${{ inputs.draft }}`; reuse youtube-sync's rclone env/secrets; `apt-get install ffmpeg librsvg2-bin`; for `draft`: `actions/setup-python` 3.11, pip cache, `pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu && pip install whisperx`, `actions/cache` on `~/.cache/huggingface` + `~/.cache/torch`; `timeout-minutes: 45`; never `set -x`.
- [ ] **Verify:** `node --check tools/reel/*.mjs`; `python3 -m py_compile tools/reel/transcribe.py`; YAML parses (`node -e` with a tiny parse or `ruby -ryaml`).
- [ ] Commit `feat(reel): GitHub runner for drafts and renders`.

### Task 5: Editor UI

**Files:** Create `videoreview/reel-editor.js`, `videoreview/reel.css`; Modify `videoreview/index.html` (dialog markup, stylesheet), `videoreview/app.js` ("Make reel" on clip cards + legacy rows), `videoreview/api.js` (`reelOpen`, `reelGet`, `reelSave`, `renderReel`)

**Interfaces:** `openReelEditor({api, show, tape, clip?, row?, ranges, notes, granular}): void` (exported from `reel-editor.js`).

- [ ] Layout and behaviour exactly per the mockup (`.superpowers/brainstorm/…/caption-editor.html`): phone frame with a second `Player` mounted inside, iframe scaled to fill height and shifted by the crop slider; captions painted from `captionSlices`/`captionAt` on `playRanges` `onProgress`; transcript seams toggle breaks; double-click edits text; style controls from `FONTS`/`DEFAULT_STYLE`; safe-zone overlay; crop slider; per-range trim inputs (±5 s bound); notes panel; Save draft (`reelSave`), Export MP4 (`renderReel`); status line polling `reelGet` every 5 s while `drafting|queued|rendering`; editing disabled while rendering; Esc/close pauses and unloads the player.
- [ ] `@font-face` for each `FONTS` entry from `fonts/<file>` so preview and export use the same files.
- [ ] Verify in the dev server (Task 6) by hand: open a clip, regroup, change font, export → status reaches done.
- [ ] Commit `feat(reel): caption editor in Tape Review`.

### Task 6: Dev server, docs, setup

**Files:** Modify `videoreview/dev-server.mjs`, `videoreview/README.md`, `videoreview/SETUP.md`, `INTEGRATIONS.md` (one paragraph)

- [ ] dev-server: `reelOpen/reelGet/reelSave/renderReel` backed by `.dev-reels.json`; `drafting` becomes `ready` after 2 s with words spread evenly over the ranges from a fixture sentence; `queued` → `done` after 3 s with a fake export. Uses `validateReel*` semantics from `reel.js` where shared.
- [ ] README section "Reels": what a draft is, the flow diagram, the font list, versioning, column M append rule. SETUP: create a fine-grained PAT (repo `Desitrain22/nsds-site`, Actions: read & write), save as script property `GITHUB_DISPATCH_TOKEN`; reel.yml uses the existing rclone secrets.
- [ ] `.gitignore`: `videoreview/.dev-reels.json`.
- [ ] `node videoreview/test.mjs` all PASS; dev server boots.
- [ ] Commit `docs(reel): setup and README`.
