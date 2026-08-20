# Tape Review

Watch a show tape, mark clip in/out points against the real playhead, and write the notes
straight into that show's Tape Requests sheet in Drive.

Plain HTML/CSS/ES modules, no build step — same as the rest of this repo. Two small pieces
run elsewhere: an Apps Script web app (Sheets + Drive) and a Cloudflare Worker (video bytes).

```
browser ──<video crossorigin>──► Cloudflare Worker ──► Google Drive   (tape bytes)
   └────── fetch POST ──────────► Apps Script ────────► Sheets + Drive (clip notes)
```

## Why the Worker exists

You cannot point a `<video>` at a Drive file from a web page. `drive.usercontent.google.com`
returns **403 plus an HTML error page** to any request carrying `Sec-Fetch-Site: cross-site`.
Bisecting the headers showed that one header does it on its own — User-Agent, Origin and
Referer are all fine alone, and the same URL returns `206` from curl. `Sec-Fetch-*` is a
browser-controlled forbidden header, so JS can neither set nor remove it.

The browser surfaces this as `MEDIA_ELEMENT_ERROR: Format error`, which looks like a codec
problem and isn't — it got HTML where it wanted an MP4. Confirmed it's not codec-related by
playing a locally generated 4K H.264 file same-origin without trouble.

A server-side `fetch` sends no `Sec-Fetch-*` headers, so the Worker gets a normal `206` and
re-serves the bytes with permissive CORS. Nothing is re-hosted; Drive stays the only storage.

Measured through the Worker against `DavidS_4-23-26.mp4` (4.33 GB, 3840×2160, 76 Mbps):
duration read back as 453.82 s — exactly `ffprobe` — seeks landed on the requested second,
and a two-range playback stopped 10 ms past target.

## Why the 480p proxies are required

Drive throttles *anonymous* reads hard. Same file, same byte range, measured back to back:

| path | throughput |
|---|---|
| anonymous download endpoint (what the Worker uses) | **1.08 MB/s** |
| authenticated rclone | **7.41 MB/s** |
| what a 4K/76 Mbps master needs to play at 1× | **~9.5 MB/s** |

So a master can never stream — it's ~9× short, and a seek stalls for tens of seconds
waiting on a GOP. That isn't a bug to fix; it's the ceiling.

A 480p proxy runs ~1.6 Mbps (0.2 MB/s), which leaves ~5× headroom even on the throttled
path, and seeks land immediately. Duration is preserved exactly, so timestamps map 1:1 onto
the master with no offset maths.

```sh
node tools/make-proxies.mjs apr2026               # every set tape (~15-20 min each)
node tools/make-proxies.mjs apr2026 --only=DavidS  # just one
```

It pulls through rclone rather than the anonymous endpoint — transcodes with VideoToolbox, and
uploads to a `Proxies` subfolder of the show folder, where it inherits the folder's "anyone with
the link" sharing. The app picks the proxy automatically and offers a 4K toggle for anyone who
wants to squint at detail.

Timing, measured on `DavidS_4-23-26.mp4` (4.33 GB): **~16 min**, i.e. ~0.47× realtime, entirely
network-bound — sustained rclone throughput lands around 4.8 MB/s, below the 7.4 MB/s a short
spot check suggests. Budget roughly **2.5 hours for all nine April tapes** and run it in the
background. It's resumable: finished proxies are skipped unless you pass `--force`.

## Setup

See **[SETUP.md](SETUP.md)** for the click-by-click checklist. In short: deploy `apps-script/Code.gs`
as a web app (Execute as Me, Access Anyone) with a `PASSWORD` script property, deploy
`worker/tape-proxy.js` with a `TAPE_TOKEN` secret set to the same phrase, then paste both URLs
into **Backend settings** on the page. No Google Cloud project is involved.

## Running it locally

Unlike the rest of this site, **this page cannot be opened over `file://`**. It uses ES
modules and cross-origin `fetch`, both of which need a real origin. Serve it:

```sh
cd videoreview && python3 -m http.server 8000   # then open http://localhost:8000/
```

## Tapes must be shared "Anyone with the link"

The Worker reads Drive anonymously, so a restricted file comes back as HTML and the player
reports it can't load. The tape list flags anything not publicly shared. All nine April 2026
files were already `anyone: reader`.

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
- **Both the backend and the Worker fail closed.** Until `PASSWORD` and `TAPE_TOKEN` exist,
  every request is refused rather than served — otherwise there's a window between deploying
  and adding the secret where an "Anyone"-access endpoint writes to live sheets, and the Worker
  is an open proxy for any world-readable Drive file.
- **Security is thin, on purpose.** The phrase is checked server-side so the sheet isn't
  readable without it, but the page is public, anyone can read the URLs out of
  `localStorage`, and the tapes are world-readable via their Drive links anyway. Keeps honest
  people honest; it is not access control.
- **A tape with no proxy falls back to the 4K master and will barely scrub.** The player
  says so and names the command to fix it. Run `make-proxies.mjs` per show before handing
  the link to anyone.
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
