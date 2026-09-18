# NSDS transfer tools

Pulls show footage out of public Dropbox share links and pushes it into the
NSDS Drive, resumably, unattended, overnight.

```
nsds_fetch.py      enumerate + download from Dropbox (stdlib python3, no deps)
nsds_transfer.sh   fetch, then rclone upload to Drive, then verify
nsds_start.sh      start/status/stop, detached and caffeinated
```

## What it moves

| Show | Files | Size | Drive destination | Folder ID |
|---|---|---|---|---|
| April 2026 NYC | 132 | 48.4 GiB | April 2026 Tapes/Photos *(existed)* | `1bS6gBq5vcLFbbGNG-_qB-9yWuknChO6Y` |
| May 2026 Boston | 123 | 15.4 GiB | May 2026 Tapes/Photos (Boston) | `1J9A7CLVdD8tNsQwhBq2jSHSWP75zLsOg` |
| July 2026 NYC | 9 | 44.0 GiB | July 2026 Tapes/Photos (NYC) | `1jLpdaNRmhIFldwzf9fBnRBiw8lnDt2Vl` |

**264 files, 107.8 GiB.** All three destination folders live under
`NSDS / Media / 2026 Tapes/Photos`.

June 2026 NY Tech Week is **already done** — it was a Drive-to-Drive copy from
Ryan Dempsey's read-only `AUI_CITY WINERY` folder into `NYTW 2026 Media`, so it
never touched this pipeline.

## One-time setup

`rclone` is installed. It still needs to be pointed at a Google account:

```sh
rclone config create nsdsdrive drive scope=drive
```

That opens a browser once. **Sign in as the account that should own the
uploads** — uploaded files consume the *uploader's* storage quota, not the
folder owner's. 108 GiB will not fit in a free 15 GB account; you need Google
One 200 GB or better.

> **Heads up:** rclone warns that its *shared* Google client_id "is being
> retired and will stop working during 2026." It is currently August 2026. If
> auth fails or dies mid-run, make your own client_id (~10 minutes) and add
> `client_id`/`client_secret` to the remote:
> <https://rclone.org/drive/#making-your-own-client-id>

Check it worked:

```sh
rclone about nsdsdrive:          # should print used/free quota
```

## Running it

```sh
./nsds_start.sh          # start, detached
./nsds_start.sh status   # progress, staged size, power assertions
./nsds_start.sh stop     # stop; partials stay resumable
tail -f ~/NSDS-transfer-staging/logs/run.log
```

Everything stages in `~/NSDS-transfer-staging` first, then uploads. Staging is
**not** deleted automatically — spot-check Drive, then `rm -rf` it yourself.

Re-running is always safe. Completed files are skipped, half-downloaded files
resume from their exact byte offset, and rclone skips anything already on Drive
at the right size.

## About leaving it asleep

Honest answer: **a sleeping Mac transfers nothing.** `nsds_start.sh` holds a
`caffeinate -ims` assertion so the machine won't *idle*-sleep, but closing the
lid sleeps it regardless of any assertion.

So: **leave the lid open and stay on power.** The display is free to sleep.
If the machine does sleep, or the network drops, nothing is lost — the job
retries with backoff and resumes on wake.

Rough timing: ~21 MB/s per stream from Dropbox measured, 3 streams in parallel,
so the download is well under two hours. Upload speed depends on your upstream
and is usually the long pole.

## If something goes wrong

- **`rclone remote 'nsdsdrive:' is not configured`** — do the setup step above.
- **Quota failure before upload** — intentional. It checks `rclone about`
  first so you find out now rather than 90 GB in.
- **`fetch exited N`** — it will *not* upload a partial set. Just re-run.
- **A show reports files still incomplete** — re-run; only the gaps refetch.
- **Enumeration errors** are fatal by design. Silently transferring a
  *subset* of a show is the worst outcome here, so any listing that doesn't
  reconcile against Dropbox's own `total_num_entries` aborts loudly.

## Draining the upload portal

The portal (`videoreview/upload.html`) files a submission; this moves it:

```sh
node tools/nsds_ingest.mjs --dry-run      # what would move
node tools/nsds_ingest.mjs                # move it
node tools/nsds_ingest.mjs --only <key>   # one submission
```

It reads `NSDS/Media/_uploads/<submissionKey>/submission.json`, copies each file into that show's
`tapes/`, `photos/` or `extras/`, and writes `status.json` beside the submission as it goes.

