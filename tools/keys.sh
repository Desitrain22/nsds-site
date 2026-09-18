#!/usr/bin/env bash
# The three backend secrets: set them once, rotate them, see which are configured.
#
#   tools/keys.sh ship                    # first time: generate all three and store them
#   tools/keys.sh rotate                  # new values for all three
#   tools/keys.sh rotate password         # just one (password | uploadKey | adminKey)
#   tools/keys.sh show                    # print what's in the Keychain
#   tools/keys.sh status                  # which are set on the backend (no values)
#
# Where the values live: the macOS Keychain, and the backend's script properties. Never in this
# repo, never in a file, never in your shell history. `ship` and `rotate` are the same operation —
# rotation is just shipping again — which is why this is one script rather than two that drift.
#
# HOW IT AUTHENTICATES, and why it is not a password prompt:
#
# Script properties can only be written from inside the Apps Script project, so rotating a key
# means calling the backend with something it already trusts. Using a shared secret for that has
# an obvious flaw — lose the secret and you can never rotate it. So this proves ownership by
# demonstrating WRITE ACCESS to the Drive folder the app serves: it drops a random nonce into
# `NSDS/Media/_ops/` with rclone, then calls `rotateKeys` with the same nonce. Only someone who
# can write there could have put it there, and that is the same authority that could edit Project
# Settings by hand. Nothing pre-existing is required, so losing every secret is recoverable.
#
# That means the prerequisites are your local Google credentials, not a passphrase:
#   - rclone, authorised for the NSDS Drive (writes the nonce)
#   - clasp, logged in as the project owner (checked, so this cannot run on a stranger's machine)
set -euo pipefail

cd "$(dirname "$0")/.."
RCLONE="${RCLONE:-/opt/homebrew/bin/rclone}"
REMOTE="${NSDS_RCLONE_REMOTE:-nsdsdrive}"
ACCOUNT="${USER:-nsds}"

# Both read out of the committed source, so there is exactly one definition of each.
BACKEND_URL="$(grep -oE "https://script\.google\.com/macros/s/[^']+" videoreview/shows.js | head -1)"
MEDIA_ROOT_ID="$(grep -oE "MEDIA_ROOT_ID = '[^']+'" videoreview/shows.js | sed "s/.*'\(.*\)'/\1/")"
[ -n "$BACKEND_URL" ]   || { echo "no BACKEND_URL in videoreview/shows.js"; exit 1; }
[ -n "$MEDIA_ROOT_ID" ] || { echo "no MEDIA_ROOT_ID in videoreview/shows.js"; exit 1; }

kc_set() { security add-generic-password -U -s "nsds-$1" -a "$ACCOUNT" -w "$2"; }
kc_get() { security find-generic-password -s "nsds-$1" -a "$ACCOUNT" -w 2>/dev/null || true; }

post() {  # post <json-file>
  curl -sL --max-time 60 "$BACKEND_URL" -H 'Content-Type: text/plain;charset=utf-8' --data @"$1"
}

require_owner() {
  command -v "$RCLONE" >/dev/null || { echo "rclone not found at $RCLONE"; exit 3; }
  "$RCLONE" listremotes | grep -qx "${REMOTE}:" || {
    echo "rclone remote '${REMOTE}:' is not configured — see tools/README.md"; exit 3; }
  clasp show-authorized-user >/dev/null 2>&1 || {
    echo "clasp is not logged in. This is the ownership check: run 'clasp login' as the project owner."; exit 3; }
}

# --------------------------------------------------------------------- set/rotate --

apply() {  # apply <field>...
  require_owner
  local fields=("$@")
  [ ${#fields[@]} -gt 0 ] || fields=(password uploadKey adminKey)

  # The passphrase is typed by performers, so allow a chosen one; the machine keys are random.
  local -a names=() values=()
  for f in "${fields[@]}"; do
    local v
    case "$f" in
      password)  v="${NSDS_NEW_PASSWORD:-$(openssl rand -hex 12)}" ;;
      uploadKey) v="$(openssl rand -hex 24)" ;;
      adminKey)  v="$(openssl rand -hex 24)" ;;
      *) echo "unknown key '$f' (password | uploadKey | adminKey)"; exit 1 ;;
    esac
    names+=("$f"); values+=("$v")
  done

  # Rotating the passphrase logs out every performer holding the old one. The machine keys are
  # held by one person each, so they are cheap to change; this is the only expensive one.
  for f in "${names[@]}"; do
    if [ "$f" = "password" ] && [ "${NSDS_YES:-}" != "1" ]; then
      echo "Rotating 'password' invalidates the phrase every performer already has."
      echo "You will have to send the new one to all of them."
      printf 'Type yes to continue: '
      read -r reply
      [ "$reply" = "yes" ] || { echo "stopped."; exit 1; }
    fi
  done

  local nonce; nonce="$(openssl rand -hex 32)"
  local tmp; tmp="$(mktemp)"
  printf '%s' "$nonce" > "$tmp"
  echo "== writing the ownership nonce to NSDS/Media/_ops/"
  "$RCLONE" copyto "$tmp" "${REMOTE},root_folder_id=${MEDIA_ROOT_ID}:_ops/rotate-nonce.txt" >/dev/null
  rm -f "$tmp"

  local body; body="$(mktemp)"
  python3 - "$nonce" "${names[@]}" "--" "${values[@]}" > "$body" <<'PY'
import json, sys
nonce = sys.argv[1]
rest = sys.argv[2:]
sep = rest.index('--')
names, values = rest[:sep], rest[sep + 1:]
payload = {"action": "rotateKeys", "nonce": nonce}
payload.update(dict(zip(names, values)))
print(json.dumps(payload))
PY

  echo "== asking the backend to set: ${names[*]}"
  local resp; resp="$(post "$body")"; rm -f "$body"
  case "$resp" in
    *'"ok":true'*) echo "   done." ;;
    *) echo "   FAILED: $resp"; echo
       echo "   If it says the action is unknown, the deployed backend predates rotateKeys —"
       echo "   push it first (tools/deploy-backend.sh) and re-run."
       exit 1 ;;
  esac

  echo "== storing in the Keychain"
  local i=0
  for f in "${names[@]}"; do kc_set "$f" "${values[$i]}"; i=$((i+1)); done

  echo
  echo "Give these out ONCE and then read them back with: tools/keys.sh show"
  i=0
  for f in "${names[@]}"; do
    case "$f" in
      password)  printf '  performers  (passphrase)  %s\n' "${values[$i]}" ;;
      uploadKey) printf '  videographers (upload key) %s\n' "${values[$i]}" ;;
      adminKey)  printf '  you only    (admin key)   %s\n' "${values[$i]}" ;;
    esac
    i=$((i+1))
  done
  echo
  echo "  performers    https://techcomedyshow.com/videoreview/"
  echo "  videographers https://techcomedyshow.com/videoreview/upload.html"
}

# --------------------------------------------------------------------- commands --

case "${1:-}" in
  ship)
    shift
    # Same call as rotate. Named separately only because "ship" is what you look for first.
    apply "$@"
    ;;
  rotate)
    shift
    apply "$@"
    ;;
  show)
    for f in password uploadKey adminKey; do
      v="$(kc_get "$f")"
      printf '%-10s %s\n' "$f" "${v:-<not in the Keychain — rotate it to set a known value>}"
    done
    ;;
  status)
    tmp="$(mktemp)"; printf '{"action":"keyStatus"}' > "$tmp"
    post "$tmp"; echo; rm -f "$tmp"
    ;;
  *)
    sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
