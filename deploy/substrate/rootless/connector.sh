#!/bin/sh
set -eu
# Docker and Tinyproxy share this existing Actor-private RootlessKit namespace.
# This explicit cold entrypoint never loads a saved command queue.
test "$#" -gt 0
test "${DOCKERD_ROOTLESSKIT_STATE_DIR:-}" = /run/user/1000/docker-direct
pid="$(cat "$DOCKERD_ROOTLESSKIT_STATE_DIR/child_pid")"
case "$pid" in
  ''|*[!0-9]*) echo 'Invalid Actor-private RootlessKit PID' >&2; exit 1 ;;
esac
test "$pid" -gt 1
kill -0 "$pid"
exec nsenter --target "$pid" --user --mount --net -- "$@"
