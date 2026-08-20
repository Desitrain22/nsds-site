# Tape Review

Watch a show tape, mark clip in/out points against the real playhead, and write the notes
straight into that show's Tape Requests sheet in Drive.

Plain HTML/CSS/ES modules, no build step — same as the rest of this repo. One small service runs
elsewhere: an Apps Script web app for Sheets + Drive. Video comes from YouTube.

```
browser ──YouTube IFrame API──► youtube.com          (the tape, unlisted)
   └────── fetch POST ─────────► Apps Script ──► Sheets + Drive  (clip notes)
```

## Why the video is on YouTube and not Drive

**Drive cannot serve video to a web page.** `drive.usercontent.google.com` returns **403 plus an
HTML error page** to any request carrying `Sec-Fetch-Site: cross-site`. Bisecting the headers
showed that one does it alone — `same-origin`, `same-site` and `none` all return `206`, and
User-Agent, Origin and Referer are all fine. `Sec-Fetch-*` is a browser-controlled forbidden
header, so JS can neither set nor remove it. The browser reports the result as
`MEDIA_ELEMENT_ERROR: Format error`, which looks like a codec problem and isn't — it got HTML
where it wanted an MP4. (Confirmed it isn't codec-related by playing a locally generated 4K
H.264 file same-origin without trouble.)

**Apps Script can't bridge it either.** `ContentService` emits text MIME types only — there is no
`video/mp4` output — plus a ~50 MB response cap, a 6-minute execution limit, and no HTTP `Range`
support, so no seeking. Those are platform limits, not something to code around.

**And Drive is too slow even where it works.** Measured on the same byte range: anonymous Drive
reads run at **1.08 MB/s** while a 4K/76 Mbps master needs **~9.5 MB/s** to play at 1×. Seeks
stall for tens of seconds.

YouTube solves all of it with no extra infrastructure: unlisted uploads, an adaptive quality
ladder that defaults low and lets the viewer pick 1080p, YouTube's CDN instead of Drive's
throttle, and an API that exposes exactly what clip marking needs — `getCurrentTime()`,
`seekTo(seconds, allowSeekAhead)`, `playVideo()`, `pauseVideo()`, `getDuration()`,
`onStateChange`.

The masters stay in Drive untouched; YouTube only holds a 1080p viewing copy. Notes still live
in the sheet.

`tools/publish-tapes.mjs` prepares the uploads — see [SETUP.md](SETUP.md) step 2.

## Setup

See **[SETUP.md](SETUP.md)** for the click-by-click checklist. In short: deploy
`apps-script/Code.gs` as a web app (Execute as Me, Access Anyone) with a `PASSWORD` script
property, upload each show's tapes to YouTube as **unlisted** and paste their ids into
`shows.js`, then paste the `/exec` URL into **Backend settings** on the page. No Google Cloud
project, no third-party account.

## Running it locally

Unlike the rest of this site, **this page cannot be opened over `file://`** — it uses ES modules
and cross-origin `fetch`, both of which need a real origin.

```sh
node videoreview/dev-server.mjs      # http://localhost:8787, passphrase "dev"
```

Stands in for Apps Script so you can work undeployed: real tape lists via rclone, clips written
to `videoreview/.dev-clips.json` instead of your Sheet. `NSDS_PASSWORD=<phrase>` to match
production. Two extra pages — `/playertest` exercises the player against a public YouTube video,
and `/?selftest=1` drives the whole UI and prints a report.

## Unlisted, not private

Unlisted YouTube videos embed fine. **Private ones do not** — the API returns error 100 and the
player says so. Anyone with the YouTube link can watch, which is the same posture as the Drive
links today.

## How clips land in the sheet

Columns **A–G stay exactly as the editing team knows them**; the app adds machine columns
**H–L** off to the right and greys them out.

| | |
|---|---|
| A–G | `Name · Start Time · End Time · (Optional) granular time stamps · (Optional) Notes · Links · Thumbnail notes` |
| H | `clip_id` — minted in the browser before the request, so a retry updates instead of appending twice |
| I | `ranges_json` — the exact ranges, full precision |
| J | `rev` — bumped per write; a mismatch means someone else edited that row |
| K | `video_file_id` |
| L | `updated_at` |

One row per clip. A multi-range clip puts the outer span in B/C and enumerates the parts in
D, matching the shape of the sample row already in those sheets — so story 3's clip
(2:38–2:56, jump cut to 3:15–3:30) reads:

```
B: 2:38   C: 3:30   D: 2:38 - 2:56, 3:15 - 3:30
```

### Rules that keep the sheet safe

- **Reads never write.** Opening a tape touches nothing. The machine columns are added only on
  the write path, and only after the seven human headers have been matched exactly.

