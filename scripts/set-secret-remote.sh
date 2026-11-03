#!/bin/bash
# Runs as root on the target host behind ssh:
# the secret comes on stdin and goes straight to scripts/set-secret.mjs.
# One run at a time, also against the updater; the service is stopped while
# config.json is written and started again on every exit, also after a signal
#. Success only once the app answers /api/version;
# if it does not with the new value, or the run ends with an error after
# set-secret.mjs wrote its backup, the previous config is restored from that
# backup, atomically and only while the service is stopped.
#
#   set-secret-remote.sh plugins.<id>.<key>   (secret on stdin)
#
# Exit: set-secret.mjs status, 3 = another run or the updater holds the lock,
# 7 = written, but the app did not come up with it (previous config restored).
set -u

KEY="${1:-}"
DIR="${MQTT_MASTER_DIR:-/opt/mqtt-master}"
ENV_FILE="${MQTT_MASTER_ENV_FILE:-/etc/mqtt-master/env}"
CONFIG="${MQTT_MASTER_CONFIG:-$DIR/config.json}"
LOCK="$DIR/.update-state/updater.lock"
APP_URL="${APP_URL:-http://127.0.0.1:80}"
READY_TIMEOUT="${READY_TIMEOUT:-60}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
NODE="${NODE:-node}"
FLOCK="${FLOCK:-flock}"
CURL="${CURL:-curl}"
CP="${CP:-cp}"

case "$KEY" in
  plugins.*.*) ;;
  *) echo "usage: set-secret-remote.sh plugins.<id>.<key>" >&2; exit 2 ;;
esac
case "$KEY" in *[!A-Za-z0-9.-]*) echo "invalid key" >&2; exit 2 ;; esac

mkdir -p "${LOCK%/*}" || exit 3
exec 9>"$LOCK" || exit 3
"$FLOCK" -n 9 || { echo "another run or the updater holds the lock" >&2; exit 3; }

BACKUP="$CONFIG.vor-set-secret-$(date +%Y%m%dT%H%M%S)-$$"

# start, then wait until the app answers (Type=simple: systemctl start alone says nothing)
start_ready() {
  "$SYSTEMCTL" start mqtt-master || return 1
  local deadline=$((SECONDS + READY_TIMEOUT))
  until "$CURL" -sf --max-time 2 -o /dev/null "$APP_URL/api/version"; do
    [ "$SECONDS" -ge "$deadline" ] && return 1
    sleep 2
  done
}

# temp copy + rename: a failed copy leaves the config as it is
restore() {
  local tmp="$CONFIG.restore-$$"
  if "$CP" -- "$BACKUP" "$tmp" && mv -f -- "$tmp" "$CONFIG"; then return 0; fi
  rm -f -- "$tmp"
  echo "previous config could not be restored, config left as it is" >&2
  return 1
}

rc=1
stopped=0
finish() {
  trap - EXIT
  trap '' HUP INT TERM
  [ "$stopped" = 1 ] || exit "$rc"
  # error or signal after the backup was written: the config may already be
  # replaced; the service is still stopped here
  [ "$rc" != 0 ] && [ -e "$BACKUP" ] && restore
  start_ready && exit "$rc"
  if [ "$rc" = 0 ]; then
    rc=7
    echo "mqtt-master did not come up with the new value, restoring the previous config" >&2
    # never write under a running service
    if ! "$SYSTEMCTL" stop mqtt-master; then
      echo "mqtt-master did not stop, config left with the new value" >&2
      exit "$rc"
    fi
    restore
    if start_ready; then
      echo "mqtt-master is running again" >&2
      exit "$rc"
    fi
  fi
  echo "mqtt-master did not start again" >&2
  exit "$rc"
}
trap finish EXIT
trap 'rc=1; exit 1' HUP INT TERM

# before the stop: a signal during it must still lead to a start
stopped=1
"$SYSTEMCTL" stop mqtt-master || exit 1
set -a
# shellcheck disable=SC1090
. "$ENV_FILE" || exit 1
set +a
"$NODE" "$DIR/scripts/set-secret.mjs" "$CONFIG" "$KEY" "$BACKUP"
rc=$?
