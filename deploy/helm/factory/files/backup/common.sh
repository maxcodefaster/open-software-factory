# Sourced by every backup step. POSIX sh: the step images are Debian (dash) and Alpine (busybox).
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
