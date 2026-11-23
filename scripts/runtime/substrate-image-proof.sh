#!/usr/bin/env bash
# Image/package proof only. No native Actor, private Docker, snapshot or model
# is started here. The separate Substrate live lane owns lifecycle qualification.
set -euo pipefail
image="${1:?Supply the exact locally loaded image ID}"
[[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]]
platform="$(docker image inspect "$image" --format '{{.Os}}/{{.Architecture}}')"
case "$platform" in linux/amd64|linux/arm64) ;; *) echo "Unsupported native Actor platform: $platform" >&2; exit 1 ;; esac
test "$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')" = "$platform"
docker run --rm --network=none --read-only --cap-drop=ALL --user 1000:1000 \
  --security-opt=no-new-privileges --tmpfs /tmp --entrypoint /bin/sh "$image" -ec '
    test "$(id -u)" = 1000
    test "$(docker --version | cut -d" " -f3 | tr -d ,)" = 29.9.0
    test "$(dockerd --version | cut -d" " -f3 | tr -d ,)" = 29.9.0
    test "$(docker compose version --short)" = 5.7.0-dev.1e1c577
    test "$(containerd --version | awk "{print \$3}")" = v2.4.1
    test "$(node --version)" = v24.22.3
    test "$(devcontainer --version)" = 0.89.0
    test "$(tinyproxy -v)" = "tinyproxy 1.11.2"
    test "$(sed -n "s/^Timeout //p" /opt/factory-rootless/tinyproxy.conf)" = 900
    test -x /usr/local/bin/factory-runtime-connector
    test -x /opt/factory-rootless/start.sh
    test -x /opt/factory-rootless/connector.sh
    test -x /opt/factory-rootless/child.sh
    for file in /opt/factory-rootless/*.py; do
      test -r "$file"
      python3 -c "import ast,sys; ast.parse(open(sys.argv[1]).read())" "$file"
    done
    test -r /opt/factory-rootless/tinyproxy.conf
    test -s /opt/factory/opencode/server/server.mjs
    test -s /opt/factory/opencode/server/input-stop.mjs
    test ! -S /var/run/docker.sock
  '
printf '{"nativeActorImagePackages":true,"platform":"%s","nativeActorLifecycle":false}\n' "$platform"
