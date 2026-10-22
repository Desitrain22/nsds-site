# Carousel Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Create carousel" button on every Tape Review request that drafts 4:5 Instagram slides (three face-framed stills per slide, one line of the bit on each), lets anyone with the passphrase edit them on the slide, and exports a versioned folder of 1080×1350 JPEGs into `completed_clips/`, linked from the request as "View carousel ↗".

**Architecture:** A sibling of the reel pipeline. Pure rules (pacing, framing, scoring, layout) live in `videoreview/carousel.js` and `videoreview/carousel-slide.js`, shared by the browser editor, the Apps Script backend (restated, byte-checked) and the GitHub runner. Drafts are stored like reels: a **Carousels** tab row + `<show>/carousel_drafts/<key>.json`, with preview frames in `<show>/carousel_drafts/<key>/`. Two new jobs on `reel.yml` (`carousel-draft`, `carousel-render`) run in the existing runner image; export composes each slide by rendering the *same* slide HTML in headless Chromium.

**Tech Stack:** Plain ES modules, no build step, no npm deps; Apps Script (`Code.gs`); Node 20 + ffmpeg + rclone + Python/OpenCV YuNet on GitHub Actions; headless Chromium for slide composition.

**Spec:** `docs/superpowers/specs/2026-10-22-carousel-editor-design.md` (read it, and the reel spec it builds on, before Task 1).

## Global Constraints

- Slide 1080×1350; panel 1080×450 (12:5), three per slide; at most 30 placed lines = 10 slides.
- Export: JPEG, sRGB, ffmpeg `-q:v 2` (≈ quality 95), named `01.jpg … NN.jpg`, in folder `<Performer> - <m>m<ss> carousel vN` in the show's `completed_clips/`; never overwrite.
- Column M gets **"Carousel vN"** linked to `https://drive.google.com/drive/folders/<id>`, appended under the existing rules (lock, re-locate row, never replace). Card label: "View carousel ↗".
- Caption fonts are exactly `FONTS` in `videoreview/reel.js`; default style `{ font: 'montserrat', size: 44, box: '#2E1A42', fg: '#FFFFFF' }`.
- Watermark on every slide, top-right, not draggable: `media/brand/Icon.svg` + "A.U" / "Tech Comedy Show" in Azeret Mono bold at 0.7 opacity, sized from reel.js `BUG` (icon 86, gap 22, font 31, line 35).
- Framing: box height = max(2.3 × face height, 450 master px), face centred horizontally, face centre at 42% from the box top, clamped inside the frame. Zoom range: `maxCropH/4 … maxCropH`.
- Default pacing: one sentence per line; >70 chars breaks at comma/semicolon, else the longest pause ≥ 0.5 s, else nearest the middle; then make the count a multiple of 3 (only while < 30).
- Candidate stills: 4 fps over the clip span + 3 s after it, previews 1280 px wide.
- Public repo: `workflow_dispatch` input is a draft file id only; scripts log counts/ids, never words. Nothing runs on the laptop. No new npm dependencies.
- Literals shared between `Code.gs` and `carousel.js` (`CAROUSEL_LIMITS`, `CAROUSEL_DEFAULT_STYLE`) must be byte-identical, enforced by `videoreview/test-carousel.mjs`.
- Commits: `gituse personal git commit …` on branch `carousel-editor`; end messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A one- or two-line bit** (a short tag) — expect one slide, the empty thirds filled with captionless reaction panels, exportable. Test: Task 1 `layout: a one-line clip is one slide with two fillers`.
2. **No performer face anywhere** (back-lit, wide shot, performer facing away) — expect centre-crop stills flagged `noFace`, never an empty panel or a crash. Test: Task 2 `defaultStills: no faces anywhere falls back to centre crops`.
3. **Caption text with HTML, quotes, emoji** (`</div><script>`, `“Crypto Andrew”`, 🙃) — expect it shown literally in editor and export. Test: Task 3 `slideHtml escapes caption text`.
4. **Words outside the request's ranges** (a `remove 1:02-1:10` cut, the 5 s transcript padding) — expect no line contains a cut word. Test: Task 1 `splitLines: words outside the ranges never appear`.
5. **A second open editor tab saving over the first** — expect `conflict`, not a silent overwrite. Test: Task 5 `carouselSave refuses a stale rev`.

---

## File Structure

| File | Responsibility |
|---|---|
| `videoreview/carousel.js` (new) | Pure rules: constants, pacing, line edits, layout, framing maths, frame scoring, still defaults, naming, link labels |
| `videoreview/carousel-slide.js` (new) | Pure slide markup: `SLIDE_CSS`, `slideHtml`, `imgBox`; used by the editor and the runner |
| `videoreview/test-carousel.mjs` (new) | Tests for both modules + the `Code.gs` carousel functions (via the `gsFn` pattern) |
| `videoreview/reel.js` (modify) | Export `BUG`; extract `performerFaces` from `followTrack`; `nextVersionName` gains `{ kind, ext }` |
| `videoreview/apps-script/Code.gs` (modify) | Carousels tab + bulk storage, user actions, runner actions, validation, dispatch, column M label |
| `tools/reel/lib.mjs`, `tools/reel/fail.mjs`, `tools/reel/draft.mjs` (modify) | `kind` param for backend calls; folder helpers; export `transcribeWav` |
| `tools/carousel/stills.py` (new) | YuNet faces + face sharpness for a directory of preview frames |
| `tools/carousel/draft.mjs` (new) | `carousel-draft` job |
| `tools/carousel/render.mjs` (new) | `carousel-render` job; exports `composeSlides` |
| `tools/carousel/check-render.mjs` (new) | CI: compose a fixture carousel without Drive |
| `.github/workflows/reel.yml`, `reel-check.yml`, `reel-image.yml`, `tools/reel/Dockerfile` (modify) | Jobs, Chromium, CI coverage |
| `videoreview/carousel-editor.js`, `videoreview/carousel.css` (new) | The editor dialog |
| `videoreview/index.html`, `app.js`, `api.js`, `dev-server.mjs`, `README.md` (modify) | Button, dialog markup, client calls, link labels, docs |

### Shared data shapes (used by every task)

```
Word    { text, s, e, aligned }                      tape seconds (reel shape)
Crop    { cx, cy, h }                                 fractions of the SOURCE frame: centre x, centre y, box height
Still   { t, crop: Crop, noFace?: true }              t = a frame time from the draft's frames
Line    { w: [i, j], text, cap: { x, y }, still: Still|null }   words[i..j), cap in % of the panel (caption's bottom-centre)
Filler  { text, cap, still }                          a reaction panel padding the last slide (no words)
Panel   { kind: 'line'|'filler', index, text, cap, still }
Frame   { t, fileId, score, face: { cx, cy, w, h }|null }
Style   { font, size, box, fg }                       font id from FONT_IDS; size in px at 1080
```

