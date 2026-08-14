# notsodailystandup.com

Static site for **Not So Daily Stand Up** (a.k.a. *Artificially Unintelligent*),
the tech comedy show. No build step, no framework — GitHub Pages serves the
files in this repo directly off `main`.

```
index.html          landing page — shows, Instagram, past shows
sponsorship.html    the sponsor pitch (metrics, format, packages)
perform.html        embedded performer application form
style.css           design system (tokens straight from the Brand Notes doc)
main.js             renders shows / posts / stats
data/site.json      committed data, refreshed by a GitHub Action
data/site.js        same data as a <script> — this is what the pages load
scripts/fetch-data.mjs
media/brand/        brand SVGs from Drive
media/opt/          optimized photos (webp + jpg)
media/ig/           Instagram thumbnails, committed
```

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

The page never calls Luma or Instagram from the browser. Neither API sends CORS
headers, and hitting them per-visitor would get us rate limited — so the Action
makes that request once and commits the answer.

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

`sponsorship.html` shares the same numbers — the "shows produced" and "tickets
claimed" metric cards carry `data-stat` attributes and are filled from the same
data, so they can't drift from the landing page.

### Editing the sponsorship page

Everything on `sponsorship.html` other than those two figures is hand-written
copy, sourced from the event brief we send prospective sponsors. If the brief
changes — attendee ranges, the run of show, what's in each package — edit that
page directly; nothing there is generated.

## Optional hero video

The hero runs a cross-fading photo slideshow by default — deliberately, so it
can't break the way the old YouTube embeds could.

To use a highlight reel instead, drop a web-sized file at **`media/hero.mp4`**
and push. `fetch-data.mjs` notices it on disk and sets `heroVideo` in
`site.json`; the page then fades it in over the photos once it can actually
play. No file, no request — and if it fails to load or the visitor has
`prefers-reduced-motion` on, the photos stay. Suggested encode from a source
reel in Drive:

```sh
ffmpeg -i SOURCE.mp4 -t 20 -an \
  -vf "scale=1600:-2,fps=24" \
  -c:v libx264 -crf 30 -preset slow -movflags +faststart \
  media/hero.mp4
```

Keep it short, silent, and ideally under ~4 MB — it's decoration, and GitHub
Pages has a soft 1 GB repo limit.

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
download first. Photos in `media/` were pulled while it was cooperating.

Re-optimizing a new photo:

```sh
ffmpeg -i photo.jpg -vf scale=1600:-2 -q:v 3 media/opt/name-1600.jpg
cwebp -q 80 -resize 1600 0 photo.jpg -o media/opt/name-1600.webp
```

## Git

This repo belongs to the **Desitrain22** (personal) account while the machine's
default git identity is work. Commit and push through `gituse personal`, e.g.
`gituse personal git push` — see `~/.claude/CLAUDE.md`.
