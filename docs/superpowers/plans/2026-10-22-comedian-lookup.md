# Comedian Lookup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "By comedian" tab in Tape Review that lists every comedian and opens a per-comedian library of their sets.

**Architecture:** A hand-maintained roster (`comedians.js`) plus pure resolution logic (`library.js`) turn the
already-published `data/upload-status.json` into per-comedian libraries in the browser. Opening a set reuses
the existing `selectShow` → `listTapes` → `openTape` path, so the Apps Script backend does not change and no
Drive ids enter the repo.

**Tech Stack:** Plain ES modules, no build step, zero-dep Node test scripts (same as `videoreview/test.mjs`).

**Spec:** `docs/superpowers/specs/2026-10-22-comedian-lookup-design.md`

## Global Constraints

- No change to `videoreview/apps-script/Code.gs` or any backend action.
- No Drive file ids added to any committed file.
- Show-first flow (Year → Show → Tape, `?show=&tape=` deep links) behaves exactly as before; `node videoreview/test.mjs` passes unchanged.
- Never resolve an ambiguous label (`Dan`, `Alex`) without a per-show override; a label matching two comedians is unmatched.
- Match the surrounding code: no dependencies, no build step, comment density and idiom of `app.js` / `shows.js`.
- Commits run as `gituse personal git commit …` (repo belongs to Desitrain22).

## Review Focus

1. A new show appears with a label already in the roster (`Yanjaa Set.mp4`) → lands on the right person with no roster edit.
2. A new show with an ambiguous label (`Dan Set.mp4`) and no override → shows under "Unmatched tapes", not under any Dan.
3. Multi-part labels (`Neal4`, `NealPt3`, `NealP (Top)`) at an unseen show → resolve to Neal with a part label.
4. A card whose show is missing from `listShows` (renamed folder, 6 h cache) or whose filename no longer matches a tape → a clear message, never the wrong tape.
5. Reload with `?comedian=x&show=y&tape=z` → same comedian, same tape open; `?show=&tape=` without `comedian` → show tab exactly as before.

---

### Task 1: Roster and resolution logic

**Files:**
- Create: `videoreview/comedians.js` (data only: `COMEDIANS`, `SHOW_OVERRIDES`, `AMBIGUOUS`, `NOT_PEOPLE`)
- Create: `videoreview/library.js`
- Test: `videoreview/test-library.mjs`

**Interfaces:**
- Produces (library.js):
  - `normLabel(label: string) -> string` — lowercase, letters+digits only.
  - `splitPart(label: string) -> { base: string, part: string|null }` — strips one trailing part marker: digits, `Pt<n>`/`Part <n>`, `(Top)`/`Top`, `Additional`. Nothing name-specific: `NealP (Top)` → base `NealP` (an alias of Neal), part `Top of show`. Part display strings: `Top of show`, `Part N`, `Additional`.
  - `resolveComedian(showLabel: string, tapeLabel: string, roster = ROSTER) -> string|null` — key or null; order: override → exact alias → alias of `splitPart(label).base` → null; ambiguity → null.
  - `buildLibrary(status: UploadStatus, roster = ROSTER) -> { comedians: Comedian[], unmatched: SetRef[] }` where `SetRef = { show, year, folderId, filename, label, part, state, youtubeId|null }` and `Comedian = { key, name, aliases, sets: SetRef[] }`; only comedians with ≥1 set; comedians sorted by name; sets newest show first (by status `shows` order then filename); `NOT_PEOPLE` and `held-back` items skipped.
  - `searchComedians(comedians: Comedian[], query: string) -> Comedian[]` — case/space-insensitive substring on name and aliases; empty query returns all.
  - `ROSTER` — `{ COMEDIANS, SHOW_OVERRIDES, AMBIGUOUS, NOT_PEOPLE }` re-exported from comedians.js.

