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
