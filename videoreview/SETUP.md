# Going live — checklist

One service to deploy, one upload per show. No Google Cloud project, no third-party account,
nothing to pay for. Nothing secret is committed: the passphrase lives in the Apps Script
project, and the backend URL lives in your browser's `localStorage`.

Pick your passphrase first — referred to below as `<PHRASE>`.

---

## 1. Apps Script — the clip notes

Two browser steps, once, as **nealpareshpatel@gmail.com**. Everything else is one command.

- [ ] `clasp login` — opens a Google sign-in popup; pick the personal account
- [ ] <https://script.google.com/home/usersettings> → turn **Google Apps Script API** on
- [ ] `NSDS_ADMIN_KEY="$(openssl rand -hex 24)" tools/deploy-backend.sh '<PHRASE>'` — save that key
      somewhere private; it unlocks the migration actions below and is never in the repo

That creates the project, pushes `Code.gs` + `appsscript.json` (which pins *Execute as Me /
Anyone* and the Sheets + Drive scopes as code rather than clicks), deploys it as a web app, sets
the passphrase, smoke-tests it against the April folder, and writes the `/exec` URL into
`videoreview/shows.js`. Re-running it pushes a new version to the *same* deployment, so the URL
never changes.

- [ ] Commit `shows.js` and push. Performers now need only the link and the passphrase.

The passphrase lives in the Apps Script project's **Script properties** (Project Settings), never
in the repo. To rotate it, change it there. The `/exec` URL *is* committed — it's harmless
without the phrase.

The first `clasp push` may ask you to authorize the script's scopes in a browser; that's the
one-time consent for Sheets + Drive. You'll see an "unverified app" screen — **Advanced → Go to
NSDS Tape Review API (unsafe)**.

## 2. Get the tapes onto YouTube — automated

Drive cannot serve video to a web page at all: it returns **403 + an HTML error page** to any
request carrying `Sec-Fetch-Site: cross-site`, which is browser-controlled and impossible to
remove from JS. Apps Script can't bridge it either. So tapes go to YouTube as **unlisted**
uploads on the Tech Comedy Show channel (`hello@notsodailystandup.com`), and
`tools/youtube-sync.mjs` keeps that mirror up to date on a nightly schedule.

Uploading through the API needs a Google Cloud OAuth client. One-time, ~10 minutes, as
**hello@notsodailystandup.com**:

- [ ] <https://console.cloud.google.com/projectcreate> → name `nsds-youtube` → Create
- [ ] **APIs & Services → Library** → search **YouTube Data API v3** → **Enable**
- [ ] **APIs & Services → OAuth consent screen** → **Get started** → app name `NSDS Tape Sync`,
      support email hello@ → Audience: **Internal** (it's a Workspace account; Internal means no
      "unverified app" screen and the refresh token never expires) → Create
- [ ] **Clients → Create client** → type **Desktop app** → name `youtube-sync` → Create →
      **Download JSON**
- [ ] Save that file as `~/.config/nsds/youtube-client.json`
- [ ] `node tools/youtube-sync.mjs --auth` → sign in as hello@ in the popup → Allow

Then:

- [ ] `node tools/youtube-sync.mjs --dry-run` — lists every tape it will upload
- [ ] `node tools/youtube-sync.mjs` — uploads up to 6 today (the API allows ~6/day: each
      upload costs 1,600 of the default 10,000 daily units), writes `youtube.csv` into each
      show's Drive folder, and stops cleanly at the quota
- [ ] `node tools/youtube-sync.mjs --install-cron` — launchd job, daily 03:30, logs to
      `~/Library/Logs/nsds/youtube-sync.log`. Clears the ~40-tape backlog in about a week,
      then just keeps up with new shows.

What it does per tape: downscale to 1080p (the 4–7 GB masters would be ~40 GB of upload for
April alone; 1080p is ~3 GB and still gives YouTube a real quality ladder), upload unlisted with a
minimal description, then record `file_id,filename,performer,youtube_id,youtube_url,...` in
`<show folder>/youtube.csv`. Keyed on Drive file id, so it survives the folder reorganisation.
The page reads that CSV through Apps Script — nothing to paste anywhere.

launchd does not run while the Mac is asleep; a missed night simply runs the next one.

## 3. Open it

- [ ] <https://techcomedyshow.com/videoreview/> → enter `<PHRASE>`

The backend URL is baked in by step 1, so there's nothing to configure. **Backend settings** on
the gate is only an override for local development.

## 3b. Keeping Drive tidy — one folder per show

Every show folder holds `tapes/`, `photos/`, `completed_clips/` (and `extras/` for reels), plus the
request sheet in its root, under `Media/<year>/<show>/`. The page finds tapes in `tapes/`, links
**Photos ↗** and **Finished clips ↗** to the other two, and never lists a finished clip as a tape.

For a new show, drop the raw footage anywhere in its folder and run:

```sh
export NSDS_PASSWORD='<PHRASE>' NSDS_ADMIN_KEY='<the key from step 1>'
node tools/reorg-show.mjs <show>            # dry run: shows every rename/move
node tools/reorg-show.mjs <show> --apply    # does it, appends to tools/reorg-log.jsonl
```

Then paste the three `…FolderId` lines it prints into that show's entry in `shows.js`. It renames
legacy folders in place (`Set Tapes`→`tapes`, `Flicks`→`photos`) so no Drive id ever changes —
every existing link, `youtube.csv` key and sheet reference keeps working. It never deletes.

To pull hand-typed request rows into the app as editable clips:

```sh
node tools/admin.mjs adopt <show>           # dry run, one verdict per row
node tools/admin.mjs adopt <show> --apply   # writes ONLY the machine columns H..L
```

Rows are adopted only when unambiguous: both times parse as exactly one timestamp each (a cell
with blank Start/End whose granular column lists ranges is adopted as exactly those ranges; a cell
like "3:15 or 5:33" is refused, never glued together), the end is inside the tape's real duration
(read from Drive), and the performer resolves to exactly one tape. Everything else is reported
with a reason. A performer's first Save afterwards re-renders A–G from the structured
clip — canonical `m:ss`, a removal re-expressed as the kept pieces.

Sheets from 2024 and early 2025 predate the A–G layout ("Name | Timestamp | Quote | Notes"). They
are never edited; their rows are copied into a fresh canonical sheet instead:

```sh
node tools/admin.mjs ensure-sheet <show> --create-new --apply   # new "<Show> Tape Requests" in the show root
# pin it in shows.js: sheetId → the new id, legacySheetId → the old id
node tools/admin.mjs import-legacy <show>                      # dry run: header row found, one verdict per row
node tools/admin.mjs import-legacy <show> --apply              # writes the IMPORT rows as app-owned clips
```

The page links the old sheet as **Older requests ↗**. A show whose only tape is the full-show
recording assigns every row to it. A cell listing several ranges ("4:23 - 4:27, 4:32 - 4:40") becomes
one clip with several ranges. Rows without an end time, with two unrelated times, or past the tape's
duration are reported and left where they are.

## 4. Check it end to end

- [ ] Open a tape that's in `youtube.csv` — it should play, with quality up to 1080p
- [ ] Make a clip with **two** ranges, save, hard-reload, confirm both come back
- [ ] **Open sheet ↗** — columns `A`–`G` should look like the February/March sheets your editors
      already read, with the `⚙` columns greyed out to the right
- [ ] `node videoreview/test.mjs` → 96 passed

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
