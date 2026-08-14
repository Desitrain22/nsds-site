# nsds-site

Static site for **notsodailystandup.com** (Not So Daily Stand Up / *Artificially
Unintelligent* — the tech comedy show). Plain HTML/CSS/JS, no build step. Served
by GitHub Pages off `main` via `CNAME`.

- `index.html` — landing page: hero, upcoming shows, Instagram, past shows
- `sponsorship.html` — sponsor pitch (metrics, run of show, what's included)
- `perform.html` — embedded performer application form
- `style.css`, `main.js`, `media/` — everything else

See `README.md` for the data pipeline, the optional hero video, and how to
re-optimize photos. A few things worth knowing before editing:

## The page loads data from a script, not a fetch

`data/site.js` assigns `window.NSDS_DATA`; the pages load it with a classic
`<script>` tag. **Don't "modernize" this into `fetch('data/site.json')` or an ES
module** — both are subject to CORS, which a `file://` page fails, and opening
`index.html` off disk is how this site usually gets previewed. `data/site.json`
is written alongside it as the readable copy; both come from one run of
`scripts/fetch-data.mjs`.

Copy on `sponsorship.html` is hand-written from the event brief we send
prospective sponsors. Only the two `data-stat` figures are generated.

## Two CSS gotchas that already bit once

- **`[hidden]` needs the explicit reset** near the top of `style.css`. `.pill`
  and `.stats` set `display`, which outranks the UA sheet's
  `[hidden] { display: none }` — without the reset, toggling `hidden` from JS
  silently does nothing.
- **Scroll-reveal is opt-in, not opt-out.** `main.js` adds `.reveal-ready` to
  `<html>` before anything hides. Hiding by default and un-hiding from JS means
  any script failure leaves half the page permanently invisible.

## Brand

Palette and shape rules come from `Assets/Brand Notes.gdoc` in Drive and are
encoded as tokens at the top of `style.css`: purple `#2E1A42`, yellow `#FFFF82`,
pale yellow `#FFFFC0`, pale cyan `#DDEFD1`; one-line text gets fully round ends,
a text block gets a radius matching its text size and padding of size × 1.75.

## Assets live in Google Drive

The design source of truth is **not** in this repo — it's the NSDS Drive folder,
synced locally at `~/Library/CloudStorage/GoogleDrive-*/My\ Drive/NSDS`.
`Assets/Web assets/SVG/` holds the brand SVGs (the `Squig-*` family is mostly
unused — reach for those before drawing new decoration);
`Media/Photo kit (select photos)/` holds the source photos.

### Reading from Drive is unreliable — verify before trusting

Those files are Drive File Stream placeholders. A read can **silently return
empty content** or time out while `stat` still reports the true size, so hashes
and diffs come back confidently wrong rather than erroring. Confirm a file
actually materialized before trusting it — but **not** with `wc -c < "$f"`, which
this repo used to recommend: on macOS the redirect form answers from `fstat` on a
seekable file, so it cheerfully prints the full size for a placeholder whose every
actual read fails. Force a real read instead:

```sh
f="path/to/file"; dd if="$f" of=/dev/null bs=1m 2>&1 | tail -1
# "0 bytes transferred" => placeholder or Drive isn't serving content. Any
# non-zero byte count is a genuine read.
```

### If every read fails, check that Drive is signed in

Directory listings come from a local metadata DB, so `ls` and `stat` keep working
perfectly while content reads fail instantly with `Operation timed out` — which
reads like a slow network but isn't. Two things to check, in order:

```sh
pgrep -fl "Google Drive"            # not running at all? open -a "Google Drive"
grep -i "no_user\|pending_sign_in" \
  ~/Library/Application\ Support/Google/DriveFS/Logs/drive_fs.txt | tail
```

`account: no_user` or `pending_sign_in` means DriveFS is **signed out** and needs
a browser sign-in. Nothing on the filesystem side will fix that, and launching
the app is not enough — someone has to complete the flow.

The Google Drive MCP tools authenticate separately, so they keep working when
DriveFS is signed out — that's how the brand SVGs got here. But
`download_file_content` returns **base64 into the context window**, so it's fine
for an SVG and useless for video: a 168 MB reel is ~224 MB of base64. For
anything large there is no way around a working DriveFS — open the folder in
Finder or mark it available offline first.

## Git

This repo belongs to the **Desitrain22** (personal) account, while the default
git identity on this machine is work. Use `gituse personal <cmd>` for commits and
pushes — see `~/.claude/CLAUDE.md`.
