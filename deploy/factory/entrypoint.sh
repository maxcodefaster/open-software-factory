#!/bin/sh
set -eu
: "${FACTORY_STATE_DIRECTORY:?Set the absolute host-mounted Factory state directory}"
case "$FACTORY_STATE_DIRECTORY" in /*) ;; *) echo 'Factory state must be an absolute path.' >&2; exit 1 ;; esac
mkdir -p "$FACTORY_STATE_DIRECTORY"
# A kernel lock survives child startup and releases even after an unclean stop.
# A second container cannot bootstrap the same installation concurrently.
exec flock --nonblock --no-fork "$FACTORY_STATE_DIRECTORY/container.lock" bun scripts/factory/index.ts container
