# nsds-site

Static site for **notsodailystandup.com** (Not So Daily Stand Up / *Artificially
Unintelligent* — the tech comedy show). Plain HTML/CSS/JS, no build step. Served
by GitHub Pages off `main` via `CNAME`.

- `index.html` — landing page: hero, upcoming shows, Instagram, past shows
- `sponsorship.html` — sponsor pitch (metrics, run of show, packages)
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
actually materialized before trusting it:

```sh
f="path/to/file"; [ "$(wc -c < "$f")" = "$(stat -f%z "$f")" ] || echo "PLACEHOLDER - reread"
```

When the filesystem refuses outright (every read timing out), the Google Drive
MCP tools will still fetch a file by ID — that's how the current brand SVGs got
here. For anything large, open the folder in Finder or mark it available offline
first.

## Git

This repo belongs to the **Desitrain22** (personal) account, while the default
git identity on this machine is work. Use `gituse personal <cmd>` for commits and
pushes — see `~/.claude/CLAUDE.md`.
