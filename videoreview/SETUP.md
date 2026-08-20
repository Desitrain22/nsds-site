# Going live — checklist

Two services to stand up, neither needing a Google Cloud project. Budget ~30 minutes, plus a
background transcode. Nothing secret is committed: both secrets live in the services, and the
two URLs live in your browser's `localStorage`.

Pick your passphrase first and use the same string in steps 1 and 2 — the page sends one phrase
to both. Referred to below as `<PHRASE>`.

---

## 1. Apps Script — the clip notes

- [ ] Go to [script.google.com](https://script.google.com) → **New project**, rename it `NSDS Tape Review API`
- [ ] Paste `videoreview/apps-script/Code.gs` over the default `Code.gs`, save
- [ ] **Project Settings** → **Script properties** → **Add script property**: `PASSWORD` = `<PHRASE>`
- [ ] **Deploy** → **New deployment** → gear → **Web app**
  - [ ] Description: anything
  - [ ] **Execute as: Me**
  - [ ] **Who has access: Anyone**  ← not "Anyone with a Google account"
- [ ] **Deploy**, then authorize. It asks for Sheets + Drive because it lists tape folders and
      creates the request sheet. You'll get an "unverified app" screen — **Advanced → Go to … (unsafe)**
- [ ] Copy the `/exec` URL
- [ ] Smoke test — must be JSON, not an HTML sign-in page:

      curl -sL "<EXEC_URL>"
      # want: {"ok":true,"service":"nsds-tape-review",...}

If you get HTML, access isn't set to **Anyone**. If you get `no PASSWORD script property set`,
step 3 above didn't save.

## 2. Cloudflare Worker — the video

Needed because Drive returns **403 + HTML** to any browser request for file bytes
(`Sec-Fetch-Site: cross-site`, which JS cannot remove). A server-side fetch doesn't send it.

- [ ] Cloudflare dashboard → **Workers & Pages** → **Create** → **Start with Hello World** → **Deploy**
- [ ] **Edit code**, paste `videoreview/worker/tape-proxy.js` over the default, **Deploy**
- [ ] **Settings** → **Variables and Secrets** → **Add**: `TAPE_TOKEN` = `<PHRASE>` (same as above)
- [ ] Copy the `*.workers.dev` URL
- [ ] Smoke test against a known-public file:

      curl -si "<WORKER_URL>?t=<PHRASE>&id=15ImF8vb_qHXtsR2rAz1tZ4ZCwj0JgqJq" \
        -H 'Range: bytes=0-99' | head -5
      # want: HTTP/2 206  +  content-type: video/mp4

`503 TAPE_TOKEN is not set` means the secret didn't save — it fails closed on purpose, so it
can never run as an open proxy for anyone's Drive.

## 3. Point the page at them

- [ ] Open <https://techcomedyshow.com/videoreview/>
- [ ] Click **Backend settings**, paste the `/exec` URL and the Worker URL, **Save**
- [ ] Enter `<PHRASE>` at the gate

Both URLs are stored per-browser, so each performer pastes them once. (If that turns out to be
annoying, the next step is baking them into a query string you can hand out as one link.)

## 4. Build the 480p proxies

The 4K masters cannot stream — Drive throttles anonymous reads to ~1 MB/s and a 76 Mbps master
needs ~9.5 MB/s, so seeks stall for tens of seconds. A 480p proxy is ~94 MB at 1.6 Mbps and
seeks instantly, with the duration preserved exactly so timestamps still line up 1:1.

- [ ] `node tools/make-proxies.mjs apr2026`

~16 min per tape, so ~2.5 hours for April's nine, entirely network-bound. Safe to re-run —
finished proxies are skipped unless you pass `--force`. Proxies land in a `Proxies` subfolder of
the show folder and inherit its "anyone with the link" sharing.

- [ ] Repeat per show as needed: `mar2026nyc feb2026 mar2026sf may2026bos jun2026sf jun2026nytw jun2026avocarilla jul2026nyc`

## 5. Check it end to end

- [ ] Open a tape that has a proxy — the badge should read **480p**, and scrubbing should be instant
- [ ] Make a clip with **two** ranges, save, hard-reload, confirm both come back
- [ ] Open the show's sheet (**Open sheet ↗**) and confirm `A`–`G` look like the February/March
      sheets your editors already read, with the `⚙` columns greyed out to the right
- [ ] `node videoreview/test.mjs` → 55 passed

## Before sharing the link widely

- Tapes must be **"Anyone with the link"**. The tape list flags any that aren't; the player
  can't load them. April's nine already were.
- Security here is thin on purpose: the phrase is checked server-side so the sheet isn't
  readable without it, but the page is public and the tapes are world-readable via their Drive
  links regardless. It keeps honest people honest; it is not access control.

## Local development

    node videoreview/dev-server.mjs        # http://localhost:8787, passphrase "dev"

Stands in for both services so you can work without deploying: it runs the real Worker handler
against real Drive bytes, and stores clips in `videoreview/.dev-clips.json` instead of your
Sheet. Pass `NSDS_PASSWORD=<PHRASE>` to match production.
