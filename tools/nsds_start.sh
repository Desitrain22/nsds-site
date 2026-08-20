#!/bin/bash
# Start the NSDS transfer detached, awake, and survivable across a closed terminal.
#
#   ./nsds_start.sh                     # start it (fetch, then upload)
#   ./nsds_start.sh start --fetch-only  # download only; upload later
#   ./nsds_start.sh status              # is it running, how far along
#   ./nsds_start.sh stop                # stop it (partials stay resumable)
#
# Any flags after `start` are passed straight through to nsds_transfer.sh.
#
# Deliberately NOT a KeepAlive LaunchAgent: this is a one-shot job, and a
# KeepAlive agent restarts on every nonzero exit — including unrecoverable
# ones — which turns a config error into an infinite re-enumeration loop.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGING="${NSDS_STAGING:-$HOME/NSDS-transfer-staging}"
LOGDIR="$STAGING/logs"
PIDFILE="$STAGING/transfer.pid"
RUNLOG="$LOGDIR/run.log"

mkdir -p "$LOGDIR"

running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

# macOS has no setsid, so the job is not a process-group leader and
# `kill -- -$pid` does not work. Walk the tree instead.
kill_tree() {
  local pid="$1" sig="$2" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child" "$sig"
  done
  kill "-$sig" "$pid" 2>/dev/null || true
}

case "${1:-start}" in
  status)
    if running; then
      echo "RUNNING (pid $(cat "$PIDFILE"))"
    else
      echo "not running"
    fi
    echo
    # Only show progress from THIS run. The per-show rclone logs are
    # append-only across runs, so a naive tail shows a finished line from a
    # previous run as if it were current — which, combined with the "rm -rf
    # staging" advice, could delete the only local copy of un-uploaded files.
    run_start="$(grep '=== NSDS transfer starting' "$RUNLOG" 2>/dev/null | tail -1 | awk '{print $1" "$2}')"
    echo "this run started: ${run_start:-unknown}"
    echo
    echo "upload progress (this run only):"
    found_any=0
    for f in "$STAGING"/logs/upload-*.log; do
      [ -e "$f" ] || continue
      show="$(basename "$f" .log)"; show="${show#upload-}"
      # rclone stamps 2026/08/20 03:18:32; run.log uses 2026-08-20 03:00:13.
      line="$(awk -v start="${run_start:-9999-99-99 99:99:99}" '
        /INFO.*ETA/ {
          ts = $1 " " $2; gsub("/", "-", ts)
          if (ts >= start) last = $0
        }
        END { if (last != "") print last }' "$f" 2>/dev/null || true)"
      if [ -n "$line" ]; then
        printf '  %-18s %s\n' "$show" "${line#*INFO  : }"
        found_any=1
      fi
    done
    [ "$found_any" -eq 1 ] || echo "  (no stats from this run yet)"
    echo
    echo "verified complete:"
    grep "VERIFIED" "$RUNLOG" 2>/dev/null | awk -v start="${run_start:-9999}" '$1" "$2 >= start' \
      | sed "s/^/  /" || true
    grep -q "VERIFIED" "$RUNLOG" 2>/dev/null || echo "  (none yet)"
    echo
    echo "recent activity:"
    grep -vE '^ +(Total|Used|Free|Trashed|Other):' "$RUNLOG" 2>/dev/null | tail -n 6 || true
    echo
    # POWER. This is the one that actually matters: caffeinate -s only prevents
    # sleep ON AC. pmset -g log shows 362 prior sleeps, every single one on
    # battery, zero on AC — including "Clamshell Sleep ... Using Batt".
    # If this laptop drops to battery in clamshell it WILL sleep and the
    # transfer stops dead.
    echo "power:"
    if pmset -g batt | grep -q "AC Power"; then
      echo "  on AC — good"
    else
      echo "  *** ON BATTERY — it will sleep in clamshell and the upload will stop ***"
      echo "  *** check the charger is actually connected and charging          ***"
    fi
    # Avoid `pmset | grep -q` here: grep -q exits early, pmset gets SIGPIPE, and
    # under `set -o pipefail` the pipeline returns 141 and reports a false "no".
    assertions="$(pmset -g assertions 2>/dev/null || true)"
    case "$assertions" in
      *caffeinate*) echo "  caffeinate assertion held — will not idle-sleep" ;;
      *)            echo "  NO caffeinate assertion — nothing is holding sleep off" ;;
    esac
    ;;

  stop)
    if running; then
      pid="$(cat "$PIDFILE")"
      echo "stopping pid $pid (partials stay resumable) ..."
      kill_tree "$pid" TERM
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
      done
      if kill -0 "$pid" 2>/dev/null; then
        echo "still up after 10s, sending KILL"
        kill_tree "$pid" KILL
      fi
      rm -f "$PIDFILE"
      echo "stopped. Re-run ./nsds_start.sh to resume where it left off."
    else
      echo "not running"; rm -f "$PIDFILE"
    fi
    ;;

  start)
    if running; then echo "already running (pid $(cat "$PIDFILE"))"; exit 0; fi
    shift || true                      # drop the literal "start"; rest is passthrough
    echo "starting NSDS transfer in the background ${*:+($*)} ..."
    # caffeinate flags:
    #   -i prevent idle SYSTEM sleep      -m prevent disk sleep
    #   -s prevent sleep while on AC      -w tie the assertion to our pid
    # The display is allowed to sleep; that costs nothing.
    nohup caffeinate -ims \
      "$HERE/nsds_transfer.sh" "$@" >>"$RUNLOG" 2>&1 &
    echo $! > "$PIDFILE"
    disown %% 2>/dev/null || true
    sleep 2
    echo "started (pid $(cat "$PIDFILE"))"
    echo
    echo "  watch:  tail -f \"$RUNLOG\""
    echo "  status: $HERE/nsds_start.sh status"
    echo "  stop:   $HERE/nsds_start.sh stop"
    echo
    echo "Sleep behaviour:"
    echo "  caffeinate -ims holds PreventSystemSleep, so the Mac stays awake"
    echo "  while the job runs — lid closed and external display off is fine,"
    echo "  as long as it stays on AC power."
    echo "  When the job finishes it exits, the assertion is released, and the"
    echo "  Mac goes to sleep on its own. It cannot sleep DURING the upload:"
    echo "  a sleeping Mac transfers nothing."
    ;;

  *) echo "usage: $0 [start|status|stop]" >&2; exit 2 ;;
esac
