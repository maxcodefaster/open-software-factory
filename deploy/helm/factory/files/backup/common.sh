# Sourced by the locked runner and its backup steps. POSIX sh for Alpine's BusyBox.
set -u
umask 007
BACKUP=/backup

# retry ATTEMPTS COMMAND... Pods created by a Job can be refused by NetworkPolicy for a few
# seconds after they start, so every network call runs inside this.
retry() {
  attempts=$1
  shift
  n=1
  until "$@"; do
    if [ "$n" -ge "$attempts" ]; then
      return 1
    fi
    echo "Attempt $n of $attempts failed; retrying in ${BACKUP_RETRY_SECONDS:-10}s" >&2
    n=$((n + 1))
    sleep "${BACKUP_RETRY_SECONDS:-10}"
  done
}

load_set() {
  SET="$(cat "$BACKUP/.current")"
  DIR="$BACKUP/$SET"
}

# step NAME COMMAND... records the outcome. A failed step never stops the later ones;
# finalize.sh refuses to complete the set and fails the Job.
step() {
  name=$1
  shift
  rm -f "$DIR/$name.ok" "$DIR/$name.failed"
  if "$@"; then
    : > "$DIR/$name.ok"
  else
    : > "$DIR/$name.failed"
    echo "Backup step $name failed" >&2
  fi
}

# Invoked in a separate runner shell, before its lock acquisition, with fd 9 inherited.
# kubectl's request timeout does not bound its upgraded exec streams. Missing remote
# completion is never success.
exec_call() {
  name=$1
  shift
  seconds=${BACKUP_EXEC_TIMEOUT_SECONDS:-1800}
  case "$seconds" in
    ''|*[!0-9]*|0*) echo "BACKUP_EXEC_TIMEOUT_SECONDS must be a positive whole number" >&2; exit 2 ;;
  esac

  child=''
  timer=''
  cleanup() {
    # The timer has its own group so its sleep cannot survive cleanup or hold fd 9.
    if [ -n "$timer" ]; then
      kill -KILL "$timer" 2> /dev/null || true
      kill -KILL "-$timer" 2> /dev/null || true
      wait "$timer" 2> /dev/null || true
    fi
    if [ -n "$child" ]; then
      kill -TERM "-$child" 2> /dev/null || true
      # A timed-out client or descendant must not keep writing into the next attempt.
      kill -KILL "$child" 2> /dev/null || true
      kill -KILL "-$child" 2> /dev/null || true
      wait "$child" 2> /dev/null || true
    fi
  }
  stop() {
    trap '' TERM INT USR1
    if [ "$1" -eq 124 ]; then
      echo "Backup exec $name timed out after ${seconds}s; remote outcome is unknown" >&2
    fi
    cleanup
    exit "$1"
  }
  trap 'stop 143' TERM
  trap 'stop 130' INT
  trap 'stop 124' USR1

  echo "Backup exec $name started; deadline ${seconds}s" >&2
  # Explicit stdin redirection preserves the archive input for background pg_restore.
  setsid "$@" <&0 &
  child=$!
  setsid sh -c 'sleep "$1"; kill -USR1 "$2"' sh "$seconds" "$$" &
  timer=$!
  wait "$child"
  status=$?
  trap '' TERM INT USR1
  cleanup
  echo "Backup exec $name exited with status $status" >&2
  exit "$status"
}
