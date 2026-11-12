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
exec dockerd --rootless --default-cgroupns-mode=host --host="$DOCKER_HOST" \
  --data-root=/home/rootless/.local/share/docker \
  --feature containerd-snapshotter=false --storage-driver=vfs \
  --exec-opt native.cgroupdriver=cgroupfs --iptables=false --ip6tables=false \
  --ip-forward=false --ip-masq=false --userland-proxy=true --mtu=1500