- **The app only ever rewrites rows it wrote.** Rows typed straight into the sheet show up
  under "Already in the sheet", playable but read-only. That one boundary avoids nearly every
  way this could corrupt someone's notes.
- **A parse is never a write.** Column D means three different things in the live data —
  additive sub-ranges (`1:12 - 1:19, 1:21 - 1:27`), subtractive cuts (`remove 4:23-4:26`),
  and plain advice (`cut pauses`). It's classified for playback, never written back.
- **B/C are never re-derived from D.** The sample row's D is a *subset* of its span, so
  recomputing C from D would rewrite `1:53` into `1:27` and quietly drop 26 seconds.
- **Writes are serialized** with `LockService`, and the row is located by re-scanning column H
  inside the lock — never by a remembered row number, which a human inserting a row above
  would invalidate.
- **Duplicate ids fail loudly.** If a row gets copy-pasted in Sheets, the clip is flagged
  rather than the app silently picking one.
- **Every timestamp is bounded by the tape's real duration.** This is the cheap check that
  catches a Sheets time-serial misread as 60× too large.
- **Timestamps are written as text** on newly created rows only. Sheets otherwise reads
  `1:53` as a duration and stores `0.0784…` — the live February sheet does exactly this. Existing
  cells are never reformatted, since that would change what an already-typed value displays as.
- **Columns A–G are text on rows we create**, so a note beginning with `=` is a note and not a
  formula rendering `#NAME?`.
- **Ranges are sorted before rendering.** Noticing a later beat first and then adding an earlier
  one is the natural way to use this, and unsorted that writes `B=3:15 / C=2:56` — an inverted
  span in the two columns the editors actually cut from.
- **Column D is regenerated, never inherited.** Dropping a clip from two ranges back to one used
  to leave the old two-range string in D, telling the editor to keep a segment that had just been
  deleted. Free-text advice with no timestamps (`cut pauses`) is still preserved.
- **A retry that lost its response is not a conflict.** If the row already holds exactly what's
  being posted, the save reports success instead of falsely claiming someone else edited it.
- **Legacy rows are scoped to the tape by performer name.** They carry no video id, so without
  that every performer's rows would appear under every tape with a play button bound to the
  wrong video.

## Tests

```sh
node videoreview/test.mjs
```

55 checks over the logic that can quietly corrupt notes — timestamp parsing, the three
meanings of column D, range rendering, the duration bound, and filename → performer for all
nine 2026 shows. Every fixture is a real value from the live sheets or the real April
filenames. The player itself is verified in a browser against the real proxy.

## Known rough edges

- **Sheet resolution** prefers the `sheetId` pinned in `shows.js`, then a spreadsheet whose
  name mentions "request" in the show folder *or one level down*, then creates one. It will
  never adopt an arbitrary spreadsheet — show folders also hold run-of-show and settlement
  sheets, and writing clip rows into one of those would be worse than failing. Pin `sheetId`
  whenever you know it.
- **Tapes are found one subfolder deep.** Measured: only April and July keep tapes at the top
  level. NYTW's are in `Set Tapes/`, March SF in `Sets/`, May in `Footage/`. A flat listing
  returned zero tapes for seven of the nine shows.
- **`shows.js` is hardcoded, by ID not name.** Real Drive folder names contain a forward
  slash (`April 2026 Tapes/Photos`) which the local Drive mount rewrites, so name matching is
  unreliable. Nine 2026 shows are listed; four have a known `sheetId`.
- **The backend fails closed.** Until the `PASSWORD` script property exists, every request is
  refused rather than served — otherwise there's a window between deploying and adding the
  secret where an "Anyone"-access endpoint accepts writes to live sheets with no credential.
- **Security is thin, on purpose.** The phrase is checked server-side so the sheet isn't
  readable without it, but the page is public, anyone can read the URLs out of
  `localStorage`, and the tapes are world-readable via their Drive links anyway. Keeps honest
  people honest; it is not access control.
- **A tape with no YouTube id can't play.** The page says so and names the command. Run
  `tools/publish-tapes.mjs <show>` and fill in `YOUTUBE` in `shows.js` before handing the link
  to anyone.
- **Uploading is manual.** The YouTube Data API needs a Google Cloud project and an OAuth
  client, which is the friction this design exists to avoid. It's once per show.
- **`Maybr-Intro (4-23-26).mp4`** is currently offered as a reviewable tape. Add it to
  `exclude` in `shows.js` if it shouldn't be.

## Keyboard

| key | |
|---|---|
| `space` | play / pause |
| `←` `→` | one frame (29.97 fps) |
| `shift` + `←` `→` | five seconds |
| `j` / `l` | slower / faster |
| `k` | back to 1× and toggle play |
