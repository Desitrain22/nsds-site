#!/bin/bash
# NSDS: local staging -> Google Drive, unattended overnight.
#
#   ./nsds_transfer.sh              # fetch (if needed), then upload everything
#   ./nsds_transfer.sh --fetch-only
#   ./nsds_transfer.sh --upload-only
#
# Built to survive a flaky link: every show is retried, in rounds, until
# `rclone check` actually passes. The previous version gave up after one
# verify failure — and the two failures it hit were DNS outages
# ("no such host"), not data problems.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGING="${NSDS_STAGING:-$HOME/NSDS-transfer-staging}"
LOGDIR="$STAGING/logs"
REMOTE="${NSDS_RCLONE_REMOTE:-nsdsdrive}"
RCLONE="${RCLONE:-/opt/homebrew/bin/rclone}"

# Destination Drive folder IDs, resolved ahead of time because these folder
# names contain "/" — legal in Drive, not in a path. Never resolved by name.
DEST_APRIL="1bS6gBq5vcLFbbGNG-_qB-9yWuknChO6Y"   # April 2026 Tapes/Photos
DEST_MAY="1J9A7CLVdD8tNsQwhBq2jSHSWP75zLsOg"     # May 2026 Tapes/Photos (Boston)
DEST_JULY="1jLpdaNRmhIFldwzf9fBnRBiw8lnDt2Vl"    # July 2026 Tapes/Photos (NYC)

# June SF is Drive -> Drive: a read-only folder shared by jim@jimmccambridge.com,
# copied server-side into a new folder under "2026 Tapes/Photos". No local
# bandwidth at all. Destination is named without a slash, matching the existing
# "March 2026 (SF) tapes and photos", so rclone can create it by path.
SRC_JUNESF="1hDN28lMCxjmSrRjEUnaSG9H7WO9jiFXf"
PARENT_2026="1TQeR5rmpyZEsvKAl-2w19qW03w-UeaL1"
DEST_JUNESF_NAME="June 2026 Tapes and Photos (SF)"

MAX_ROUNDS="${NSDS_MAX_ROUNDS:-60}"
ROUND_BACKOFF="${NSDS_ROUND_BACKOFF:-120}"       # seconds between retry rounds

DO_FETCH=1; DO_UPLOAD=1
for a in "$@"; do
  case "$a" in
    --fetch-only)  DO_UPLOAD=0 ;;
    --upload-only) DO_FETCH=0 ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done

mkdir -p "$LOGDIR"
say() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

say "=== NSDS transfer starting (staging: $STAGING) ==="

# --- network gate ------------------------------------------------------------
# The overnight failures were DNS ("no such host"), so wait for real name
# resolution rather than assuming the link is up.
wait_for_network() {
  local waited=0 step=15
  while ! /usr/bin/nslookup www.googleapis.com >/dev/null 2>&1; do
    if [ "$waited" -eq 0 ]; then say "network down — waiting for DNS to come back"; fi
    sleep "$step"
    waited=$((waited + step))
    if [ "$step" -lt 120 ]; then step=$((step * 2)); fi
    if [ "$waited" -ge 7200 ]; then say "network still down after 2h — giving up"; return 1; fi
  done
  if [ "$waited" -gt 0 ]; then say "network back after ${waited}s"; fi
  return 0
}

# --- preflight ---------------------------------------------------------------
if [ "$DO_UPLOAD" -eq 1 ]; then
  command -v "$RCLONE" >/dev/null || { say "FATAL: rclone not found at $RCLONE"; exit 3; }
  if ! "$RCLONE" listremotes | grep -qx "${REMOTE}:"; then
    say "FATAL: rclone remote '${REMOTE}:' is not configured."
    say "  Run:  rclone config create $REMOTE drive scope=drive"
    exit 3
  fi
  wait_for_network || exit 4
  say "checking Drive quota on '${REMOTE}:' ..."
  "$RCLONE" about "${REMOTE}:" 2>/dev/null | sed 's/^/    /' || \
    say "  (quota unavailable — continuing)"
fi

# --- fetch -------------------------------------------------------------------
if [ "$DO_FETCH" -eq 1 ]; then
  say "--- fetching from Dropbox ---"
  /usr/bin/python3 "$HERE/nsds_fetch.py" --jobs 3 2>&1 | tee -a "$LOGDIR/fetch.log"
  rc=${PIPESTATUS[0]}
  if [ "$rc" -ne 0 ]; then
    say "fetch exited $rc — NOT uploading a partial set. Re-run to resume."
    exit "$rc"
  fi
fi