---

### Task 1: Pacing, line edits and layout (`carousel.js`, part 1)

**Files:**
- Create: `videoreview/carousel.js`, `videoreview/test-carousel.mjs`

**Interfaces:**
- Consumes: `wordsInRanges(words, ranges)` from `reel.js` (returns indices of words inside the ranges — check its exact return before use).
- Produces:
  - `export const SLIDE = { w: 1080, h: 1350 }`, `PANEL = { w: 1080, h: 450 }`, `PANEL_ASPECT = 2.4`, `FPS = 4`, `FRAMING = { k: 2.3, anchor: 0.42 }`, `DEFAULT_CAP = { x: 50, y: 94 }`
  - `export const CAROUSEL_LIMITS = { maxPlaced: 30, maxStored: 200, maxLineChars: 70, maxCaption: 120, pause: 0.5, size: [28, 72], capX: [10, 90], capY: [25, 100], zoom: 4, minPx: 450, maxFillers: 2 }` (one line — it is byte-checked against Code.gs)
  - `export const CAROUSEL_DEFAULT_STYLE = { font: 'montserrat', size: 44, box: '#2E1A42', fg: '#FFFFFF' }` (one line)
  - `lineText(words, w) -> string` (words joined by single spaces)
  - `lineWindow(words, line) -> { s, e }`
  - `splitLines(words, ranges) -> Line[]` (`still: null`, `cap: DEFAULT_CAP`)
  - `layout(lines, fillers = []) -> { slides: Panel[][], reserve: Line[], fillerCount }`
  - `splitLine(lines, words, i, offset) -> Line[]`, `joinLines(lines, words, i) -> Line[]`, `deleteLine(lines, i) -> Line[]`

- [ ] **Step 1: Write the failing tests** in `test-carousel.mjs`, using `test-reel.mjs`'s `eq/ok/near/group` helpers (copy them) and a builder that times sentences at 0.3 s per word with a 0.6 s gap between sentences:

```js
const mk = (...sentences) => { let t = 0; const out = []
  sentences.forEach(s => { s.split(' ').forEach(text => { out.push({ text, s: t, e: t + .3, aligned: true }); t += .3 }); t += .6 })
  return out }
const all = ws => [{ s: 0, e: ws[ws.length - 1].e }]
const texts = (ws, ls) => ls.map(l => lineText(ws, l.w))

group('splitLines')
const W7 = mk('I work in AI.', 'My mom asked for help.', 'With her printer.', 'I said no.', 'Wrong kind of AI.', 'She said all AI is printers.', "She's not wrong.")
eq('7 sentences -> 6 lines: the shortest adjacent pair (earliest on a tie) is joined', texts(W7, splitLines(W7, all(W7))),
  ['I work in AI.', 'My mom asked for help.', 'With her printer. I said no.', 'Wrong kind of AI.', 'She said all AI is printers.', "She's not wrong."])
const W5 = mk('One.', 'Two two.', 'This is the longest sentence, by far, in here.', 'Four.', 'Five five.')
eq('5 sentences -> 6 lines: the longest is split at the comma nearest its middle', texts(W5, splitLines(W5, all(W5))),
  ['One.', 'Two two.', 'This is the longest sentence,', 'by far, in here.', 'Four.', 'Five five.'])
const LONG = mk('So I finally got my standup into a pull request, and my manager approved it in four seconds flat.', 'Wow.', 'Ok.')
eq('a sentence over 70 chars breaks at its comma', texts(LONG, splitLines(LONG, all(LONG))).slice(0, 2),
  ['So I finally got my standup into a pull request,', 'and my manager approved it in four seconds flat.'])
// no comma: one 0.8 s pause after "standup" -> breaks there
const P = mk('So I finally got my standup into a pull request and my manager approved it in four seconds flat.', 'Wow.', 'Ok.', 'Fine.')
P.slice(6).forEach(w => { w.s += .8; w.e += .8 })
eq('no comma: breaks at the longest pause >= 0.5 s', lineText(P, splitLines(P, all(P))[0].w), 'So I finally got my standup')
ok('every line <= 70 chars, count % 3 === 0', [W7, W5, LONG].every(ws => { const ls = splitLines(ws, all(ws)); return ls.length % 3 === 0 && texts(ws, ls).every(t => t.length <= 70) }))
// Review Focus 4
const cut = splitLines(W7, [{ s: 0, e: W7[3].e }, { s: W7[9].s, e: W7[W7.length - 1].e }])
ok('splitLines: words outside the ranges never appear', cut.every(l => l.w[0] >= 9 || l.w[1] <= 4))

group('layout')
const lines = n => Array.from({ length: n }, (_, i) => ({ w: [i, i + 1], text: `l${i}`, cap: DEFAULT_CAP, still: null }))
eq('32 lines -> 10 slides, 2 in reserve, no fillers', [layout(lines(32)).slides.length, layout(lines(32)).reserve.length, layout(lines(32)).fillerCount], [10, 2, 0])
// Review Focus 1
const one = layout(lines(1))
eq('layout: a one-line clip is one slide with two fillers', [one.slides.length, one.slides[0].map(p => p.kind)], [1, ['line', 'filler', 'filler']])
eq('a stored filler is used as-is', layout(lines(2), [{ text: 'ha', cap: DEFAULT_CAP, still: null }]).slides[0][2].text, 'ha')

group('line edits')
const E = mk('I told my mom I work in AI.')
const el = [{ w: [0, 8], text: 'I told my mom I work in AI.', cap: DEFAULT_CAP, still: null }]
const sp = splitLine(el, E, 0, 'I told my mom'.length)
eq('split at the caret: text and words both split', [sp.map(l => l.text), sp.map(l => l.w)], [['I told my mom', 'I work in AI.'], [[0, 4], [4, 8]]])
eq('split of a one-word line is a no-op', splitLine([{ w: [0, 1], text: 'I', cap: DEFAULT_CAP, still: null }], E, 0, 0).length, 1)
eq('join: words concatenate, text joined with a space', joinLines(sp, E, 0)[0], { ...el[0], still: null })
eq('delete removes one line', deleteLine(sp, 0).map(l => l.text), ['I work in AI.'])
```

- [ ] **Step 2: Run** `node videoreview/test-carousel.mjs` — expected: fails to import `./carousel.js`.

