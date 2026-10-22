# Carousel editor — design

Turn a clip request into an Instagram **carousel**: 1–10 slides at 4:5, each slide three stacked
stills of the performer with one line of the bit captioned on each, the way stand-up is being
shared now (reference: `instagram.com/p/DeHSCPekalh`, @thisisginsberg). A sibling of the reel
editor ("Create clip"), built on the same pipeline.

Status: design, approved for planning once Neal signs off on this document.
Mockup the editor was agreed from: `.superpowers/brainstorm/81239-1792653145/content/carousel-editor-v3.html`
(local, not committed — open it via the brainstorm companion, or read the source).
Read `2026-10-15-reel-editor-design.md` first; this document only states what differs.

**decided** = Neal said so in the design conversation. **Claude's call** = settled while writing
this; revisit without asking. **Left to the builder** = §9.

---

## 1. Why

Carousels are a growing way stand-up gets shared: the bit is read rather than watched, one
swipe per beat, and the punchline lands on a swipe. Today NSDS makes these by hand, if at all.
The reel pipeline already has everything hard — the request's ranges, a word-timed WhisperX
transcript, a face detector, the 4K master on a runner, versioned exports into `completed_clips/`.

### Success looks like
- Someone presses **Create carousel** on a request, waits a few minutes, fixes a caption or two,
  drags a photo to frame it better, swaps one still, presses Export, and gets a folder of
  postable 1080×1350 slides in the show's `completed_clips/`.
- The card then shows **View carousel ↗**, the way it shows "Finished clip ↗".
- What they edited is what comes out.

### Goals
1. A separate **Create carousel** button and a separate pop-up from Create clip (decided).
2. Auto-draft from the request: transcript, the bit split into lines, three lines per slide,
   and a well-framed still for every line (decided: the three parts to build are stills,
   line placement, caption editing).
3. Edit on the slide itself: double-click a caption to retype it, drag it to move it, drag a
   photo to reposition it within its third, scroll to zoom (decided).
4. Swap the still for any third from candidates taken from the moment that line is spoken.
5. Export to `completed_clips/` the same way clips export, at Instagram's best resolution, and
   link it from the request row (decided).

### Non-goals (v1)
- Posting to Instagram, or writing the post's caption/hashtags.
- Layouts other than three stacked panels (one big photo, two panels, text-only slides).
- Per-slide or per-word styling, emoji, stickers, highlights on words.
- Clever pacing. **Start with an elementary, general split with good sentence pacing; everyone
  has their own taste and edits from there** (decided). No attempt to find "the punchline".
- More than 10 slides (decided: 1–10), even though Instagram now allows 20.

### Anti-goals — failure even if it technically works
Everything in the reel design's anti-goals applies unchanged (no writes to A–L, never overwrite an
export or column M content, nothing on the laptop, nothing private in the public repo's Actions
logs or inputs). Plus:
- A slide that looks materially different from the editor (different line breaks, crop, font,
  box, watermark position).
- Soft, upscaled stills. Neal's first reaction to a low-res mockup was "images are low quality lol
  rip"; it's the first thing anyone will notice. Stills come from the master, never the YouTube copy.
- Off-brand slides (decided: consistent brand and fonts, watermark on every slide).

---

## 2. What exists (read before building)

Everything listed in §2 of the reel design, plus what the reel work added:

- `videoreview/reel.js` — the pure module shared by editor, runner and backend (fonts, limits,
  `fillTimings`, `autoBreaks`, `followTrack`, the ASS/ffmpeg builders). `FONTS` and the font files
  in `videoreview/fonts/` are the caption font set.
