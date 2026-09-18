# Third-party services

What this project talks to, what each one is trusted with, and where the wiring lives.

This file deliberately names **no folder ids, file ids, share links or sheet ids**. Several of the
Drive items behind them are shared "anyone with the link", which makes an id a credential rather
than a name. See [SECURITY.md](SECURITY.md) for the rules about ids.

## The short version

There is no server. A static site on GitHub Pages, one Google Apps Script web app as the only
backend, and a handful of zero-dependency scripts that run on a maintainer's laptop.

```
techcomedyshow.com ──► GitHub Pages (static, from main)
        │
        ├── /videoreview              ──► Apps Script ──► Drive + Sheets
        │     performers: review a tape, leave clip requests   (PASSWORD)
        │
        └── /videoreview/upload.html  ──► Apps Script ──► creates the show folder + sheet,
              videographers: paste a folder link              files a submission   (UPLOAD_KEY)
                                                          ▲
laptop: tools/*.mjs, tools/*.py ──► rclone ───────────────┘
                                 └─► YouTube Data API (unlisted proof tapes)
                                 └─► Dropbox public share links (incoming footage)
```

Two front doors, two secrets, one backend. A submission is a small immutable JSON file in
`NSDS/Media/_uploads/`; `tools/nsds_ingest.mjs` drains it. Nothing large ever passes through Apps
Script — `UrlFetchApp` caps a response at 50 MB and a tape is 4–10 GB.

## Services

| Service | Trusted with | Wiring |
|---|---|---|
| **GitHub Pages** | Serving the public site off `main`. No build step. | `CNAME` |
| **GitHub Actions** | One scheduled job: refresh show data every 6h and commit it. | `.github/workflows/refresh-data.yml` |
| **GitHub Actions** | Deploys the Apps Script backend on every change to it, so a merged fix is live without anyone running a script. Holds `clasp`'s OAuth tokens as `CLASPRC_JSON`; holds no passphrase. | `.github/workflows/deploy-backend.yml` |
| **Luma** | Source of truth for upcoming/past events. Read-only, public profile feed. | `scripts/fetch-data.mjs` → `data/site.js` |
| **Google Apps Script** | The whole backend: list shows and tapes, read and write clip-request rows. Runs as the owner's personal Google account with full Drive + Sheets scope, reachable by anyone, gated by a shared passphrase. | `videoreview/apps-script/` · deployed by `tools/deploy-backend.sh` |
| **Google Drive** | Every master tape, photo, finished clip, and each show's `youtube.csv`. Reached two independent ways: `DriveApp` inside Apps Script, and `rclone` from the laptop tools. | `tools/lib/tapes.mjs` (rclone) · `Code.gs` (DriveApp) |
| **Google Sheets** | One clip-request sheet per show. Columns A–G are the contract with the editing team; H–L are machine columns; M holds a finished-clip link. | template built in `Code.gs` |
| **YouTube Data API v3** | Uploading each set tape as an **unlisted** proof video, so the review page has something playable. Drive cannot serve video to a web page, which is the whole reason this exists. | `tools/youtube-sync.mjs` |
| **Dropbox** | Incoming footage from videographers, as public folder share links. Read-only, and enumerated through the same private endpoint the Dropbox web app uses, because the share page is client-rendered. | `tools/nsds_fetch.py` |
| **Dropbox** (portal) | The same links, but pasted by the videographer into `/videoreview/upload.html` and enumerated server-side so they can confirm the file list before anything moves. | `videoreview/upload.js` · `uploadPreview` in `Code.gs` |

## Why YouTube is in the loop at all

Drive returns 403 and an HTML error page to any video request carrying `Sec-Fetch-Site:
cross-site`, which is browser-controlled and cannot be removed from JavaScript. Apps Script can't
bridge it either. So masters live in Drive, and a 1080p proof copy of each set tape is mirrored to
an unlisted YouTube video that the review page embeds. `youtube.csv`, written into each show's Drive
folder and keyed on Drive **file id** so it survives moves and renames, is the record of which tape
became which video.

Uploads are rate-limited by YouTube's daily quota — a handful of videos per night. There is a
quota-free manual path (`--stage-all`, drag into the browser, then `--adopt`) for when that is too
slow; see `tools/README.md`.

Whole-show recordings are never mirrored. A proof tape is meant to be one comic's set, and a
full-show file would burn most of a night's quota while per-performer tapes wait behind it.

## Credentials

Four unrelated Google identities. **None of them is stored in this repository**, and none should
ever be:

| Credential | Used by | Where it lives |
|---|---|---|
| YouTube OAuth (installed-app) | `tools/youtube-sync.mjs` | `~/.config/nsds/`, mode `0600`, refresh token only |
| rclone OAuth | every Drive read/write in `tools/` | `~/.config/rclone/rclone.conf` |
| Apps Script authorization | the backend itself | Google-side. Nothing on disk — that is the point of running it as a web app rather than a script with a stored token. |
| `clasp` login | deploying the backend, locally and in CI | `~/.clasprc.json`, mirrored into the `CLASPRC_JSON` GitHub secret |

Two shared secrets gate the backend, both stored as Apps Script **script properties** and set once
at deploy time:

- `PASSWORD` — the performer passphrase. Unlocks reading shows and tapes, and reading and writing
  clip-request rows.
- `ADMIN_KEY` — a separate secret required *in addition to* the passphrase for every `admin*`
  action (the Drive layout operations). Both are checked; one alone is refused.
- `UPLOAD_KEY` — the videographer portal's key, and the **only** secret its actions accept. Not the
  passphrase, deliberately: a videographer can file footage without being able to read anyone's
  clip requests, and rotating one does not disturb the other.

All three are set and rotated by `tools/keys.sh`, which stores them in the macOS Keychain and
nowhere else on disk. It authenticates to the backend by writing a nonce into `NSDS/Media/_ops/`
rather than by presenting a key, so a key that has been lost can still be replaced — see
`tools/README.md`.

The backend's `/exec` URL is committed on purpose. Without the passphrase it answers
`{"ok":false,"error":"bad password"}` to everything, and it fails **closed** — if the property is
unset it refuses rather than allowing.

## Where state lives outside the repo

| What | Where | Notes |
|---|---|---|
| Per-show upload ledger | `<show>/youtube.csv` in Drive | keyed on Drive file id; re-runs are safe |
| Transcode/staging cache | `~/NSDS-youtube-upload/` | deleted per file after a successful upload |
| Dropbox staging | `~/NSDS-transfer-staging/` | resumable; not deleted automatically |
| Upload submissions | `NSDS/Media/_uploads/<key>/` in Drive | `submission.json` written once by the backend; `status.json` owned by the drain loop |
| Per-file ingest staging | `~/NSDS-transfer-staging/ingest/` | one file at a time, deleted after each |
| Nightly sync logs | `~/Library/Logs/nsds/` | |
| The nightly job itself | `~/Library/Application Support/nsds/youtube-sync/` | a copy, not the repo: launchd agents do not inherit Terminal's TCC grant for `~/Documents`, so running it from the checkout fails with `EPERM` |

## Design source of truth

Brand assets and source photos are **not** in this repo — they live in the NSDS Google Drive
folder. See `CLAUDE.md` for how to read them reliably; Drive File Stream placeholders can
silently return empty content.
