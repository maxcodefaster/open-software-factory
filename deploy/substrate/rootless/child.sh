#!/bin/sh
set -eu
# These cgroup mounts are INSIDE the Actor's rootless user/mount namespace.
# They do not establish qualified per-inner-container resource enforcement.
for controller in cpu cpuacct cpuset devices job memory pids; do
  mkdir -p "/home/rootless/cgroups/$controller"
  mount -t cgroup -o "$controller" none "/home/rootless/cgroups/$controller"
done
tinyproxy -d -c /opt/factory-rootless/tinyproxy.conf &
mkdir -p /run/user/1000/docker/containerd
containerd --config /opt/factory-rootless/containerd.toml &
containerd_pid=$!
python3 /opt/factory-rootless/wait.py containerd "$containerd_pid"
exec dockerd --rootless --host="$DOCKER_HOST" \
  --data-root=/home/rootless/.local/share/docker \
  --feature containerd-snapshotter=false --storage-driver=vfs \
  --exec-opt native.cgroupdriver=cgroupfs --iptables=false --ip6tables=false \
  --ip-forward=false --ip-masq=false --userland-proxy=true --mtu=1500 \
  --containerd=/run/user/1000/docker/containerd/containerd.sock \
  --containerd-namespace=moby --containerd-plugins-namespace=plugins.moby
