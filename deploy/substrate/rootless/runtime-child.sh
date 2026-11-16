#!/bin/sh
set -eu
# Factory Docker 29.9 owns its matching managed containerd. Do not mix the
# bootstrap image's old external containerd with the current official shim.
for controller in cpu cpuacct cpuset devices job memory pids; do
  mkdir -p "/home/rootless/cgroups/$controller"
  mount -t cgroup -o "$controller" none "/home/rootless/cgroups/$controller"
done
tinyproxy -d -c /opt/factory-rootless/tinyproxy.conf &
# Source is restored before Docker can restart any retained container, watcher
# or Agent. This is a fixed authenticated import, never a saved command queue.
/usr/local/bin/factory-runtime-connector native-source-restore
mode="$(/usr/local/bin/factory-runtime-connector native-bootstrap-mode)"
# The cold step owner-validates native roots plus the frozen Factory public CA.
# Select that exact bundle before private dockerd can cache its TLS roots.
export SSL_CERT_FILE=/home/rootless/persist/connector/trust.pem
case "$mode" in
  input-stop) exec /usr/local/bin/factory-runtime-connector native-parent ;;
  docker) ;;
  *) echo 'Unconfirmed native cold mode; Docker was not started' >&2; exit 1 ;;
esac
# Native durableDir supports Overlay; the Actor rootfs does not. Keep Docker's
# graph outside Source and behind a private parent, since dockerd uses 0710 for
# its own data root. A cold start preserves this tree and refuses unsafe owners.
storage=/home/rootless/persist/docker
test ! -L "$storage"
if [ ! -e "$storage" ]; then
  mkdir -m 0700 "$storage"
fi
test -d "$storage"
test "$(stat -c '%u:%g:%a' "$storage")" = 0:0:700
exec dockerd --rootless --default-cgroupns-mode=host --host="$DOCKER_HOST" \
  --data-root=/home/rootless/persist/docker/graph \
  --feature containerd-snapshotter=false --storage-driver=overlay2 \
  --exec-opt native.cgroupdriver=cgroupfs --iptables=false --ip6tables=false \
  --ip-forward=false --ip-masq=false --userland-proxy=true --mtu=1500
