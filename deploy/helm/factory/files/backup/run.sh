# Every local backup writer inherits descriptor 9. Never unlink the lock file or explicitly
# unlock it: a surviving child must keep exclusion even if this runner is killed.
# shellcheck source=common.sh
. /scripts/common.sh
exec 9>>"$BACKUP/.lock"
if ! flock -n 9; then
  echo "Another backup holds $BACKUP/.lock; this Job did not start a backup set" >&2
  exit 1
fi

child=''
stop() {
  trap '' TERM INT
  if [ -n "$child" ]; then
    # Each step owns a process group, including its local kubectl/rclone/bao writers.
    kill -TERM "-$child" 2> /dev/null || true
    wait "$child" 2> /dev/null || true
  fi
  exit "$1"
}
trap 'stop 143' TERM
trap 'stop 130' INT

for name in prepare postgres forgejo objects openbao finalize; do
  setsid sh "/scripts/$name.sh" &
  child=$!
  wait "$child"
  status=$?
  child=''
  if [ "$status" -ne 0 ]; then exit "$status"; fi
done
