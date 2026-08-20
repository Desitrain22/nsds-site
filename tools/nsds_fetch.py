#!/usr/bin/env python3
"""Download NSDS show footage from public Dropbox share links, resumably.

Stdlib only (macOS system python3.9). Safe to re-run: completed files are
skipped, partial files resume via HTTP Range.

  ./nsds_fetch.py --dry-run
  ./nsds_fetch.py --only "July 2026 NYC"
  ./nsds_fetch.py
"""
import argparse, errno, hashlib, http.cookiejar, json, os, random, re, shutil
import signal, sys, threading, time, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36")
ENDPOINT = "https://www.dropbox.com/list_shared_link_folder_entries"

# Dropbox share links. The `st=` param is a short-lived token and is
# deliberately omitted; `rlkey` is the durable one.
SHOWS = {
    "April 2026 NYC":  "https://www.dropbox.com/scl/fo/kahptj3zbz9iegbvnhm4d/ACACJEtO5Qbzm2llBgq3MXs?rlkey=ifv4rw0xhbimmd5iumpybalfa",
    "May 2026 Boston": "https://www.dropbox.com/scl/fo/w22pbvl6i5n9c8r05utmc/AJ8TI1slH2800Xh6Q3EPqkE?rlkey=g1zzgyqafa2l5tuuk8kzj7gcz",
    "July 2026 NYC":   "https://www.dropbox.com/scl/fo/88gsowne7my8f4wxs7jje/ADC1nNktxTMzAh_G1neXH1o?rlkey=by8h9nmgeg37xcnddlrkgs879",
}

STAGING = os.path.expanduser("~/NSDS-transfer-staging")
SOCKET_TIMEOUT = 120
MIN_FREE_BYTES = 15 * 1024**3   # refuse to fill the disk past this
STOP = threading.Event()
_print_lock = threading.Lock()


