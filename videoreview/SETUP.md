# Going live — checklist

One service to deploy, one upload per show. No Google Cloud project, no third-party account,
nothing to pay for. Nothing secret is committed: the passphrase lives in the Apps Script
project, and the backend URL lives in your browser's `localStorage`.

Pick your passphrase first — referred to below as `<PHRASE>`.

---

## 1. Apps Script — the clip notes

- [ ] [script.google.com](https://script.google.com) → **New project** → rename `NSDS Tape Review API`
- [ ] Paste `videoreview/apps-script/Code.gs` over the default `Code.gs`, save
- [ ] **Project Settings** → **Script properties** → **Add script property**: `PASSWORD` = `<PHRASE>`
- [ ] **Deploy** → **New deployment** → gear icon → **Web app**
  - [ ] **Execute as: Me**
  - [ ] **Who has access: Anyone**  ← not "Anyone with a Google account"
- [ ] **Deploy**, then authorize. It wants Sheets + Drive because it lists tape folders and
      creates the request sheet. You'll hit an "unverified app" screen —
      **Advanced → Go to NSDS Tape Review API (unsafe)**
- [ ] Copy the `/exec` URL
- [ ] Smoke test — must be JSON, not an HTML sign-in page:

      curl -sL "<EXEC_URL>"
      # want: {"ok":true,"service":"nsds-tape-review",...}

`HTML` back means access isn't **Anyone**. `no PASSWORD script property set` means the property
didn't save — it fails closed on purpose rather than briefly accepting writes with no credential.

## 2. Get the tapes onto YouTube

Drive cannot serve video to a web page at all: it returns **403 + an HTML error page** to any
request carrying `Sec-Fetch-Site: cross-site`, which is browser-controlled and impossible to
remove from JS. Apps Script can't bridge it either — text-only MIME types, a ~50 MB response
cap, and no HTTP `Range` support, so no seeking. YouTube needs no extra infrastructure,
transcodes for you, and its player API exposes exactly what clip marking needs.

- [ ] Prepare the uploads:

      node tools/publish-tapes.mjs apr2026

      Downscales each master to 1080p into `~/NSDS-youtube-upload/apr2026/`, named after the
      performer so YouTube's default titles are already right. ~15 min per tape, network-bound,
      resumable — already-staged files are skipped unless you pass `--force`. Add
      `--height=720` for smaller uploads.

      Why not upload the masters directly: they're 4–7 GB each, ~40 GB for April. 1080p is
      ~3 GB total and still gives YouTube enough to build a real quality ladder, so performers
      can sit at 360p on bad wifi or bump to 1080p. Duration is preserved exactly, so every
      timestamp still lines up with the master.

- [ ] Open <https://youtube.com/upload> and drag the whole folder in
- [ ] Set **Visibility → Unlisted** — select all and bulk-edit. **Not Private**: private videos
      will not play in an embedded player
- [ ] Tick "No, it's not made for kids" if prompted, otherwise leave defaults
- [ ] Once processed, copy each video's id from its URL (`youtu.be/<ID>` or `watch?v=<ID>`)
- [ ] Paste them into `YOUTUBE` in `videoreview/shows.js` — the script prints a ready-to-fill
      block keyed by Drive filename, so you just drop the ids in:

      export const YOUTUBE = {
        apr2026: {
          'DavidS_4-23-26.mp4': 'abc123XYZ',
          ...
        },
      }

- [ ] Commit and push, so Pages picks it up

Uploading is manual because the YouTube Data API needs a Google Cloud project and an OAuth
client — the exact thing this design avoids. It's a once-per-show job.

## 3. Point the page at the backend

- [ ] Open <https://techcomedyshow.com/videoreview/>
- [ ] Click **Backend settings**, paste the `/exec` URL, **Save**
- [ ] Enter `<PHRASE>` at the gate

Stored per-browser, so each performer pastes it once. (If that gets annoying, the next step is
baking it into a query string you can hand out as a single link.)

## 4. Check it end to end

- [ ] Open a tape — it should play, and the quality menu should offer up to 1080p
- [ ] Make a clip with **two** ranges, save, hard-reload, confirm both come back
- [ ] **Open sheet ↗** — columns `A`–`G` should look like the February/March sheets your editors
      already read, with the `⚙` columns greyed out to the right
- [ ] `node videoreview/test.mjs` → 55 passed

## Notes before sharing the link

- **Unlisted, not private.** Unlisted embeds fine; private returns error 100 and the player
  says so. Anyone with the YouTube link can watch, which is the same posture as the Drive links
  today.
- Security is thin on purpose: the phrase is checked server-side so the sheet isn't readable
  without it, but the page itself is public. It keeps honest people honest; it is not access
  control.
- The masters stay in Drive untouched. YouTube only ever holds the 1080p viewing copy, and the
  sheet is still the single source of truth for notes.

## Local development

    node videoreview/dev-server.mjs        # http://localhost:8787, passphrase "dev"

Stands in for Apps Script so you can work without deploying — real tape lists via rclone, clips
written to `videoreview/.dev-clips.json` instead of your Sheet. Pass `NSDS_PASSWORD=<PHRASE>` to
match production. Two extra pages: `/playertest` exercises the player against a public video,
and `/?selftest=1` drives the whole UI and prints a report.
