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
data/site.json      committed data, refreshed by a GitHub Action
data/site.js        same data as a <script> — this is what the pages load
scripts/fetch-data.mjs
worker/             optional Cloudflare Worker for live per-visit data
media/brand/        brand SVGs from Drive
media/opt/          optimized photos (webp + jpg)
media/ig/           Instagram thumbnails, committed
media/sponsors/     sponsor logos — see ASSETS.md there for provenance
media/hero.mp4      optional hero video
```

Everything in the repo is something a page loads. Full-resolution originals and
source art are **not** kept here — they live in Drive, and old ones are still in
git history if you need them back (`git log --diff-filter=D --name-only` to find
the commit, then `git show <sha>^:media/crowdpic.jpg > crowdpic.jpg`).

**Just open `index.html`** — double-clicking it works, no server needed. The
pages load their data from `data/site.js`, which assigns a global, rather than
fetching `data/site.json`. A classic `<script>` is exempt from the CORS rules
that make both `fetch()` and module scripts fail on a `file://` URL, so the
site behaves the same off disk as it does on Pages. `npm run dev` still gives
you a server on <http://localhost:8899> if you want one.

## Shows and Instagram update themselves

`.github/workflows/refresh-data.yml` runs every 6 hours, executes
`scripts/fetch-data.mjs`, and commits the result if anything changed. You can
also trigger it by hand from the Actions tab, or run `npm run fetch` locally.

The page never calls Luma or Instagram directly from the browser — it can't, as
neither sends us CORS headers. The Action makes that request once and commits
the answer. (For live per-visit data on top of this baseline, see the Worker
section below; the page still never talks to either API itself.)

**Luma** — `api.lu.ma/user/profile/events-hosting`, for user
`usr-5IoinAmtej3Z8xe` (that's `luma.com/user/TechComedyShow`). Upcoming and past
are fetched separately. Anything on that Luma automatically appears on the site;
nothing needs to be hand-added here.

**Instagram** — two routes, picked automatically:

| | used when | ordering |
|---|---|---|
| Graph API (`graph.instagram.com`) | `IG_TOKEN` is set — i.e. in CI | 3 most recent |
| `web_profile_info` | no token — i.e. `npm run fetch` locally | 3 **pinned** first |

The unofficial `web_profile_info` endpoint is the nicer one (no token, and it
returns pinned posts first) but Instagram **429s it from GitHub's runners**,
whose datacenter IPs it rate-limits. A token is tied to the account rather than
the caller's IP, so the scheduled run needs one. It also 400s unless the request
carries a `referer` of the profile page — if the local path ever breaks, check
that header first.

If the Graph call fails for any reason the script falls back to the web
endpoint, so an expired token degrades to "still works locally" rather than
silently freezing the section.

Thumbnails are downloaded into `media/ig/` because Instagram's CDN URLs are
signed and expire after a few weeks.

### Minting `IG_TOKEN`

Needs the Instagram account to be **Business or Creator** (Instagram → Settings
→ Account type). Then:

1. <https://developers.facebook.com/apps> → **Create app** → type **Business**.
2. Add the **Instagram** product → **API setup with Instagram login**.
3. Under *Generate access tokens*, add the `@notsodailystandup` account and
   generate. That string is a long-lived token.
4. `gituse personal gh secret set IG_TOKEN` (paste when prompted), or
   Settings → Secrets and variables → Actions.

Long-lived tokens last **60 days**. Refresh before it lapses:

```sh
curl -s "https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=$OLD" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])'
```

then set the secret again. Until a token exists the workflow still refreshes
Luma every run and just leaves the Instagram posts as last committed.

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

## Optional: live data on every page load

The committed copy above is the baseline and always renders. `worker/` is a
~200-line Cloudflare Worker that additionally makes the shows and posts **live
per visit**: the page paints the committed data instantly, then re-asks the real
APIs and repaints. Stale-while-revalidate — no loading spinner, and every
failure (no Worker, offline, upstream 429, `file://`) just leaves the committed
render alone.

It exists because the browser cannot call either API directly, and that isn't
something code can work around:

- **Luma** allowlists origins and reflects back only its own. `Origin:
  https://luma.com` gets `access-control-allow-origin: https://luma.com`;
  `Origin: https://notsodailystandup.com` gets no header at all, so the browser
  discards the response.
- **Instagram** is blocked outright *and* only answers when the request carries
  a `referer` of the profile page — a [forbidden header] that page scripts are
  not permitted to set. Even with CORS open it would 400.

[forbidden header]: https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_header_name

The Worker also re-serves Instagram thumbnails from `/thumb`. Their CDN sends
`Cross-Origin-Resource-Policy: same-origin`, so a browser refuses to paint those
URLs in an `<img>` on our page even though the bytes are public — the Worker
strips that header. It's restricted to `cdninstagram.com` and `fbcdn.net` so it
stays a thumbnail shim rather than an open image proxy.

```sh
cd worker
npx wrangler deploy          # first run opens a browser to log in
```

Then put the deployed URL in the `API` constant at the top of `main.js`:

```js
var API = 'https://nsds-api.yourname.workers.dev';
```

Leave it `null` and the Worker is simply never called — no request, no error.
Free tier covers 100k requests/day; responses are edge-cached (5 min for shows,
15 for posts) so a traffic spike collapses into one upstream call. Only these
origins may call it, set in `ALLOWED` in `worker/index.js`:
`notsodailystandup.com`, `www.notsodailystandup.com`, `desitrain22.github.io`,
and any `localhost` port for local work.

`npx wrangler dev` runs it on :8787 without deploying, which is how it was
verified: both routes returned real data, `/thumb` served an image with
`cross-origin-resource-policy: cross-origin`, and a non-Instagram host got a 403.

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
`site.json`; `main.js` then points all three columns at that one URL — so it is
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
