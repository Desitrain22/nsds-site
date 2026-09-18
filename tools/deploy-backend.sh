#!/usr/bin/env bash
# Deploy the Apps Script backend end to end, then wire the URL into the page.
#
#   tools/deploy-backend.sh 'your passphrase here'
#
# Takes no secret and sets none. The three keys are script properties owned by tools/keys.sh; this
# ships code only, which is the same thing .github/workflows/deploy-backend.yml does on every push
# to main. Reach for this when you want to deploy without pushing, or when CI is not available.
#
# One-time, by hand, before the first run (both need a browser as nealpareshpatel@gmail.com):
#   1. clasp login                                   # OAuth popup
#   2. https://script.google.com/home/usersettings   # flip "Google Apps Script API" ON
#
# NB: never `curl -X POST` an Apps Script URL with -L. Apps Script 302s to a GET-only echo URL;
# -X pins POST across the redirect and you get Google's 'Page Not Found' page. Plain --data works.
#
# Then this does: create project (first run) -> push Code.gs + manifest -> deploy as web app
# (Execute as Me / Anyone, from appsscript.json) -> set the passphrase -> write BACKEND_URL into
# videoreview/shows.js -> smoke test. Re-runs push a new version to the SAME deployment, so the
# URL never changes.
set -euo pipefail
cd "$(dirname "$0")/../videoreview/apps-script"

# The deeper smoke test needs the performer passphrase. Read it from the Keychain rather than the
# command line: argv is visible in `ps` to every process on the machine, and lands in shell
# history. If it is not there, the test downgrades to the credential-free GET instead of asking.
PHRASE="$(security find-generic-password -s nsds-password -a "${USER:-nsds}" -w 2>/dev/null || true)"

clasp show-authorized-user >/dev/null 2>&1 || { echo "not logged in — run: clasp login   (as nealpareshpatel@gmail.com)"; exit 1; }

if [ ! -f .clasp.json ]; then
  echo "== creating Apps Script project"
  # `clasp create` clones a bare appsscript.json back over ours, dropping the webapp block and
  # the scopes -- which makes every deployment a plain script that 404s on /exec. Keep ours.
  cp appsscript.json /tmp/nsds-manifest.json
  clasp create --type webapp --title "NSDS Tape Review API" --rootDir . >/dev/null
  cp /tmp/nsds-manifest.json appsscript.json
fi
grep -q '"webapp"' appsscript.json || { echo "appsscript.json lost its webapp block -- restore it from git"; exit 1; }

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
    if d.get("versionNumber") or cfg.get("versionNumber"):
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

echo "== smoke test"
curl -sL "$URL" | grep -q '"ok":true' && echo "   GET ok" || { echo "   GET failed — is access set to Anyone?"; exit 1; }

# Which keys exist, as booleans. This is the check that catches "the code shipped but a property is
# missing", which looks exactly like a working deploy until someone tries to sign in.
STATUS="$(curl -sL "$URL" -H 'Content-Type: text/plain;charset=utf-8' -d '{"action":"keyStatus"}')"
for KEY in PASSWORD UPLOAD_KEY ADMIN_KEY; do
  case "$STATUS" in
    *"\"$KEY\":true"*) echo "   $KEY configured" ;;
    *) echo "   ! $KEY is NOT set — run: tools/keys.sh ship" ;;
  esac
done

if [ -n "$PHRASE" ]; then
  curl -sL "$URL" -H 'Content-Type: text/plain;charset=utf-8' \
    -d "{\"action\":\"listShows\",\"password\":$(printf '%s' "$PHRASE" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')}" \
    | grep -q '"shows"' && echo "   listShows ok" || { echo "   listShows failed"; exit 1; }
else
  echo "   (no passphrase in the Keychain — skipped the authenticated check)"
fi

echo "== writing BACKEND_URL into videoreview/shows.js"
python3 - "$URL" <<'PY'
import re, sys, pathlib
p = pathlib.Path('../shows.js'); s = p.read_text()
s = re.sub(r"export const BACKEND_URL = '[^']*'", f"export const BACKEND_URL = '{sys.argv[1]}'", s)
p.write_text(s)
PY
echo
echo "done. commit videoreview/shows.js and push — performers then only need the link + passphrase."
