# notsodailystandup.com

Static site for **Not So Daily Stand Up** (a.k.a. *Artificially Unintelligent*),
the tech comedy show. No build step, no framework — GitHub Pages serves the
files in this repo directly off `main`.

```
index.html          landing page — shows, Instagram, past shows
sponsorship.html    the sponsor pitch (metrics, format, what's included)
perform.html        embedded performer application form
style.css           design system (tokens straight from the Brand Notes doc)
main.js             renders shows / posts / stats
data/site.js        committed data, refreshed by a GitHub Action
scripts/fetch-data.mjs
media/brand/        brand SVGs from Drive
media/opt/          optimized photos (webp + jpg)
media/reels/        the five clips, self-hosted (mp4 + poster)
media/sponsors/     sponsor logos — see ASSETS.md there for provenance
media/hero.mp4      optional hero video
```

Everything in the repo is something a page loads. Full-resolution originals and
source art are **not** kept here — they live in Drive, and old ones are still in
git history if you need them back (`git log --diff-filter=D --name-only` to find
the commit, then `git show <sha>^:media/crowdpic.jpg > crowdpic.jpg`).

**Just open `index.html`** — double-clicking it works, no server needed. The
pages load their data from `data/site.js`, which assigns a global, rather than
fetching it. A classic `<script>` is exempt from the CORS rules that make both
`fetch()` and module scripts fail on a `file://` URL, so the site behaves the
same off disk as it does on Pages.

## Shows update themselves

`.github/workflows/refresh-data.yml` runs every 6 hours, executes
`scripts/fetch-data.mjs`, and commits the result if anything changed. You can
also trigger it by hand from the Actions tab, or run `npm run fetch` locally.

The page never calls Luma directly from the browser — it can't, as Luma
allowlists only its own origins. The Action makes that request once and commits
the answer.

**Luma** — `api.lu.ma/user/profile/events-hosting`, for user
`usr-5IoinAmtej3Z8xe` (that's `luma.com/user/TechComedyShow`). Upcoming and past
are fetched separately. Anything on that Luma automatically appears on the site;
nothing needs to be hand-added here.

The script never overwrites good data with nothing: if either source fails, that
section keeps whatever was last committed and the run logs a warning. An empty
`upcoming` list is treated as a real answer (we're between shows), and the page
has a state for it. It also leaves both files untouched when nothing meaningful
changed, so the cron doesn't commit a new timestamp six times a day.

Each past-show tile renders that event's Luma cover art. The API hands back a
full-size original (some are 800KB+), so `lumaThumb()` in `main.js` splices a
`/cdn-cgi/image/<opts>/` segment into the path — Cloudflare's image resizer,
which is the same mechanism Luma's own event rows use. That returns a cropped
square: the July cover goes from 836KB to 31KB, and nine of them cost ~234KB
total. `images.lumacdn.com` sends `access-control-allow-origin: *` and no CORP
header, so they hotlink directly with no proxy. A cover that fails to load
removes its own frame rather than leaving a broken-image glyph in the grid.

`sponsorship.html` shares the same numbers — the "shows produced" and "tickets
claimed" metric cards carry `data-stat` attributes and are filled from the same
data, so they can't drift from the landing page.

### Editing the sponsorship page

Everything on `sponsorship.html` other than those two figures is hand-written
copy, sourced from the event brief we send prospective sponsors. If the brief
changes — attendee ranges, the run of show, what's in each package — edit that
page directly; nothing there is generated.

## Optional hero video wall

The hero runs a cross-fading photo slideshow by default — deliberately, so it
can't break the way the old YouTube embeds could.

Drop a web-sized reel at **`media/hero.mp4`** and it turns into the video wall
instead: the old three-parallel-YouTube-shorts look, rebuilt on one self-hosted
file. `fetch-data.mjs` notices the file on disk and sets `heroVideo` in
`site.js`; `main.js` then points all three columns at that one URL — so it is
downloaded once and the other two columns come out of cache — and seeks each
column to a different third of the runtime. **That seek is the whole effect.**
Without it you get three identical panes rather than a wall. The offset survives
looping on its own: every column advances at the same rate, so the phase
difference between them is invariant and only needs setting once.

No file, no request. If it fails to load, autoplay is refused, the visitor has
`prefers-reduced-motion` on, or Save Data is set, the photos stay.

On screens ≤700px the wall drops to a single column — three landscape panes on a
390px phone are slivers, and three simultaneous h264 decodes is real jank for
decoration. `main.js` reads the computed `display` and never gives the hidden
columns a `src`, so a phone fetches and decodes one video, not three.

Encode from a source reel in Drive:

```sh
ffmpeg -i SOURCE.mp4 -t 20 -an \
  -vf "scale=1600:-2,fps=24" \
  -c:v libx264 -crf 30 -preset slow -movflags +faststart \
  media/hero.mp4
```

`-an` matters: the wall autoplays, and autoplay is only permitted while muted.
Keep it short and ideally under ~4 MB — it's decoration, GitHub Pages has a soft
1 GB repo limit, and a hard 100 MB per-file one. Then `node scripts/fetch-data.mjs`
to flip `heroVideo` on.

To check the columns really are offset, the honest test is to read the times back
rather than eyeball it through the scrim:

```js
document.querySelectorAll('#hero-wall .hero__video').forEach((v, i) =>
  console.log(i, v.currentTime.toFixed(2), v.paused));
```

Three different numbers, none paused. Same numbers means the seek didn't take.

## Assets come from Google Drive

Design source of truth is the NSDS Drive folder, not this repo:

- `Assets/Web assets/SVG/` — brand SVGs. `Icon`, `Header-OneLine`,
  `Header-TwoLine` and two Squigs are copied into `media/brand/`. The rest of
  the Squig family (XL/L1/L2/M2/M3/S2) is unused so far — reach for those before
  drawing new decoration.
- `Media/Photo kit (select photos)/` — source photos.
- `Assets/Brand Notes.gdoc` — the palette and shape rules encoded at the top of
  `style.css`.

**Reads from Drive are unreliable.** The files are File Stream placeholders and
a read can silently return empty content, or time out entirely, while `stat`
still reports the true size. If you need a file and the filesystem won't give it
up, open the folder in Finder (or mark it available offline) to force the
download first.

Adding a photo — work on the original wherever it landed, and commit only the
two files a page will reference:

```sh
ffmpeg -i photo.jpg -vf scale=1600:-2 -q:v 3 media/opt/name-1600.jpg
cwebp -q 80 -resize 1600 0 photo.jpg -o media/opt/name-1600.webp
```

Crop before scaling if the shot needs it — `-vf "crop=W:H:X:Y,scale=1600:-2"`,
and pass the cropped file to `cwebp` so both formats frame identically.
`media/opt/` had a set of `-800` variants that nothing ever referenced; if you
add a real `srcset` later, generate them then rather than by habit. The root
`.gitignore` drops `*.jpg`/`*.png` so an original left lying there can't be
committed by accident.

## Git

This repo belongs to the **Desitrain22** (personal) account while the machine's
default git identity is work. Commit and push through `gituse personal`, e.g.
`gituse personal git push` — see `~/.claude/CLAUDE.md`.