- [ ] **Step 1: Write the failing tests** in `test-library.mjs` (same `eq`/`group` harness as `test.mjs`):
  - `resolveComedian('May 2026 (Boston)', 'YanjaaW')` → `'yanjaa-westgate'`; `'yanjaa westgate'` → same.
  - `resolveComedian('January 2025 (NYC)', 'Dan')` → `'dan-toomey'`; `('March 2026 (SF)', 'Dan')` → `'dan-guan'`; `('June 2026 (SF)','Dan')` → `'dan-guan'`; `('December 2027 (NYC)', 'Dan')` → `null`.
  - `resolveComedian('July 2025 (NYC)', 'Alex')` → `'alex-shklar'`; `('December 2025 (NYC)','Alex')` → `'alex-kim'`; `('July 2025 (NYC)','Doordash')` → `'aakash'`.
  - `resolveComedian('March 2030 (NYC)', 'Neal4')` → `'neal-patel'`; `'NealPt3'` → same; `'Pete'` anywhere → `'pete-ballmer'`; `'Akaash'` → `'aakash'`.
  - `splitPart('NealP (Top)')` → `{ base: 'NealP', part: 'Top of show' }`; `splitPart('Neal2')` → `{ base: 'Neal', part: 'Part 2' }`; `splitPart('Yi')` → `{ base: 'Yi', part: null }`.
  - Ambiguity: a synthetic roster where two comedians share alias `x` → `resolveComedian('s','x', roster)` is `null`.
  - `buildLibrary` on a two-show fixture: Full Show skipped, a `Dan` with no override lands in `unmatched`, sets ordered newest show first.
  - **Coverage:** every item in the real `data/upload-status.json` and every label in the `DRIVE_LABELS_2026_10_22` fixture (the 118 set-tape labels per show listed in the Task 1 brief) resolves or is in `NOT_PEOPLE`; failures print show + label.
  - Roster integrity: keys unique and slug-shaped; every `SHOW_OVERRIDES` target is a real key; no alias in two comedians; no `AMBIGUOUS` label is also a global alias.

- [ ] **Step 2: Run** `node videoreview/test-library.mjs` — expected: fails (module not found).
- [ ] **Step 3: Implement** `library.js` against the signatures above (comedians.js data is supplied in the brief).
- [ ] **Step 4: Run** `node videoreview/test-library.mjs` and `node videoreview/test.mjs` — expected: both print 0 failures.
- [ ] **Step 5: Commit** `feat(videoreview): comedian roster and resolution`.

### Task 2: "By comedian" tab and library view

**Files:**
- Modify: `videoreview/index.html` (tab buttons; `#comedian-panel` with search input, `#comedians` chips, `#library`)
- Modify: `videoreview/app.js` (mode state, status fetch, render functions, `openSet`, URL read/write)
- Modify: `videoreview/review.css` (tabs, comedian chips, library grid, cards with 16:9 thumbnail)
- Modify: `videoreview/README.md` (section "By comedian" + "Adding a comedian / fixing a label")

**Interfaces:**
- Consumes: `buildLibrary`, `searchComedians` from Task 1; existing `selectShow(show) -> tapes[]`, `openTape(tape)`, `getShow`, `nav`.
- Produces: `?comedian=<key>` deep link.

- [ ] **Step 1:** Add the markup and CSS; `#picker` keeps its columns, wrapped so the show mode is one panel and the comedian mode another; `By show` is selected by default.
- [ ] **Step 2:** `loadLibrary()` — fetch `../data/upload-status.json` once (`cache: 'no-cache'`), `buildLibrary`, memoise; a fetch error shows a message in the panel and leaves show mode working.
- [ ] **Step 3:** `renderComedians(query)` and `renderLibrary(comedian)`; cards use `loading="lazy"` thumbnails; pending tapes say "video coming soon"; unmatched group listed last with raw labels and show.
- [ ] **Step 4:** `openSet(set)` — show by `folderId` from `state.shows` (missing → message "This show isn't available yet"); `await selectShow(show)`; tape by exact `name === filename` (missing → message, never a fallback pick); `openTape`. Guard with the existing `nav` tokens so a stale click can't open a tape after the user navigated.
- [ ] **Step 5:** `writeUrl` adds `comedian` when in comedian mode; `restoreFromUrl` switches to the tab and selects the comedian before restoring `show`/`tape`.
- [ ] **Step 6: Run** both test scripts; drive `node videoreview/dev-server.mjs` headless (gate → tab → search "yan" → open a set → reload deep link → By show still works).
- [ ] **Step 7: Commit** `feat(videoreview): By comedian tab with per-comedian library`.