- [ ] **Step 3: Implement** the exports in `videoreview/carousel.js`. Rules the tests don't fully pin:
  - Sentence ends: a word whose text ends in `.`, `?` or `!` (optionally followed by `"”’)`).
  - Break position for "nearest the middle": after word k, measured as `lineText` length through word k vs half the line's length; comma/semicolon candidates are words ending in `,` or `;`.
  - Multiple-of-3 pass (only when `0 < count < 30`): `count % 3 === 1` → join the adjacent pair with the shortest combined text (earliest on tie) if it is ≤ `maxCaption`, else split; `% 3 === 2` → split the longest line that has ≥ 2 words, else join. Stop when no move is possible.
  - `splitLine`'s word index: `w[0] + (number of whitespace-separated tokens before the caret)`, clamped to `[w[0]+1, w[1]-1]`; edited text is split at the caret, not re-derived from words. Both halves get `still: null`, the first keeps `cap`.
  - `joinLines` keeps the first line's `cap`, sets `still: null`.
  - A line is a contiguous run of *kept* words (those `wordsInRanges` returns). Sentences, splits and the multiple-of-3 joins never span a gap between ranges; a join that would is not a candidate.

- [ ] **Step 4: Run** `node videoreview/test-carousel.mjs` — expected: `0 failed`.

- [ ] **Step 5: Commit** — `gituse personal git add videoreview/carousel.js videoreview/test-carousel.mjs && gituse personal git commit -m "Carousel: default pacing, line edits and layout"`

---

### Task 2: Framing, scoring, stills and naming (`carousel.js`, part 2; `reel.js` refactors)

**Files:**
- Modify: `videoreview/carousel.js`, `videoreview/reel.js` (`followTrack` ~L342, `nextVersionName` ~L527, `BUG` ~L477), `videoreview/test-carousel.mjs`

**Interfaces:**
- Produces in `reel.js`:
  - `export const BUG` (unchanged values)
  - `export function performerFaces(samples, { minScore = 0.6, reach = 0.2, patience = 8 } = {}) -> (Face|null)[]` — the per-sample face `followTrack` picks today; `followTrack` now calls it (behaviour unchanged).
  - `nextVersionName(performer, firstStart, existing, { kind = 'reel', ext = '.mp4' } = {})`
