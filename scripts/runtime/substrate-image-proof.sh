#!/usr/bin/env bash
# Image/package proof only. No native Actor, Project, snapshot or model
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
    test -x /usr/local/bin/factory-runtime-connector
    test -x /usr/bin/git
    test -s /etc/ssl/certs/ca-certificates.crt
    test -s /usr/lib/libgcc_s.so.1
    test -s /usr/lib/libstdc++.so.6
    test -n "$(git --version)"
    test -n "$(node --version)"
    test -n "$(npm --version)"
    test -n "$(forgejo-runner --version)"
    for libc in glibc musl; do
      test -x "/opt/factory/opencode/$libc/bun"
      test -x "/opt/factory/language-tools/$libc/node"
      test -s "/opt/factory/language-tools/$libc/lib/libgcc_s.so.1"
      test -s "/opt/factory/language-tools/$libc/lib/libstdc++.so.6"
    done
    test -n "$(/opt/factory/opencode/musl/bun --version)"
    test -n "$(LD_LIBRARY_PATH=/opt/factory/language-tools/musl/lib /opt/factory/language-tools/musl/node --version)"
    test -s /opt/factory/language-tools/node_modules/typescript/lib/tsserver.js
    test -s /opt/factory/language-tools/node_modules/typescript-language-server/lib/cli.mjs
    test -s /opt/factory/language-tools/node_modules/pyright/langserver.index.js
    test -s /opt/factory/opencode/server/server.mjs
    test -s /opt/factory/opencode/server/retained-events.mjs
    test -s /opt/factory/opencode/server/install-skills.mjs
    test -s /opt/factory/opencode/server/input-stop.mjs
    test -s /opt/factory/opencode/manifest.json
    test -r /opt/factory/opencode/server/config/AGENTS.md
    test -r /opt/factory/opencode/server/config/opencode.json
    for executable in docker dockerd docker-compose docker-buildx devcontainer \
      containerd containerd-shim-runc-v2 ctr runc buildkitd buildctl rootlesskit \
      dockerd-entrypoint.sh factory-project-prebuild; do
      if command -v "$executable" >/dev/null 2>&1; then
        echo "Obsolete runtime executable is bundled: $executable" >&2
        exit 1
      fi
    done
    for path in /usr/local/libexec/docker /usr/libexec/docker /usr/local/lib/docker \
      /usr/lib/docker /usr/local/lib/node_modules/@devcontainers /opt/factory-rootless; do
      test ! -e "$path"
    done
    if output="$(factory-runtime-connector parent --assignment /tmp/retired-parent-assignment.json 2>&1)"; then
      echo "Retired parent CLI was accepted" >&2
      exit 1
    else
      status=$?
    fi
    test "$status" = 1
    test "$output" = "mode must be a native entrypoint or child"
    test ! -S /var/run/docker.sock
  '
printf '{"nativeActorImagePackages":true,"platform":"%s","nativeActorLifecycle":false}\n' "$platform"
