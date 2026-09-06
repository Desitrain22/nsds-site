#!/usr/bin/env bash
# Deploy the Apps Script backend end to end, then wire the URL into the page.
#
#   tools/deploy-backend.sh 'your passphrase here'
#
# One-time, by hand, before the first run (both need a browser as nealpareshpatel@gmail.com):
#   1. clasp login                                   # OAuth popup
#   2. https://script.google.com/home/usersettings   # flip "Google Apps Script API" ON
#
# Then this does: create project (first run) -> push Code.gs + manifest -> deploy as web app
# (Execute as Me / Anyone, from appsscript.json) -> set the passphrase -> write BACKEND_URL into
# videoreview/shows.js -> smoke test. Re-runs push a new version to the SAME deployment, so the
# URL never changes.
set -euo pipefail
cd "$(dirname "$0")/../videoreview/apps-script"

PHRASE="${1:-}"
[ -n "$PHRASE" ] || { echo "usage: $0 '<passphrase>'"; exit 1; }
[ "${#PHRASE}" -ge 8 ] || { echo "passphrase must be at least 8 characters"; exit 1; }

clasp show-authorized-user >/dev/null 2>&1 || { echo "not logged in — run: clasp login   (as nealpareshpatel@gmail.com)"; exit 1; }

if [ ! -f .clasp.json ]; then
  echo "== creating Apps Script project"
  clasp create --type webapp --title "NSDS Tape Review API" --rootDir . >/dev/null
fi

echo "== pushing Code.gs + appsscript.json"
clasp push --force >/dev/null

# Reuse the existing versioned deployment so the /exec URL is stable across pushes.
# (@HEAD is the dev deployment and is skipped — its URL is /dev and needs a login.)
pick_deployment() {
  clasp list-deployments --json 2>/dev/null | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
items = data if isinstance(data, list) else data.get("deployments") or data.get("results") or []
for d in items:
    cfg = d.get("deploymentConfig") or {}
    if cfg.get("versionNumber"):
        print(d.get("deploymentId", "")); break
'
}
DEPLOY_ID="$(pick_deployment)"
DESC="$(date +%F) $(git -C .. rev-parse --short HEAD 2>/dev/null || echo manual)"
if [ -n "${DEPLOY_ID:-}" ]; then
  echo "== updating deployment $DEPLOY_ID"
  clasp deploy --deploymentId "$DEPLOY_ID" --description "$DESC" >/dev/null
else
  echo "== creating web app deployment"
  clasp deploy --description "$DESC" >/dev/null
  DEPLOY_ID="$(pick_deployment)"
fi
[ -n "$DEPLOY_ID" ] || { echo "could not determine deployment id — run: clasp list-deployments"; exit 1; }

URL="https://script.google.com/macros/s/${DEPLOY_ID}/exec"
echo "== $URL"

echo "== setting passphrase (first call only)"
RESP="$(curl -sL -X POST "$URL" -H 'Content-Type: text/plain;charset=utf-8' \
  -d "{\"action\":\"setup\",\"password\":$(printf '%s' "$PHRASE" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')}")"
case "$RESP" in
  *'"configured":true'*)   echo "   set." ;;
  *'already configured'*)  echo "   already set on this deployment (unchanged)." ;;
  *) echo "   unexpected: $RESP"; exit 1 ;;
esac

echo "== smoke test"
curl -sL "$URL" | grep -q '"ok":true' && echo "   GET ok" || { echo "   GET failed — is access set to Anyone?"; exit 1; }
curl -sL -X POST "$URL" -H 'Content-Type: text/plain;charset=utf-8' \
  -d "{\"action\":\"listTapes\",\"password\":$(printf '%s' "$PHRASE" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'),\"folderId\":\"1bS6gBq5vcLFbbGNG-_qB-9yWuknChO6Y\"}" \
  | grep -q '"tapes"' && echo "   listTapes ok (April 2026)" || { echo "   listTapes failed"; exit 1; }

echo "== writing BACKEND_URL into videoreview/shows.js"
python3 - "$URL" <<'PY'
import re, sys, pathlib
p = pathlib.Path('../shows.js'); s = p.read_text()
s = re.sub(r"export const BACKEND_URL = '[^']*'", f"export const BACKEND_URL = '{sys.argv[1]}'", s)
p.write_text(s)
PY
echo
echo "done. commit videoreview/shows.js and push — performers then only need the link + passphrase."