- Produces in `carousel.js`:
  - `maxCropH(aspect) -> number` = `min(1, aspect / PANEL_ASPECT)`
  - `frameBox(face, aspect, srcH, { k, anchor, minPx } = {}) -> Crop` (face as fractions, like `track.py` output)
  - `clampCrop(crop, aspect) -> Crop`; `cropPixels(crop, srcW, srcH) -> { x, y, w, h }` (integers); `isSoft(crop, srcH) -> boolean`
  - `panCrop(crop, dx, dy, aspect) -> Crop` (dx/dy in panel px); `zoomCrop(crop, factor, px, py, aspect) -> Crop` (factor > 1 zooms in; px/py as 0–1 within the panel); `moveCap(cap, dx, dy) -> cap`
  - `scoreFrames(samples) -> Frame[]` — `samples = [{ t, fileId, faces: [{ cx, cy, w, h, score, sharp }] }]`
  - `rankCandidates(frames, win, { spacing = 0.5, limit = 6 } = {}) -> Frame[]`
  - `stillFor(frame, aspect, srcH) -> Still`; `defaultStills(lines, words, frames, aspect, srcH) -> Line[]`; `fillerWindow(words, placedLines) -> { s, e }` (3 s after the last placed line's end)
  - `nextCarouselName(performer, firstStart, existing) -> string` = `nextVersionName(…, { kind: 'carousel', ext: '' })`
  - `linkLabels(urls) -> string[]`

- [ ] **Step 1: Write the failing tests** (append; `near` = within 1e-4):

```js
group('framing')
const A = 1600 / 1020, face = { cx: (550.4 + 101.5) / 1600, cy: 259.5 / 1020, w: 203 / 1600, h: 264 / 1020 }
const fb = frameBox(face, A, 1020)
ok('the brainstorm spike photo frames as it did', near(fb.cx, .4554) && near(fb.cy, .30204) && near(fb.h, .59529))
ok('never below 450 master px', near(frameBox({ cx: .5, cy: .4, w: .03, h: 100 / 2160 }, 16 / 9, 2160).h, 450 / 2160))
ok('never more than covers the panel', near(frameBox({ cx: .5, cy: .5, w: .3, h: .5 }, 16 / 9, 1080).h, (16 / 9) / 2.4))
const cc = clampCrop({ cx: 0, cy: 0, h: 2 }, 16 / 9)
ok('clampCrop pulls a crop back inside', near(cc.h, .740741) && near(cc.cx, .5) && near(cc.cy, .37037))
eq('cropPixels of the full frame', cropPixels({ cx: .5, cy: .5, h: 1 }, 2400, 1000), { x: 0, y: 0, w: 2400, h: 1000 })
eq('isSoft at 216 px / 453.6 px', [isSoft({ h: .1 }, 2160), isSoft({ h: .21 }, 2160)], [true, false])
ok('dragging right by 10% of the panel shows more of the left', near(panCrop({ cx: .5, cy: .5, h: .5 }, 108, 0, 2.4).cx, .45))
ok('zoom 2x about the centre halves h', near(zoomCrop({ cx: .5, cy: .5, h: .6 }, 2, .5, .5, 2.4).h, .3))
ok('zoom stops at maxCropH / 4', near(zoomCrop({ cx: .5, cy: .5, h: .3 }, 10, .5, .5, 2.4).h, .25))
eq('moveCap clamps to the panel', moveCap({ x: 50, y: 94 }, 1080, 1000), { x: 90, y: 100 })

group('scoring and stills')
const f = (t, score, sharp, h = .2) => ({ t, fileId: `id${t}`, faces: [{ cx: .5, cy: .4, w: .1, h, score, sharp }] })
const sc = scoreFrames([f(0, .9, 300), f(.25, .9, 30), f(.5, .9, 300, .05), { t: .75, fileId: 'n', faces: [] }])
ok('sharper beats blurrier', sc[0].score > sc[1].score)
ok('a much smaller face than usual is penalised', sc[2].score < sc[0].score)
eq('no face -> score 0, face null', [sc[3].score, sc[3].face], [0, null])
const fr = [[0, .9], [.25, .95], [.5, .2], [.75, .8], [1, .7]].map(([t, score]) => ({ t, fileId: `i${t}`, score, face: { cx: .5, cy: .4, w: .1, h: .2 } }))
eq('candidates: best first, >= 0.5 s apart', rankCandidates(fr, { s: 0, e: 1 }).map(x => x.t), [.25, .75])
const WS = [['One', 0, .5], ['two.', .5, 1], ['Three', 1, 1.5], ['four.', 1.5, 2]].map(([text, s, e]) => ({ text, s, e, aligned: true }))
const two = [{ w: [0, 2], text: 'One two.', cap: DEFAULT_CAP, still: null }, { w: [2, 4], text: 'Three four.', cap: DEFAULT_CAP, still: null }]
const fc = { cx: .5, cy: .4, w: .1, h: .2 }
const shared = [{ t: .5, fileId: 'a', score: .4, face: fc }, { t: 1, fileId: 'b', score: .99, face: fc }, { t: 1.5, fileId: 'c', score: .5, face: fc }]
eq('the next line avoids the frame the line above took', defaultStills(two, WS, shared, 16 / 9, 2160).map(l => l.still.t), [1, 1.5])
// Review Focus 2
const blind = defaultStills(two, WS, [{ t: .1, fileId: 'z', score: 0, face: null }], 16 / 9, 2160)
ok('defaultStills: no faces anywhere falls back to centre crops', blind.every(l => l.still.noFace && near(l.still.crop.h, (16 / 9) / 2.4) && l.still.t === .1))

group('naming and links')
eq('carousel versions count only carousel folders', nextCarouselName('Kaz', 158, ['Kaz - 2m38 carousel v1', 'Kaz - 2m38 reel v3.mp4']), 'Kaz - 2m38 carousel v2')
eq('reel naming unchanged', nextVersionName('Kaz', 158, ['Kaz - 2m38 reel v3.mp4']), 'Kaz - 2m38 reel v4.mp4')
eq('folder links are carousels', linkLabels(['https://drive.google.com/file/d/a/view', 'https://drive.google.com/file/d/b/view', 'https://drive.google.com/drive/folders/c']),
  ['Finished clip 1 ↗', 'Finished clip 2 ↗', 'View carousel ↗'])
eq('a single file keeps today\'s label', linkLabels(['https://drive.google.com/file/d/a/view']), ['Finished clip ↗'])
```

- [ ] **Step 2: Run** `node videoreview/test-carousel.mjs` — expected: the new groups fail (missing exports).

- [ ] **Step 3: Refactor `reel.js`**: export `BUG`; move the face-picking loop out of `followTrack` into `performerFaces` (returns the picked face object per sample, or null) and have `followTrack` map it to `cx`; add the options object to `nextVersionName` so the base is `` `${who} - ${m}m${ss} ${kind}` `` and versions match `^ v(\d+)${escaped ext}$`.

- [ ] **Step 4: Run** `node videoreview/test-reel.mjs` — expected: still `0 failed` (refactor only).

- [ ] **Step 5: Implement the `carousel.js` exports.** Score: performer face from `performerFaces`; `score = clamp(0.4·face.score + 0.6·min(1, face.sharp / 300) − (face.h < 0.6 × median performer face h ? 0.3 : 0), [0, 1])`, 0 with `face: null` when no performer face (weights are tunable; keep them as named constants). `defaultStills` fills only `still === null` lines: top of `rankCandidates(frames, lineWindow)` skipping the previous line's `t` (windows are inclusive at both ends); no face frame in the window → `stillFor` of the time-nearest frame of any kind (`noFace: true`, centre crop at `maxCropH`); no frames at all → leaves `null`. `zoomCrop` keeps the point under the pointer fixed, then `clampCrop`.

- [ ] **Step 6: Run** both test files — expected: `0 failed` each.

- [ ] **Step 7: Commit** — `"Carousel: face framing, still scoring and naming; reel.js shares performerFaces"`

---

### Task 3: Slide markup (`carousel-slide.js`)

**Files:**
- Create: `videoreview/carousel-slide.js`; Modify: `videoreview/test-carousel.mjs`

**Interfaces:**
- Consumes: `SLIDE`, `PANEL`, `PANEL_ASPECT` (Task 1); `BUG`, `FONTS`, `fontById` (reel.js).
- Produces:
  - `export const SLIDE_CSS` — the stylesheet, scoped under `.cz-slide`, sized in px for a 1080×1350 slide (the editor shows it with `transform: scale()`).
  - `export function imgBox(crop, aspect) -> { width, left, top }` — percentages of the panel for an `<img>` showing a whole source frame: `cw = crop.h·2.4/aspect`, `width = 100/cw`, `left = −(cx − cw/2)/cw·100`, `top = −(cy − h/2)/h·100`.
  - `export function slideHtml(panels, style, { images, fonts }) -> string` — `panels` is one `layout()` slide; `images[i]` is `{ src, crop, aspect }` (editor: whole preview frame + crop) or `{ src }` (export: pre-cropped 1080×450); `fonts = { caption: url, bug: url, icon: url }`. Markup: `<div class="cz-slide">` → three `<div class="cz-panel" data-i>` each with `<img>` and, if `text` is non-empty, `<div class="cz-cap"><span>…</span></div>` at `left: cap.x%; top: cap.y%`; then `<div class="cz-bug">`.

- [ ] **Step 1: Write the failing tests:**

```js
group('slide markup')
eq('imgBox of a full-frame crop', imgBox({ cx: .5, cy: .5, h: 1 }, 2.4), { width: 100, left: 0, top: 0 })
const ib = imgBox({ cx: .5, cy: .5, h: .5 }, 2.4)
ok('imgBox of a 2x crop doubles and centres', near(ib.width, 200) && near(ib.left, -50) && near(ib.top, -50))
const P3 = [{ kind: 'line', index: 0, text: '</div><script>alert(1)</script> “Crypto Andrew” 🙃', cap: { x: 50, y: 94 }, still: null },
  { kind: 'line', index: 1, text: 'b', cap: { x: 30, y: 60 }, still: null }, { kind: 'filler', index: 0, text: '', cap: { x: 50, y: 94 }, still: null }]
const html = slideHtml(P3, CAROUSEL_DEFAULT_STYLE, { images: [{ src: 'a.jpg' }, { src: 'b.jpg' }, { src: 'c.jpg' }], fonts: { caption: 'c.ttf', bug: 'b.ttf', icon: 'i.svg' } })
// Review Focus 3
ok('slideHtml escapes caption text', !html.includes('<script>') && html.includes('&lt;/div&gt;&lt;script&gt;') && html.includes('“Crypto Andrew” 🙃'))
eq('three panels, two captions (the empty filler has none), one bug',
  [(html.match(/class="cz-panel"/g) || []).length, (html.match(/class="cz-cap"/g) || []).length, (html.match(/class="cz-bug"/g) || []).length], [3, 2, 1])
ok('the bug reads A.U / Tech Comedy Show', html.includes('A.U<br>Tech Comedy Show'))
ok('the caption sits where it was dragged', html.includes('left:30%') && html.includes('top:60%'))
ok('style colours are applied', html.includes('#2E1A42') && html.includes('#FFFFFF'))
ok('SLIDE_CSS rounds each wrapped line and balances wrapping', /box-decoration-break:\s*clone/.test(SLIDE_CSS) && /text-wrap:\s*balance/.test(SLIDE_CSS) && /border-radius:\s*999px/.test(SLIDE_CSS))
```

- [ ] **Step 2: Run** — expected: import of `./carousel-slide.js` fails.
- [ ] **Step 3: Implement.** Inline positions are written exactly as `left:${x}%;top:${y}%` (no spaces), colours verbatim. Escape `& < > " '` for text and attribute values; colours pass through only if they match `HEX_RE`, else the default. Caption: `transform: translate(-50%, -100%)`, `max-width: 90%`, `line-height: 1.32`, span padding `.1em .6em`, `font-size: style.size px`, family from the `@font-face` built from `fonts.caption`. Bug: `top: 36px; right: 36px`, sizes from `BUG`, opacity `BUG.opacity`.
- [ ] **Step 4: Run** — expected: `0 failed`.
- [ ] **Step 5: Commit** — `"Carousel: one slide markup for the editor and the export"`

---

### Task 4: Backend storage, open/get/frame and runner actions (`Code.gs`)

**Files:**
- Modify: `videoreview/apps-script/Code.gs` (constants next to the `REEL_*` block ~L2207; routing ~L120–210), `videoreview/test-carousel.mjs`

**Interfaces:**
- Consumes: `reelRowGs`, `legacyKeyGs`, `validateRangesGs`, `ensureChildFolder`, `assertUnderMediaRoot`, `dispatchReelGs`, `reelBusyGs`, `withLock`, `checkRunner`.
- Produces (Gs):
  - `var CAROUSEL_LIMITS = …;` and `var CAROUSEL_DEFAULT_STYLE = …;` — byte-identical to `carousel.js`
  - `var CAROUSEL_TAB = 'Carousels'`, `CAROUSEL_DRAFTS_FOLDER = 'carousel_drafts'`, `CAROUSEL_STEPS = ['tape', 'captions', 'stills']`
  - `CAROUSEL_HEADERS = ['Request', 'Status', 'Latest export', 'Version', 'Updated', 'key', 'rev', 'error', 'style_json', 'lines_json', 'fillers_json', 'exports_json', 'data_file']`
  - `CAROUSEL_BULK = ['v', 'key', 'createdAt', 'show', 'source', 'tape', 'master', 'folders', 'words', 'frames', 'dims', 'progress']`
  - `carouselTabGs(show)`, `readCarouselGs(file)`, `writeCarouselGs(file, draft)`, `carouselFileGs(draftId)` — mirrors of the reel four (copy-adapt; do not refactor the reel ones)
  - `mergeProgressGs(prev, p, steps)` — gains `steps` (default `REEL_STEPS`)
  - `carouselOpen(body)` — same body as `reelOpen`; creates `carousel_drafts/<key>.json` and folder `carousel_drafts/<key>/` (`folders: { drafts, frames, completed }`); copies `words` from `reel_drafts/<key>.json` when it has any (then `progress.captions = 'done'`); dispatches `dispatchReelGs('carousel-draft', id)`
  - `carouselGet(body)` — as `reelGet` (appends a pending export's link under the lock; see Task 5 for the label)
  - `carouselFrame(body) -> { ok, mime: 'image/jpeg', data: base64 }` — `body.fileId` must be the `fileId` of one of `draft.frames`
  - `carouselJobGet(body)`, `carouselJobPut(body)` — patch fields: `status` (same states as reels), `error`, `progress`, `words` (reel rules), `frames` (≤ 5000; `t` number, `fileId` `^[\w-]{20,80}$`, `score` number, `face` null or four numbers), `dims` `{ w, h }` positive integers, `lines` (validated with `validateLinesGs`, Task 5), `export` (Task 5). Apply `frames`/`dims` before `lines`.
  - Routing: user actions `carouselOpen` (lock), `carouselGet`, `carouselFrame`; runner prefix becomes `/^(reel|carousel)Job/`.

- [ ] **Step 1: Write the failing tests** (a `gsFn` like test-reel's, matching `/var (REEL|CAROUSEL)_[A-Z_]+ = .*?;/g`):

```js
group('Code.gs carousel literals and storage')
const carSrc = readFileSync(new URL('./carousel.js', import.meta.url), 'utf8')
eq('CAROUSEL_LIMITS', (gs.match(/var CAROUSEL_LIMITS = (\{.*?\});/) || [])[1], (carSrc.match(/export const CAROUSEL_LIMITS = (\{.*?\})/) || [])[1])
eq('CAROUSEL_DEFAULT_STYLE', (gs.match(/var CAROUSEL_DEFAULT_STYLE = (\{.*?\});/) || [])[1], (carSrc.match(/export const CAROUSEL_DEFAULT_STYLE = (\{.*?\})/) || [])[1])
const M = gsFn('mergeProgressGs')
eq('stills is a carousel step', M.mergeProgressGs({ tape: 'done' }, { stills: 'running', tracking: 'done' }, ['tape', 'captions', 'stills']), { tape: 'done', stills: 'running' })
eq('reels unchanged', M.mergeProgressGs({}, { tracking: 'done', stills: 'x' }), { tracking: 'done' })
ok('runner prefix routes carousel jobs', /\^\(reel\|carousel\)Job/.test(gs))
for (const a of ['carouselOpen', 'carouselGet', 'carouselFrame', 'carouselSave', 'renderCarousel']) ok(`routes ${a}`, gs.includes(`action === '${a}'`))
```

- [ ] **Step 2: Run** — expected: FAIL on the literals and routes.
- [ ] **Step 3: Implement** the Gs above. `carouselFrame`: `assertUnderMediaRoot` on the file's parent, `Utilities.base64Encode(file.getBlob().getBytes())`. The `carouselSave`/`renderCarousel` routes may point at a stub returning `{ ok: false, error: 'not yet' }` until Task 5.
- [ ] **Step 4: Run** — expected: `0 failed`; also `node videoreview/test-reel.mjs` and `node videoreview/test.mjs` stay green.
- [ ] **Step 5: Commit** — `"Backend: carousel drafts — Carousels tab, open/get/frame, runner door"`

---

### Task 5: Backend save, validation, export link (`Code.gs`)

**Files:**
- Modify: `videoreview/apps-script/Code.gs`, `videoreview/test-carousel.mjs`

**Interfaces:**
- Produces (Gs):
  - `maxCropHGs(aspect)`, `clampCropGs(crop, aspect)` — same results as the JS versions
  - `validateLinesGs(lines, words, frameTimes, aspect) -> { ok, lines } | { ok: false, error }` — array ≤ `maxStored`; each exactly `{ w, text, cap, still }`; `w` integer pair, `0 ≤ i < j ≤ words.length`, lines in order and non-overlapping; `text` string ≤ `maxCaption` (may be empty); `cap` numbers clamped to `capX`/`capY`; `still` null or exactly `{ t, crop }` (+ optional `noFace: true`) with `t` in `frameTimes`, crop clamped
  - `validateCarouselEditGs(edit, stored) -> { ok, lines, fillers, style } | { ok: false, error }` — keys exactly `lines, fillers, style`; `fillers` ≤ `maxFillers`, each `{ text, cap, still }` with the line rules; `style` keys exactly `font, size, box, fg`, font in `REEL_FONT_IDS`, size clamped, colours by `REEL_HEX_RE`
  - `carouselSave(body, render)` — as `reelSave` (busy → refuse; `rev` mismatch → `{ ok: false, error: 'conflict', conflict: true, currentRev }`); with `render`: every placed panel (first `maxPlaced` lines + the fillers `layout` would add) must have a still, else `{ ok: false, error: 'pick a still for every panel' }`; then status `queued` and `dispatchReelGs('carousel-render', id)`
  - `appendExportLinkGs(draft, exp, label)` — `label` defaults to `'Reel v' + exp.version`; carousels pass `'Carousel v' + exp.version`
  - `carouselJobPut` `export`: `{ version, name, folderId, soft: int[] }` → `url = 'https://drive.google.com/drive/folders/' + folderId`, appended + linked as reels do

- [ ] **Step 1: Write the failing tests:**

```js
group('Code.gs carousel validation')
const C = gsFn('maxCropHGs', 'clampCropGs', 'validateLinesGs', 'validateCarouselEditGs')
for (const [c, a] of [[{ cx: 0, cy: 0, h: 2 }, 16 / 9], [{ cx: .9, cy: .1, h: .3 }, 2.4], [{ cx: .5, cy: .5, h: .01 }, 16 / 9]])
  eq(`clampCropGs === clampCrop ${JSON.stringify(c)}`, C.clampCropGs(c, a), clampCrop(c, a))
const sw = mk('One two.', 'Three four.')
const stored = { words: sw, frames: [{ t: .6 }, { t: .9 }], dims: { w: 3840, h: 2160 }, lines: [], fillers: [], style: CAROUSEL_DEFAULT_STYLE }
const okLines = [{ w: [0, 2], text: 'One two.', cap: { x: 50, y: 94 }, still: { t: .6, crop: { cx: .5, cy: .4, h: .3 } } },
  { w: [2, 4], text: '', cap: { x: 50, y: 94 }, still: null }]
const edit = { lines: okLines, fillers: [], style: CAROUSEL_DEFAULT_STYLE }
ok('a normal edit passes (an empty caption is allowed)', C.validateCarouselEditGs(edit, stored).ok)
const no = (label, e) => ok(label, C.validateCarouselEditGs(e, stored).ok === false)
no('unknown key', { ...edit, html: '<b>' })
no('unknown line key', { ...edit, lines: [{ ...okLines[0], onclick: 'x' }] })
no('overlapping lines', { ...edit, lines: [okLines[0], { ...okLines[1], w: [1, 4] }] })
no('a still at a time the draft never offered', { ...edit, lines: [{ ...okLines[0], still: { t: .61, crop: okLines[0].still.crop } }, okLines[1]] })
no('caption over 120 chars', { ...edit, lines: [{ ...okLines[0], text: 'x'.repeat(121) }] })
no('font not on the list', { ...edit, style: { ...CAROUSEL_DEFAULT_STYLE, font: 'Comic Sans' } })
no('3-digit colour', { ...edit, style: { ...CAROUSEL_DEFAULT_STYLE, box: '#FFF' } })
no('three fillers', { ...edit, fillers: [1, 2, 3].map(() => ({ text: '', cap: { x: 50, y: 94 }, still: null })) })
eq('a caption dragged off the panel is clamped back', C.validateCarouselEditGs({ ...edit, lines: [{ ...okLines[0], cap: { x: 3, y: 200 } }, okLines[1]] }, stored).lines[0].cap, { x: 10, y: 100 })
// Review Focus 5
const S = gsFn('carouselSave')   // with readCarouselGs/carouselFileGs/writeCarouselGs/dispatchReelGs stubbed in the harness
ok('carouselSave refuses a stale rev', /* harness: stored rev 3, body.rev 2 */ S.carouselSave({ draftId: 'x', rev: 2, edit }, false).conflict === true)
ok('the column M label is a parameter', /function appendExportLinkGs\(draft, exp, label\)/.test(gs))
```

For the stale-rev test, build `S` with `new Function` the same way as `gsFn` but prepend stubs: `readCarouselGs = () => ({ ...stored, status: 'ready', rev: 3 })`, `carouselFileGs = () => ({})`, `writeCarouselGs = () => {}`, `reelBusyGs = d => false`, `dispatchReelGs = () => ({ ok: true })`.

- [ ] **Step 2: Run** — expected: FAIL.
- [ ] **Step 3: Implement** the Gs functions; replace the Task 4 stub routes. Keep `appendExportLinkGs`'s reel callers passing nothing (default label).
- [ ] **Step 4: Run** all three test files — expected: `0 failed` each.
- [ ] **Step 5: Commit** — `"Backend: carousel save, validation, export and the Carousel vN link"`

---

### Task 6: The `carousel-draft` job

**Files:**
- Modify: `tools/reel/lib.mjs`, `tools/reel/fail.mjs`, `tools/reel/draft.mjs`
- Create: `tools/carousel/stills.py`, `tools/carousel/draft.mjs`

**Interfaces:**
- Consumes: Task 1–2 exports; `serveMaster`, `run`, `FFMPEG`, `workdir`, `shortError`.
- Produces:
  - `lib.mjs`: `readDraft(id, kind = 'reel')` and `patchDraft(draft, patch, kind = 'reel')` call `${kind}JobGet` / `${kind}JobPut`; `listFolders(folderId) -> string[]` (`lsf --dirs-only`, trailing `/` stripped); `uploadDir(localDir, parentId, name) -> folderId`; `replaceFolderFiles(localDir, folderId) -> { [name]: fileId }` (clears the folder's files, copies, then `lsjson`)
  - `fail.mjs <draftId> [kind]` — passes `kind` through
  - `draft.mjs`: `export async function transcribeWav(wav, from) -> Word[]` (the existing transcribe + `fillTimings` code, moved out of `buildDraft`, which now calls it)
  - `stills.py <frames_dir> <out.json>` → `{"aspect": w/h, "samples": [{"file": "f00001.jpg", "faces": [{"cx","cy","w","h","score","sharp"}]}]}`, files in name order; `sharp` = variance of the Laplacian of the grayscale face box; same YuNet model and thresholds as `track.py`
  - `tools/carousel/draft.mjs <draftId>`: progress `tape → captions → stills`; one ffmpeg read of `[span.s − 5, span.e + 5]` giving the WAV (only if the draft has no words) and `-vf fps=4,scale=1280:-2 -q:v 3 f%05d.jpg` over `[span.s, span.e + 3]`; `ffprobe` the master's `dims`; frame `t = span.s + (n − 1) / FPS`; `scoreFrames` → `replaceFolderFiles(…, draft.folders.frames)` → `fileId`s; `lines = defaultStills(splitLines(words, draft.ranges), …)`; `patchDraft(draft, { status: 'ready', words?, frames, dims, lines }, 'carousel')`. On error: `failed` + `shortError`, exit 1. Logs counts only.

- [ ] **Step 1: Write the check.** The pure parts are already tested; this job's new risk is `stills.py`, so extend `.github/workflows/reel-check.yml` with a step that proves it on a real face:

```yaml
      - name: Stills on a real stage photo
        run: |
          pip install -q opencv-python-headless==5.0.0.93
          mkdir -p "$RUNNER_TEMP/stills"
          ffmpeg -hide_banner -loglevel error -loop 1 -i media/opt/AustinStage-1600.jpg -t 1 -vf fps=4,scale=1280:-2 -q:v 3 "$RUNNER_TEMP/stills/f%05d.jpg"
          python3 tools/carousel/stills.py "$RUNNER_TEMP/stills" "$RUNNER_TEMP/stills.json"
          python3 -c "import json,sys; d=json.load(open(sys.argv[1])); s=d['samples']; assert len(s)==4 and all(x['faces'] and x['faces'][0]['sharp']>0 for x in s), s; print('stills ok')" "$RUNNER_TEMP/stills.json"
```

- [ ] **Step 2: Run it locally** in a scratch venv (`python3 -m venv /tmp/cv && /tmp/cv/bin/pip install opencv-python-headless==5.0.0.93`), the same three commands with `/tmp/cv/bin/python3` — expected: fails (no `stills.py`).
- [ ] **Step 3: Implement** `stills.py`, the `lib.mjs`/`fail.mjs`/`draft.mjs` changes, and `tools/carousel/draft.mjs`.
- [ ] **Step 4: Run** the stills check again — expected: `stills ok`. Run `node videoreview/test-reel.mjs` — expected: `0 failed`. Run `node --check tools/carousel/draft.mjs`.
- [ ] **Step 5: Commit** — `"Runner: carousel-draft job — candidate stills from the master, scored on the face"`

---

### Task 7: The `carousel-render` job, image and workflows

**Files:**
- Create: `tools/carousel/render.mjs`, `tools/carousel/check-render.mjs`
- Modify: `.github/workflows/reel.yml`, `.github/workflows/reel-check.yml`, `.github/workflows/reel-image.yml`, `tools/reel/Dockerfile`

**Interfaces:**
- Consumes: `layout`, `cropPixels`, `isSoft`, `nextCarouselName` (Tasks 1–2); `slideHtml` (Task 3); `listFolders`, `uploadDir`, `serveMaster` (Task 6).
- Produces:
  - `export async function composeSlides(slides, style, panelPngs, outDir) -> string[]` — for slide `k`, writes `slide-k.html` (`slideHtml` with `images = { src: file:// panel png }`, fonts as `data:` URLs read from `videoreview/fonts/` and `media/brand/Icon.svg`), screenshots it with `${NSDS_CHROMIUM || 'chromium'} --headless=new --no-sandbox --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --allow-file-access-from-files --virtual-time-budget=5000 --window-size=1080,1350 --screenshot=<png> file://<html>`, converts with ffmpeg `-q:v 2` to `NN.jpg` (two digits), returns the JPEG paths.
  - `render.mjs <draftId>`: status must be `queued`/`rendering`; `patchDraft({ status: 'rendering' }, 'carousel')`; for each placed panel, `ffmpeg -ss <t> -i <master url> -frames:v 1 -vf crop=w:h:x:y,scale=1080:450:flags=lanczos` with `cropPixels(still.crop, dims.w, dims.h)`; `soft` = indices where `isSoft`; `composeSlides`; `name = nextCarouselName(performer, ranges[0].s, await listFolders(completed))`; `uploadDir`; `patchDraft({ status: 'done', export: { version, name, folderId, soft } }, 'carousel')`.
  - `check-render.mjs <photo> <outdir>`: a fixed 2-slide fixture (4 lines + 2 fillers, one caption dragged off-default, one empty) with every panel cropped from `<photo>` by `cropPixels`, through `composeSlides`.

- [ ] **Step 1: Write the check** in `reel-check.yml` (ubuntu-latest has Google Chrome preinstalled):

```yaml
      - name: Compose a fixture carousel
        env:
          NSDS_CHROMIUM: google-chrome
        run: |
          node videoreview/test-carousel.mjs
          node tools/carousel/check-render.mjs media/opt/AustinStage-1600.jpg "$RUNNER_TEMP/carousel"
          for f in 01 02; do
            size=$(ffprobe -v error -show_entries stream=width,height -of csv=p=0 "$RUNNER_TEMP/carousel/$f.jpg")
            [ "$size" = "1080,1350" ] || { echo "::error::$f.jpg is $size, expected 1080x1350"; exit 1; }
          done
          [ ! -e "$RUNNER_TEMP/carousel/03.jpg" ] || { echo "::error::expected exactly 2 slides"; exit 1; }
```

  Add `videoreview/carousel*.js`, `videoreview/test-carousel.mjs`, `tools/carousel/**` to its path filters.

- [ ] **Step 2: Run locally** — `NSDS_CHROMIUM="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node tools/carousel/check-render.mjs media/opt/AustinStage-1600.jpg /tmp/car` — expected: fails (no module).
- [ ] **Step 3: Implement** `render.mjs` and `check-render.mjs`.
- [ ] **Step 4: Run** the local command again, then open `/tmp/car/01.jpg` and check by eye against mockup v3: three equal panels, purple round-ended caption boxes, watermark top-right, the empty filler has no caption, the dragged caption moved. `ffprobe` both files: `1080,1350`.
- [ ] **Step 5: Wire the workflow and image.** `reel.yml`: `job` options `[draft, render, carousel-draft, carousel-render]`; steps `node tools/carousel/draft.mjs "$DRAFT"` / `node tools/carousel/render.mjs "$DRAFT"` gated on `inputs.job`; the fail step passes `carousel` as `kind` when `startsWith(inputs.job, 'carousel')`. `Dockerfile`: add `chromium fonts-noto-color-emoji` to the apt line and `ENV NSDS_CHROMIUM=chromium`; label description mentions carousels. `reel-image.yml`: also trigger on `tools/carousel/**`.
- [ ] **Step 6: Run** `node videoreview/test-carousel.mjs`, `node videoreview/test-reel.mjs` — expected: `0 failed`.
- [ ] **Step 7: Commit** — `"Runner: carousel-render job — the editor's slide markup, rendered from the 4K master"`

---

### Task 8: The carousel editor

**Files:**
- Create: `videoreview/carousel-editor.js`, `videoreview/carousel.css`
- Modify: `videoreview/index.html` (new `<dialog id="carousel">` beside `#reel`, stylesheet link), `videoreview/api.js`

**Interfaces:**
- Consumes: everything in Tasks 1–3; `FONTS` from reel.js; the reel editor's pending-screen pattern (`renderPending`, `poll` in `reel-editor.js`).
- Produces:
  - `api.js`: `carouselOpen(show, opts)` (same body and retry rules as `reelOpen`), `carouselGet(draftId)`, `carouselSave(draftId, rev, edit)`, `renderCarousel(draftId, rev, edit)` (no retries), `carouselFrame(draftId, fileId)`.
  - `export async function openCarouselEditor(opts)` — `opts` exactly as `openReelEditor`'s (`{ api, show, tape, clip?, row?, ranges, notes, granular, onClose? }`).

Behaviour (spec §4, mockup v3 at `.superpowers/brainstorm/81239-1792653145/content/carousel-editor-v3.html`):
- Pending screen "Making your carousel" with steps tape / captions / stills, polling `carouselGet` every 5 s, retry on failure — as the reel editor.
- The slide is `slideHtml` at 1080×1350 inside a wrapper scaled to fit (≈ 0.4); all pointer deltas divide by that scale. Images come from `carouselFrame` as data URLs, cached by `fileId`, fetched only for the visible slide and the selected panel's strip.
- Double-click a caption → `contenteditable` span; Enter/Escape/blur commits to `line.text` (or filler text). Drag a caption → `moveCap`. Drag a photo → `panCrop`; wheel/pinch → `zoomCrop`. Capture the pointer only after 4 px of movement so double-click reaches the caption.
- On load and after every reflow, any placed line or filler with `still: null` gets its default (`defaultStills`; fillers: top of `rankCandidates(frames, fillerWindow(words, placed))`), so Export never meets an empty panel.
- Click a panel → selected (yellow outline); side card shows `rankCandidates(frames, window)` (filler: `fillerWindow`) with the current still marked, and "Show all" for every face frame in the window; choosing one sets `still = stillFor(frame, dims.w / dims.h, dims.h)`.
- Line controls on the selected line: Split at caret (enabled while editing), Join with next, Delete, Clear caption; after each, `defaultStills` fills the new nulls and slides reflow via `layout`.
- Reserve lines listed under the slide thumbnails with the "N more lines didn't fit in 10 slides" note.
- **soft** badge on a panel where `isSoft(still.crop, dims.h)`; **no face** badge where `still.noFace`.
- Caption style card: font (the five), box swatches `#2E1A42/#FFFFFF`, `#000000/#FFFFFF`, `#FFFF82/#2E1A42`, `#FFFFC0/#2E1A42`, size slider within `CAROUSEL_LIMITS.size`.
- Save draft / Export N slides; conflict → the reel editor's conflict banner; export status queued → rendering → done (link + soft panels listed) / failed (reason).

- [ ] **Step 1: Implement** the api methods, dialog markup, `carousel.css` and `carousel-editor.js`.
- [ ] **Step 2: Run** `node --check videoreview/carousel-editor.js` and all three test files — expected: clean / `0 failed`.
- [ ] **Step 3: Commit** — `"Tape Review: the carousel editor"`

---

### Task 9: Tape Review wiring, docs, and the live check

**Files:**
- Modify: `videoreview/index.html` (`#tpl-clip` header), `videoreview/app.js` (~L408 `renderClipLinks`, ~L473 reel button, ~L722 `openReel`, ~L794 legacy rows), `videoreview/dev-server.mjs` (~L283), `videoreview/README.md`, `videoreview/SETUP.md`

**Interfaces:**
- Consumes: `openCarouselEditor` (Task 8), `linkLabels` (Task 2).

- [ ] **Step 1:** Add `<button class="make-carousel" title="Draft an Instagram carousel (4:5 slides) from this request">Create carousel</button>` after `.make-reel` in `#tpl-clip`; in `app.js`, give it the same save-first / duplicate / no-ranges checks as `.make-reel` (factor the shared checks into one function used by both buttons) and open `openCarousel(...)`, a twin of `openReel`; add the same `linkish` "Create carousel" button beside "Create clip" on legacy rows.
- [ ] **Step 2:** `renderClipLinks` takes its text from `linkLabels(urls)`.
- [ ] **Step 3:** `dev-server.mjs`: the refusal regex becomes `/^(reel|carousel|renderReel$|renderCarousel$)/` with the same message mentioning carousels.
- [ ] **Step 4:** `README.md`: a "Carousels" section after "Reels" — what the button does, where drafts and exports live (Carousels tab, `carousel_drafts/`, `completed_clips/<…> carousel vN/`), the two jobs, the soft badge. `SETUP.md`: note that no new secrets are needed, and that the runner image must be rebuilt (`reel-image.yml`) before the first carousel.
- [ ] **Step 5: Run** all three test files and `node videoreview/test.mjs` — expected: `0 failed`. Start `node videoreview/dev-server.mjs`, open a show, confirm both buttons appear on app and legacy cards and "Create carousel" shows the dev-server refusal message (not a console error).
- [ ] **Step 6: Commit** — `"Tape Review: Create carousel and View carousel on every request"`
- [ ] **Step 7: After merge (Neal, or with Neal's go-ahead):** `reel-image.yml` rebuilds the image; `deploy-backend.yml` deploys `Code.gs`. Then on a real request: Create carousel → draft finishes → swap a still, pan/zoom, edit/split/join a caption → Export → the `completed_clips/` folder has `01.jpg…` at 1080×1350 that match the editor, column M gained "Carousel v1", the card shows "View carousel ↗", and a second export makes v2.