- `videoreview/reel-editor.js`, `reel.css` — the editor `<dialog>`, its progress screen while a
  draft is made (#34), caption/logo dragging (#33).
- `videoreview/app.js` — `.make-reel` ("Create clip") on every request card, including the
  legacy rows; `renderClipLinks` renders column M as "Finished clip ↗".
- `videoreview/apps-script/Code.gs` — `reelOpen`, `reelGet`, `reelSave`, `reelJobGet/Put`,
  `dispatchReelGs`, `appendExportLinkGs`; draft storage split between the **Reels** tab of the
  request sheet and `<show>/reel_drafts/<key>.json`; `legacyKeyGs` for typed rows.
- `.github/workflows/reel.yml` — `workflow_dispatch` with `job` + `draft` id only; runs in the
  `ghcr.io/desitrain22/nsds-reel` image (`tools/reel/Dockerfile`, WhisperX + OpenCV + ffmpeg).
- `tools/reel/draft.mjs` — one master read via `rclone serve` → WAV for WhisperX + a 4 fps copy
  for `track.py`. `tools/reel/track.py` runs **YuNet** (`tools/reel/models/`), the face detector
  this feature reuses for framing.
- Brand (`style.css`): purple `#2E1A42`, yellow `#FFFF82`, pale yellow `#FFFFC0`; one-line text
  gets fully round ends; the bug is `media/brand/Icon.svg` + "A.U Tech Comedy Show" in Azeret Mono
  bold at 70% (reel design §3).

---

## 3. The slide (decided, from the reference post and the mockup)

- **1080×1350 (4:5)** — Instagram's portrait carousel size; it doesn't keep more than 1080 px of
  width, so larger is wasted (decided: "max/most optimal resolution for Instagram").
- **Three equal panels, 1080×450 each (12:5)** — top, middle, bottom. One line of the bit per
  panel, top to bottom, then the next slide.
- Each panel is a still of the performer **taken while that line is spoken**, framed head-to-chest
  with the face centred (decided: face-based framing with a lightweight model, not a centre crop).
- The caption sits near the panel's bottom edge, centred, in a box. Brand rule applied per line
  (Claude's call): each wrapped line gets its own fully-rounded box (CSS
  `box-decoration-break: clone`), lines balanced (`text-wrap: balance`) so there are no one-word
  orphans. Default: Montserrat ExtraBold, white on brand purple (Claude's call — the reference uses
  a bold sans on a black box; purple is the brand version). Alternatives on a swatch: black,
  yellow (purple text), pale yellow (purple text).
- Caption font choices are exactly the reel's five (`FONTS` in `reel.js`), so the font files are
  shared. One style for the whole carousel; size adjustable within limits (Claude's call).
- **Watermark** on every slide, top-right, faded: the reel bug — logo + "A.U Tech Comedy Show"
  in Azeret Mono bold, ~70% opacity (decided). Fixed position (Claude's call — the reel's bug is
  draggable; here it never collides with a caption because captions sit at panel bottoms).

---

## 4. The editor (decided, from mockup v3 — "more straightforward")

A `<dialog>` like the reel editor, opened by **Create carousel**, placed next to Create clip on
every request card (app rows and legacy rows) with the same save-first behaviour (`app.js`
`.make-reel` handler). Same passphrase gate, API client and "making your carousel" progress screen.

- **Slide preview** — one slide large, thumbnails of all slides beneath to switch.
- **On the slide:**
  - double-click a caption → edit its text in place; Enter or click away to finish;
  - drag a caption → move it within its panel (clamped);
  - drag a photo → pan it within its third; scroll/pinch → zoom (never below "covers the panel",
    never past a fixed max; Claude's call: 4×);
  - click a panel → selects it (yellow outline) and shows its stills on the side.
- **Side panel:**
  - **Stills for the selected third** — the best few candidates from that line's time window, best
    one pre-selected, plus a way to see every candidate frame in the window (Neal: "ability to
    change/select different stills within each section"). Choosing one resets pan/zoom to its face
    framing.
  - **Line controls** for the selected third (Claude's call, needed for "they can edit from
    there"): split at the caret, join with the next line, delete the line, clear its caption. Lines
    reflow three per slide after any of these, so slide count follows.
  - **A short last slide** (Claude's call). When edits leave the last slide with one or two lines,
    its empty thirds are filled with **captionless reaction stills** — the best frames from just
    after the slide's last line (the laugh). The slide stays three panels; nothing blocks export.
    Any panel may also have its caption cleared on purpose, so a panel's caption is optional
    everywhere (layout module, validation, renderer). The filler panels are ordinary panels: the
    person can swap their still, pan/zoom, or type a caption into them.
  - **Caption style** (all slides) — font, box colour, size.
  - **Save draft** / **Export N slides**, and export status (queued → rendering → done with link, or
    failed with reason), like reels.
- A **soft** badge on a panel whose crop would need upscaling from the master (§6).

---

## 5. The first draft (engine)

Triggered by the first **Create carousel** on a request with no carousel draft (as reels). One
runner job, the same `reel.yml` with a new `job` value (Claude's call), steps reported to the
progress screen like reels: tape → captions → stills.

1. **Ranges** — exactly as reels (§6.1 of the reel design), including `cut pauses`.
2. **Transcript** — if this request already has a reel draft with words, copy them; otherwise run
   WhisperX exactly as `draft.mjs` does (Claude's call; saves a few minutes, same words either way).
3. **Lines (default pacing, decided: elementary and general).** Claude's call on the rule:
   - one sentence per line, using WhisperX's punctuation;
   - a sentence longer than ~70 characters breaks at a comma, else at the longest pause ≥ 0.5 s,
     else at the word nearest its middle;
   - then **make the count a multiple of three** so every slide has three panels: split the longest
     line (by the same rule) or join the two shortest adjacent lines, whichever disturbs less,
     until it is;
   - **every line is kept**, but only the first **30 = 10 slides** are placed on slides. The rest
     wait in reserve below the slides in the editor ("12 more lines didn't fit in 10 slides"):
     deleting or joining lines pulls them in, in order. Export only ever renders the first 30
     (Claude's call — the stored lines are uncapped up to the clip's own limits; the 30-line cap
     applies to what is placed and exported).
   Each line keeps the word-index range it came from, which is its time window.
4. **Candidate stills.** One more pass over the master for the whole clip span (every line,
   including those in reserve, plus a few seconds after the last line for reaction stills), at
   **4 fps** (Claude's call), decoded at full resolution:
   - YuNet on each frame; the performer is the face `followTrack` would choose (reuse its
     performer-picking, don't invent a second rule);
   - score = face found + detector confidence + sharpness of the face region (variance of the
     Laplacian) − penalties for a face much smaller than the clip's median (someone walked
     away/occluded) and for missing landmarks; frames with no performer face are not candidates;
   - candidates are spread out (≥ 0.5 s apart within a line) so the strip isn't six copies of
     one moment;
   - each line's default is its top-scoring candidate, avoiding the exact frame the line above uses;
   - a line with no usable performer frame falls back to the nearest scored frame outside its
     window, then to a centre crop, and is flagged in the editor (Claude's call).
5. **Framing** (the spike in the brainstorm ran this rule on a stage photo from the photo kit, not a
   tape frame, and it matched the reference framing): a 12:5 box ≈ 2.3× the face height tall, face
   centred horizontally and its centre at ~42% from the top, shifted back inside the frame if it
   runs off an edge. **Sharpness beats tightness** (Claude's call, from the anti-goal): the box is
   never shorter than **450 master pixels**, so the default crop is never upscaled. On a wide stage
   shot with a small head that means a looser, wider framing — accepted. Zooming in past that is
   allowed by hand and is what earns the **soft** badge. Tapes below 4K follow the same rule; they
   simply get looser framings. Stored per
   panel as **normalised source coordinates** (centre x/y and box height as fractions of the frame),
   so the same crop applies to a 1280-px preview and the 3840-px master.
6. **Previews for the editor** — every scored frame, at ~1280 px wide JPEG (Claude's call), saved
   under the draft's folder in Drive. The editor never needs a job to switch stills; picking any
   frame in a line's window is instant. (Re-splitting lines just re-filters the same frames by the
   new windows.)
7. Write the draft, status `ready`.

---

## 6. Export

A `render` job for carousels on the same workflow. Only the draft id is dispatched (reel rules).

1. For each panel, read the **exact chosen timestamp** from the master (seek, one frame), apply the
   stored normalised crop, scale to 1080×450.
2. If the crop box is under 450 px tall in the master, the panel is upscaled. The default framing
   never does this (§5.5); only a hand zoom can. Render anyway, list it in the export status, and
   show the same **soft** badge in the editor beforehand (Claude's call: warn, don't block).
3. Compose each slide — three panels, captions, watermark — at 1080×1350, and **guarantee it
   matches the preview**. Claude's call: render the slide with the *same* DOM/CSS layout module the
   editor uses, in headless Chromium on the runner (added to the reel image), with panel images
   pointing at the full-res crops and the committed font files. Rounded per-line boxes and balanced
   wrapping are exactly what's hard to reproduce in ffmpeg/libass or Pillow. Caption text goes in as
   `textContent`, never HTML; the page loads only local files (no network).
4. Encode **JPEG, quality ~95, sRGB** (Claude's call — Instagram re-encodes everything to JPEG, so
   PNG only adds a conversion), named `01.jpg … NN.jpg` in post order.
5. Upload into a new folder in the show's `completed_clips/`:
   `<Performer> - <clip name> carousel vN/`, N = next unused, never overwrite (decided: "the same
   way we do clips").
6. Append **"Carousel vN"**, linked to that folder, to the request row's column M with the existing
   `appendExportLinkGs` rules (lock, re-locate row, never replace).
7. Tape Review card: `renderClipLinks` labels a Drive **folder** link "View carousel ↗" and file links
   "Finished clip ↗" as today (Claude's call: tell them apart by URL — `/drive/folders/` — so no new
   sheet column).

---

## 7. Storage and the backend

Mirror reels (Claude's call): a **Carousels** tab in the request sheet (one row per request:
status, version, latest export, rev, style, the editable recipe) plus a bulk JSON in a new
`<show>/carousel_drafts/<key>.json` with the words, lines, frame index and scores, and a
`<key>/` subfolder of preview frames. Same key as the reel draft (`clipId`, or `legacyKeyGs`).

Recipe, at least:

```
lines    [{ words: [i, j), text, cap: {x, y}, still: {t, frame}, crop: {cx, cy, h} }]
style    { font, size, box, fg }
frames   [{ t, file, score, face: {cx, cy, w, h} }]   (bulk JSON)
exports  [{ version, folderId, url, at, soft: [panel indices] }]
```

New actions (`carouselOpen`, `carouselGet`, `carouselSave`, `carouselFrame`, and runner
`carouselJobGet/Put`, or the reel ones generalised — builder's call), with the reel's validation
discipline: allowlisted keys, unknown keys rejected, `rev` conflict check, font from the list,
colours by `REEL_HEX_RE`, caption text ≤ ~120 characters per line, coordinates clamped, crop box
inside the frame, `still.t` must be one of the draft's own frames, caption text may be empty,
and an export renders at most 30 lines (padded to a multiple of three with reaction panels, §4).
`carouselFrame` returns one preview frame's bytes to a passphrase holder, only for a file inside
that draft's folder; no Drive sharing settings change (Tape Review users don't have Drive access).

---

## 8. Constraints

All of reel design §7, plus:
- The slide layout (panel geometry, caption box, watermark, framing maths, the pacing rule) lives in
  one pure module shared by editor, runner and renderer, as `reel.js` is — `videoreview/carousel.js`
  (Claude's call on the name).
- The image grows by headless Chromium; keep `reel-check.yml`-style coverage by rendering a
  synthetic carousel through the real export path.
- Drive previews are many small files; stay well inside Apps Script quotas (fetch on demand, not
  the whole draft at open).

---

## 9. Left to the builder

Exact score weights and the sharpness threshold; blink detection (nice to have — YuNet has no eye
state; skip if it needs another model); preview size and JPEG quality; whether previews are single
files or per-line sprite sheets; how split/join maps edited text back onto word ranges (nearest
word boundary is fine); caption size limits; the dialog's exact markup; whether the carousel and
reel actions share code paths; Chromium vs another renderer **only if** it provably matches the
preview pixel-for-pixel on the test fixtures. Tests in the `test-reel.mjs` style with real
fixtures, at minimum: the pacing rule (including the multiple-of-three pass, the 30-line placement
cap and pulling reserve lines in), reaction-panel filling of a short last slide,
framing maths and its edge clamping, normalised-crop round trip preview→master, candidate spacing,
allowlist rejection, and folder-vs-file link labelling.
