# Comedian lookup — design

A second way into Tape Review: pick a comedian, see every set they've done across every show, open one,
and leave clip requests exactly as today.

Status: approved by Neal in conversation 2026-10-22 ("lets go with A … go make the PR"). Mockup the
entry point was chosen from: `.superpowers/brainstorm/89461-1792656244/content/entry-point.html`
(local, not committed).

**Decided** = Neal said so. **Builder's call** = settled while writing this; revisit without asking.

---

## 1. Why

Repeat performers (Laxmi, Yanjaa, Dan Toomey…) have sets scattered across a dozen shows. Today they have
to remember which months they were on and open each show to find themselves. The show-first index also
hides how messy names are: the same person is filed as `Yanjaa`, `YanjaaW`, `yanjaa westgate`; three
different Dans share the bare label `Dan`. A per-comedian index fixes the lookup and gives every future
tape one canonical person to belong to (decided).

## 2. Goals, non-goals, anti-goals

Goals
- A **By comedian** tab beside today's Year → Show → Tape picker (decided: option A). Shows stay the default.
- Searchable list of comedians with set counts; picking one shows their **library**: one card per set,
  newest show first, with a YouTube thumbnail preview (decided: "I love the previews").
- Clicking a card opens the existing review player for that tape; notes still save to that show's sheet.
- A shareable deep link per comedian: `…/videoreview/?comedian=<key>` (builder's call).
- One roster in the repo that every spelling resolves through, so the index scales to future shows.

Non-goals (this PR)
- **Full-show tapes.** Neal will cut them into per-performer pieces later (decided). They are not listed.
- **Upload-portal performer dropdown.** The cascading idea from the brief; a follow-up PR, built on the
  same roster (builder's call on sequencing).
- **Access control.** One passphrase still unlocks everything; anyone can open anyone's library (decided).
- Clip-request counts on cards (would cost a sheet read per show; dropped from the mockup — builder's call).

Anti-goals — it fails even if it "works" when:
- A comedian's set is **silently missing** from their library. Anything the roster can't place is shown,
  not hidden (an "Unmatched tapes" group), and a test fails on any unplaced label.
- A tape is attached to the **wrong person by guess.** Ambiguous labels (`Dan`, `Alex`) resolve only
  through an explicit per-show entry; never by first-name match.
- The show-first flow regresses in any way, or the Apps Script backend changes. Neal asked to work
  minimally in the Drive/Apps Script realm (decided).
- Drive file ids end up in the public repo. The repo is public; tape Drive links are effectively
  world-readable. Today ids are only reachable behind the passphrase (builder's call, firm).

## 3. How it works

### Data: no backend change
`data/upload-status.json` is already published by CI after every YouTube sync and already lists, per
show: `label`, `folderId`, and per tape `performer` (the `performerFrom` label), `filename`, `state`,
`youtubeId`. That is everything a library card needs. The page fetches it (same as `status.html`) and
resolves each tape's label to a comedian through the roster.

Opening a card: find the show by `folderId` in the already-loaded `listShows` result, run the existing
`selectShow` (which calls `listTapes`, behind the passphrase), pick the tape whose `name === filename`,
then the existing `openTape`. Drive file ids therefore never leave the backend.

Freshness: the library reflects the last status refresh. A brand-new show appears once its tapes have
been through the nightly sync — the same moment they become playable anyway.

### The roster (`videoreview/comedians.js`)
Hand-maintained data, reviewed in PRs:
- `COMEDIANS`: `{ key, name, aliases[] }` — `key` is a stable slug used in URLs; `name` is the display
  name (full name where Neal confirmed it); `aliases` are every tape label that unambiguously means them.
- `SHOW_OVERRIDES`: `{ [showLabel]: { [tapeLabel]: key } }` — the only way an ambiguous label resolves.
- `AMBIGUOUS`: labels that must never resolve globally (`Dan`, `Alex`).
- `NOT_PEOPLE`: `Full Show`, `Sponsor Sketch`.

Resolution order for a tape label in a show: per-show override → exact alias (case-, space- and
punctuation-insensitive) → the same after stripping a **part suffix** (`2`, `3`, `Pt2`, `(Top)`,
`Additional`, `P`) so `Neal4` or `NealPt3` at a future show still lands on Neal → unmatched.
A label that matches two comedians' aliases is unmatched, never a pick.

The roster's starting contents are the 2026-10-22 Drive scan (673 videos, 41 sheets, reconciled by three
independent passes) plus Neal's answers that day — e.g. bare `Pete` is Pete Ballmer everywhere;
`Peter` (Feb 2026) is Peter Liu; `Dan` is Toomey in NYC 2025/June 2026 NYTW, Guan in SF 2026, Wickes in
NYC Feb/Mar 2026; `Alex` is Shklar in July 2025, Kim in December 2025; `Doordash` (July 2025) is Aakash;
`Akaash` is a misspelling of Aakash; every `Sarah` is Sarah Barnitt; every `Victoria` is Victoria Chuah.

### UI (option A)
- Two tab buttons above the picker: **By show** (default) / **By comedian**.
- By comedian: a search box filtering name + aliases, chips `Name · N`, and an "Unmatched tapes" group last.
- Library: header with the name and "also filed as …"; a grid of cards (thumbnail from
  `i.ytimg.com/vi/<id>/mqdefault.jpg`, show label, part label such as "Top of show" or "Part 2",
  "video coming soon" when not on YouTube yet). The review pane opens below, as it does for show mode.
- URL carries `comedian=<key>` alongside the existing `show`/`tape`, and `restoreFromUrl` honours it.

## 4. Left to the builder
File split between roster data and resolution logic; exact markup and CSS (match `review.css`);
card ordering within a show; search matching details; how the tab state is restored on reload.

## 5. Verification
- `node videoreview/test-library.mjs`: resolution rules, ambiguity, parts, and that **every** set-tape
  label currently in Drive and in `data/upload-status.json` resolves or is in `NOT_PEOPLE`.
- `node videoreview/test.mjs` still passes (show-first logic untouched).
- Local: `node videoreview/dev-server.mjs`, drive the page headless — gate, By comedian, search, open a
  set, deep link reload — plus the show-first path end to end.