def log(msg):
    with _print_lock:
        sys.stdout.write("%s  %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
        sys.stdout.flush()


def human(n):
    for u in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or u == "TB":
            return "%.1f%s" % (n, u)
        n /= 1024.0


def safe_name(name):
    """Dropbox names may contain '/' and control chars; POSIX filenames may not."""
    name = name.replace("/", "⁄")            # fraction slash, visually identical
    name = "".join(c for c in name if ord(c) >= 32)
    name = name.strip().rstrip(".")
    return name or "unnamed"


class Session:
    """Holds the Dropbox CSRF cookie. Refreshes when it goes stale mid-run."""

    def __init__(self, link):
        self.link = link
        self.lock = threading.Lock()
        self.generation = 0
        self._build()

    def _build(self):
        cj = http.cookiejar.CookieJar()
        op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
        op.addheaders = [("User-Agent", UA)]
        op.open(self.link, timeout=SOCKET_TIMEOUT).read()
        tok = [c.value for c in cj if c.name == "__Host-js_csrf"]
        if not tok:
            raise RuntimeError("no CSRF cookie from %s" % self.link)
        self.opener, self.token = op, tok[0]

    def refresh(self, seen_generation):
        """Rebuild once per generation, so N racing threads cause one refresh."""
        with self.lock:
            if seen_generation != self.generation:
                return self.generation          # somebody already did it
            self._build()
            self.generation += 1
            log("session refreshed (generation %d)" % self.generation)
            return self.generation


def parse_link(link):
    m = re.search(r"/scl/fo/([^/]+)/([^/?]+)", link)
    rlkey = urllib.parse.parse_qs(urllib.parse.urlparse(link).query)["rlkey"][0]
    return m.group(1), m.group(2), rlkey


def enumerate_share(link):
    """Recursively list a shared folder. Raises on any incompleteness."""
    sess = Session(link)
    link_key, root_hash, rlkey = parse_link(link)
    files = []

    def post(secure_hash, sub_path, voucher, refreshed=0):
        data = {"t": sess.token, "link_key": link_key, "link_type": "s",
                "secure_hash": secure_hash, "sub_path": sub_path, "rlkey": rlkey}
        if voucher is not None:
            data["voucher"] = voucher if isinstance(voucher, str) else json.dumps(voucher)
        req = urllib.request.Request(
            ENDPOINT, data=urllib.parse.urlencode(data).encode(),
            headers={"Content-Type": "application/x-www-form-urlencoded",
                     "x-requested-with": "XMLHttpRequest",
                     "X-CSRF-Token": sess.token, "User-Agent": UA})
        for attempt in range(6):
            try:
                with sess.opener.open(req, timeout=SOCKET_TIMEOUT) as r:
                    return json.load(r)
            except urllib.error.HTTPError as e:
                if e.code in (403, 401):        # CSRF went stale
                    # Bounded: a permanently-403 link must fail, not recurse forever.
                    if refreshed >= 2:
                        raise RuntimeError(
                            "still %d after %d session refreshes — the share link is "
                            "probably expired or revoked" % (e.code, refreshed))
                    sess.refresh(sess.generation)
                    return post(secure_hash, sub_path, voucher, refreshed + 1)
                if e.code == 429 or e.code >= 500:
                    time.sleep(min(60, 2 ** attempt) + random.random())
                    continue
                raise
            except (urllib.error.URLError, OSError):
                time.sleep(min(60, 2 ** attempt) + random.random())
        raise RuntimeError("listing failed after retries: %s%s" % (secure_hash, sub_path))

    def list_dir(secure_hash, sub_path):
        """Page through one directory. Fails loudly rather than under-reporting."""
        entries, voucher, expected, guard = [], None, None, 0
        while True:
            guard += 1
            if guard > 500:
                raise RuntimeError("pagination runaway at %r" % sub_path)
            j = post(secure_hash, sub_path, voucher)
            if "entries" not in j:
                raise RuntimeError("no 'entries' key at %r: %s" % (sub_path, list(j)[:8]))
            batch = j["entries"]
            if expected is None:
                expected = j.get("total_num_entries")
            if voucher is not None and not batch:
                raise RuntimeError("pagination stalled (empty page) at %r" % sub_path)
            entries += batch
            if not j.get("has_more_entries"):
                break
            voucher = j.get("next_request_voucher")
            if voucher is None:
                raise RuntimeError("has_more_entries but no voucher at %r" % sub_path)
            time.sleep(0.25)
        if expected is not None and len(entries) != expected:
            raise RuntimeError("incomplete listing at %r: got %d of %d"
                               % (sub_path, len(entries), expected))
        return entries

    def walk(secure_hash, sub_path):
        for e in list_dir(secure_hash, sub_path):
            path = "%s/%s" % (sub_path, e["filename"])
            if e["is_dir"]:
                m = re.search(r"/scl/fo/[^/]+/([^/]+)/", e["href"])
                if not m:
                    raise RuntimeError("cannot parse subfolder hash: %s" % e["href"])
                time.sleep(0.25)
                walk(m.group(1), path)          # own hash AND sub_path, both required
            else:
                if "bytes" not in e:
                    raise RuntimeError("file entry without size: %s" % path)
                files.append({"path": path, "bytes": e["bytes"], "href": e["href"]})

    walk(root_hash, "")
    return sess, files


def local_path(root, rel):
    parts = [safe_name(p) for p in rel.strip("/").split("/")]
    return os.path.join(root, *parts)


def download(sess, item, dest, stats):
    """Fetch one file with Range resume. Returns when dest exists at full size."""
    size = item["bytes"]
    if os.path.exists(dest) and os.path.getsize(dest) == size:
        stats["skipped"] += 1
        return
    part = dest + ".part"
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    url = item["href"].replace("dl=0", "dl=1")
    if "dl=1" not in url:
        url += ("&" if "?" in url else "?") + "dl=1"

    attempts_without_progress = 0
    while not STOP.is_set():
        have = os.path.getsize(part) if os.path.exists(part) else 0
        if have > size:                          # stale/garbage partial
            log("  ! %s partial larger than expected, restarting" % item["path"])
            os.remove(part); have = 0
        if have == size:
            os.replace(part, dest); stats["done"] += 1; return

        free = shutil.disk_usage(os.path.dirname(dest)).free
        if free - (size - have) < MIN_FREE_BYTES:
            raise RuntimeError("refusing to continue: only %s free" % human(free))

        gen = sess.generation
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        if have:
            req.add_header("Range", "bytes=%d-" % have)
        try:
            r = urllib.request.urlopen(req, timeout=SOCKET_TIMEOUT)
            status = r.status
            # A server that ignores Range returns 200 with the WHOLE body.
            # Appending that onto a partial file silently corrupts it.
            if have and status != 206:
                log("  ! %s: no Range support this attempt, restarting from 0" % item["path"])
                r.close(); os.remove(part); continue
            if have:
                cr = r.headers.get("Content-Range", "")
                m = re.match(r"bytes (\d+)-(\d+)/(\d+)$", cr)
                if not m:
                    log("  ! %s: unparseable Content-Range %r, restarting" % (item["path"], cr))
                    r.close(); os.remove(part); continue
                if int(m.group(1)) != have or int(m.group(3)) != size:
                    log("  ! %s: Content-Range %s disagrees with have=%d size=%d, restarting"
                        % (item["path"], cr, have, size))
                    r.close(); os.remove(part); continue
            written = 0
            with r, open(part, "ab" if have else "wb") as fh:
                while not STOP.is_set():
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    fh.write(chunk); written += len(chunk)
                    stats["bytes"] += len(chunk)
            if STOP.is_set():
                return
            if written:
                attempts_without_progress = 0     # forward progress resets the budget
            else:
                attempts_without_progress += 1
        except urllib.error.HTTPError as e:
            if e.code in (401, 403, 410):         # signed URL or session expired
                sess.refresh(gen)
            elif e.code == 429:
                wait = e.headers.get("Retry-After")
                time.sleep(float(wait) if wait and wait.isdigit() else 30)
            attempts_without_progress += 1
        except (urllib.error.URLError, OSError):
            attempts_without_progress += 1

        if attempts_without_progress:
            if attempts_without_progress > 12:
                raise RuntimeError("no progress on %s after %d attempts"
                                   % (item["path"], attempts_without_progress))
            time.sleep(min(120, 2 ** attempts_without_progress) + random.random())


def run(args):
    shows = {k: v for k, v in SHOWS.items() if not args.only or k == args.only}
    if args.only and not shows:
        sys.exit("unknown show %r; known: %s" % (args.only, ", ".join(SHOWS)))

    plans = []
    for name, link in shows.items():
        log("enumerating %s ..." % name)
        sess, files = enumerate_share(link)
        total = sum(f["bytes"] for f in files)
        log("  %d files, %s" % (len(files), human(total)))
        plans.append((name, sess, files, total))

    grand = sum(p[3] for p in plans)
    log("TOTAL %d files, %s" % (sum(len(p[2]) for p in plans), human(grand)))

    os.makedirs(STAGING, exist_ok=True)
    with open(os.path.join(STAGING, "manifest.json"), "w") as fh:
        json.dump({n: f for n, _, f, _ in plans}, fh, indent=1)

    if args.dry_run:
        for name, _, files, total in plans:
            log("%s -> %s/%s  (%s)" % (name, STAGING, safe_name(name), human(total)))
        return 0

    free = shutil.disk_usage(STAGING).free
    if free < grand + MIN_FREE_BYTES:
        sys.exit("need %s + headroom, only %s free" % (human(grand), human(free)))

    failures = []
    for name, sess, files, total in plans:
        root = os.path.join(STAGING, safe_name(name))
        stats = {"bytes": 0, "done": 0, "skipped": 0}
        log("downloading %s (%s) -> %s" % (name, human(total), root))
        with ThreadPoolExecutor(max_workers=args.jobs) as pool:
            futs = {pool.submit(download, sess, it, local_path(root, it["path"]), stats): it
                    for it in files}
            for fut, it in futs.items():
                try:
                    fut.result()
                except Exception as exc:
                    failures.append((name, it["path"], exc))
                    log("  FAILED %s: %s" % (it["path"], exc))
        log("  %s: %d downloaded, %d already present, %s transferred"
            % (name, stats["done"], stats["skipped"], human(stats["bytes"])))

        missing = [f for f in files
                   if not os.path.exists(local_path(root, f["path"]))
                   or os.path.getsize(local_path(root, f["path"])) != f["bytes"]]
        if missing:
            failures.append((name, "%d files incomplete" % len(missing), ""))
            log("  %s: %d of %d files still incomplete" % (name, len(missing), len(files)))
        else:
            log("  %s: VERIFIED all %d files present at correct size" % (name, len(files)))

    if failures:
        log("FAILURES (%d) — safe to re-run, completed files are skipped" % len(failures))
        return 1
    log("all shows complete")
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dry-run", action="store_true", help="enumerate and print the plan only")
    p.add_argument("--only", metavar="SHOW", help="restrict to one show")
    p.add_argument("--jobs", type=int, default=3, help="concurrent downloads (default 3)")
    args = p.parse_args()

    def onsig(signum, frame):
        log("signal %d — finishing current chunk, partials stay resumable" % signum)
        STOP.set()
    signal.signal(signal.SIGINT, onsig)
    signal.signal(signal.SIGTERM, onsig)

    try:
        rc = run(args)
    except Exception as exc:
        log("FATAL: %s" % exc)
        return 2
    return 130 if STOP.is_set() else rc


if __name__ == "__main__":
    sys.exit(main())
