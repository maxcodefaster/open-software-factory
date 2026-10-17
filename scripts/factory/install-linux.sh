#!/usr/bin/env bash
# Optional single-node bootstrap. Never replaces or adopts an existing cluster.
set -euo pipefail
[[ "$(uname -s)" == Linux && "$(id -u)" == 0 ]] || { echo 'Run as root on Linux.' >&2; exit 1; }
for tool in curl sha256sum systemctl python3 docker; do
  command -v "$tool" > /dev/null || { echo "Install $tool first." >&2; exit 1; }
done
[[ -f /sys/fs/cgroup/cgroup.controllers ]] || { echo 'cgroup v2 is required.' >&2; exit 1; }
docker info --format '{{.OSType}}' | grep -qx linux
for existing in /usr/local/bin/k3s /usr/local/bin/factory-k3s /etc/rancher/k3s /etc/rancher/factory-k3s.yaml /etc/kubernetes /var/lib/factory-k3s /etc/systemd/system/factory-k3s.service; do
  [[ ! -e "$existing" ]] || { echo "Existing cluster state at $existing. Configure its kubeconfig instead." >&2; exit 1; }
done
case "$(uname -m)" in
  x86_64) arch=amd64; binary=k3s ;;
  aarch64|arm64) arch=arm64; binary=k3s-arm64 ;;
  *) echo 'Only amd64 and arm64 are supported.' >&2; exit 1 ;;
esac
repository="$(cd "$(dirname "$0")/../.." && pwd)"
read -r version checksum < <(python3 - "$repository/upstream.json" "$arch" <<'PY'
import json, sys
pin = json.load(open(sys.argv[1]))["k3s"]
print(pin["version"], pin["sha256"][sys.argv[2]])
PY
)
temporary="$(mktemp -d -t factory-k3s.XXXXXXXX)"
trap 'rm -f "$temporary/k3s"; rmdir "$temporary"' EXIT
curl --fail --location --retry 3 "https://github.com/k3s-io/k3s/releases/download/${version}/${binary}" -o "$temporary/k3s"
printf '%s  %s\n' "$checksum" "$temporary/k3s" | sha256sum --check
install -m 755 "$temporary/k3s" /usr/local/bin/factory-k3s
install -m 644 "$repository/deploy/local/factory-k3s.service" /etc/systemd/system/factory-k3s.service
systemctl daemon-reload
systemctl enable --now factory-k3s
echo 'Kubernetes is starting. Use /etc/rancher/factory-k3s.yaml as FACTORY_KUBECONFIG.'
echo 'Choose FACTORY_RUNTIME_HOST as a host address reachable from Pods and Docker containers.'