Three things differ from `nsds_transfer.sh`, on purpose:

- **One file at a time, deleted after each.** `nsds_transfer.sh` fetches every show before
  uploading anything, so peak disk is the whole set — 108 GiB for the three 2026 shows. Per-file
  keeps it at one tape plus change, which is what makes this runnable on a small disk, and later
  on a small VPS without paying for a 200 GB volume.
- **Resume is derived, never read from `status.json`.** Each pass lists the destination folders and
  recomputes `manifest - {already there at the manifest's size}`. `status.json` is a progress cache
  for humans; deleting it loses nothing but the log. Same shape as `youtube.csv` versus Drive, and
  it means a killed run, a rebuilt machine, and a file dragged in by hand all converge.
- **A Drive source moves no bytes.** It is `rclone copyto --drive-server-side-across-configs`, the
  trick `upload_junesf()` already used, so a Drive-sourced show finishes in minutes.

It leans on two additive flags on `nsds_fetch.py`, so the Dropbox logic still lives in exactly one
place:

```sh
./nsds_fetch.py --enumerate-json '<share link>'      # -> {"files":[{path,bytes,href}],...}
./nsds_fetch.py --fetch-one --link '<share link>' \
    --href '<file href>' --bytes 4014816409 --dest /path/out.mp4
```

`--enumerate-json` still reconciles against Dropbox's own `total_num_entries` inside
`enumerate_share`, so a short listing raises rather than quietly becoming a short manifest.
`--fetch-one` is the same byte-exact resumable download the bulk path uses, including the
`200`-instead-of-`206` guard.

## The three backend keys

```sh
tools/keys.sh ship              # first time: all three, set + stored + printed once
tools/keys.sh rotate            # new values for all three
tools/keys.sh rotate uploadKey  # just one (password | uploadKey | adminKey)
tools/keys.sh show              # read them back out of the Keychain
tools/keys.sh status            # which are set on the backend (booleans, no values)
```

They live in two places and no others: the backend's **script properties**, and your **macOS
Keychain**. Never in this repo, never in a file, never in argv, never in shell history.

`ship` and `rotate` are the same operation — rotation is just setting them again — which is why
this is one script instead of two that drift apart.

### How it authenticates, and why that matters

Script properties can only be written from inside the Apps Script project, so setting one means
calling the backend with something it already trusts. Using a shared secret for that has a flaw
worth avoiding: lose the secret and you can never rotate it, and the only way back is editing
Project Settings by hand in a browser.

So `keys.sh` proves ownership by **writing to the Drive folder the app serves**: the backend names
a file, rclone creates exactly that file in `NSDS/Media/_ops/`, and the backend checks it exists
before rotating. The backend choosing the name is what makes it a write proof — a value the caller
picks and echoes back would only demonstrate the ability to *read* it, and everything in this
Drive is readable by anyone holding the id. Challenge and proof file are single-use and expire
after ten minutes.

The practical consequence: losing every secret is recoverable, and the prerequisites are your
local Google credentials (rclone for the nonce, `clasp login` as an ownership check) rather than a
passphrase you have to still possess.

Rotating `password` invalidates the phrase every performer already holds, so that one asks for
confirmation. The other two are held by one person each and are cheap to change.

## Notes for whoever edits this next

Dropbox share folders are listed through the same private endpoint the web app
uses (`list_shared_link_folder_entries`), because the share page is entirely
client-rendered — there is nothing to scrape from the HTML.

Three things about it are non-obvious and all three were bugs first:

1. It needs the `__Host-js_csrf` cookie echoed back as both the `t` form field
   and the `X-CSRF-Token` header, or it returns **403**.
2. Recursing needs each subfolder's **own** `secure_hash`, parsed out of that
   entry's `href`, *and* the `sub_path`. Passing `sub_path` against the root
   hash returns **404**.
3. It paginates at 30 entries. Resend with `voucher=<json.dumps of
   next_request_voucher>`. The param is `voucher`; using the name
   `next_request_voucher` silently re-returns page one forever. Missing this
   quietly cut 264 files down to 92.

On download, `?dl=1` redirects to a short-lived signed
`dl.dropboxusercontent.com` URL that honours `Range` (verified: `206` +
`Content-Range`). Never cache that signed URL across a retry — re-resolve from
the stable `www.dropbox.com` href. And if a resume attempt comes back `200`
instead of `206`, the server ignored the Range and is sending the whole file;
appending that to a partial silently corrupts it, so that case restarts.