# --- one attempt at one show -------------------------------------------------
# Returns 0 only when rclone check confirms the destination matches.
# Separate `local` statements on purpose: macOS ships bash 3.2, which expands
# every argument of `local` before assigning any of them.
upload_local_show() {
  local show="$1"
  local folder_id="$2"
  local src="$STAGING/$show"
  local dst="${REMOTE},root_folder_id=${folder_id}:"

  if [ ! -d "$src" ]; then say "  no staging dir for '$show' — skipping"; return 0; fi

  say "  uploading '$show'"
  # --transfers 2 (was 4): this link showed heavy bufferbloat, and saturating it
  # caused timeouts that restarted whole multi-GB files. Fewer streams finish more.
  "$RCLONE" copy "$src" "$dst" \
    --transfers 2 \
    --checkers 4 \
    --drive-chunk-size 64M \
    --drive-acknowledge-abuse \
    --drive-stop-on-upload-limit \
    --retries 5 \
    --low-level-retries 20 \
    --timeout 3m \
    --contimeout 1m \
    --size-only \
    --stats 60s \
    --stats-one-line \
    --log-file "$LOGDIR/upload-$show.log" \
    --log-level INFO || say "  '$show' copy returned nonzero (will re-check)"

  say "  verifying '$show'"
  if "$RCLONE" check "$src" "$dst" --size-only --one-way \
       --log-file "$LOGDIR/verify-$show.log" --log-level INFO 2>/dev/null; then
    say "  '$show' VERIFIED"
    return 0
  fi
  say "  '$show' not yet complete"
  return 1
}

# --- June SF: server-side Drive -> Drive, costs no local bandwidth -----------
upload_junesf() {
  local src="${REMOTE},root_folder_id=${SRC_JUNESF}:"
  local dst="${REMOTE},root_folder_id=${PARENT_2026}:${DEST_JUNESF_NAME}"
  say "  copying 'June 2026 SF' server-side (no local bandwidth)"
  "$RCLONE" copy "$src" "$dst" \
    --drive-server-side-across-configs \
    --transfers 4 \
    --retries 5 \
    --low-level-retries 20 \
    --stats 60s --stats-one-line \
    --log-file "$LOGDIR/upload-June 2026 SF.log" --log-level INFO \
    || say "  'June 2026 SF' copy returned nonzero (will re-check)"

  if "$RCLONE" check "$src" "$dst" --size-only --one-way \
       --log-file "$LOGDIR/verify-June 2026 SF.log" --log-level INFO 2>/dev/null; then
    say "  'June 2026 SF' VERIFIED"
    return 0
  fi
  say "  'June 2026 SF' not yet complete"
  return 1
}

do_one() {
  case "$1" in
    "April 2026 NYC")  upload_local_show "$1" "$DEST_APRIL" ;;
    "May 2026 Boston") upload_local_show "$1" "$DEST_MAY" ;;
    "July 2026 NYC")   upload_local_show "$1" "$DEST_JULY" ;;
    "June 2026 SF")    upload_junesf ;;
    *) say "  unknown show '$1'"; return 0 ;;
  esac
}

# --- retry rounds until everything verifies ----------------------------------
if [ "$DO_UPLOAD" -eq 1 ]; then
  say "--- uploading to Google Drive ---"
  PENDING=("April 2026 NYC" "May 2026 Boston" "July 2026 NYC" "June 2026 SF")
  round=1
  # bash 3.2: "${arr[@]}" on an empty array trips `set -u`, hence the +expansion.
  while [ "${#PENDING[@]}" -gt 0 ] && [ "$round" -le "$MAX_ROUNDS" ]; do
    say "round $round — ${#PENDING[@]} show(s) outstanding: ${PENDING[*]}"
    if ! wait_for_network; then say "network gone for too long; stopping"; break; fi
    NEXT=()
    for show in ${PENDING[@]+"${PENDING[@]}"}; do
      if ! do_one "$show"; then NEXT+=("$show"); fi
    done
    PENDING=(${NEXT[@]+"${NEXT[@]}"})
    if [ "${#PENDING[@]}" -gt 0 ]; then
      say "round $round done; ${#PENDING[@]} still outstanding, pausing ${ROUND_BACKOFF}s"
      sleep "$ROUND_BACKOFF"
    fi
    round=$((round + 1))
  done

  if [ "${#PENDING[@]}" -gt 0 ]; then
    say "=== STOPPED with ${#PENDING[@]} show(s) incomplete: ${PENDING[*]} ==="
    say "Re-run ./nsds_start.sh start --upload-only to continue."
    exit 5
  fi
fi

say "=== NSDS transfer COMPLETE — everything verified ==="
say "Staging kept at $STAGING — delete it yourself once you've spot-checked Drive:"
say "    rm -rf \"$STAGING\""
