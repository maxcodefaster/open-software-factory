#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

image="${1:?Pass an immutable runtime-host image}"
node_image="${2:?Pass an immutable native Node image}"
registry_image="${3:?Pass an immutable Registry image}"
for reference in "$image" "$node_image" "$registry_image"; do
  if [[ ! "$reference" =~ ^sha256:[a-f0-9]{64}$ && ! "$reference" =~ ^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$ ]]; then
    echo "The Compose prebuild proof requires immutable image references" >&2
    exit 1
  fi
  if ! docker image inspect "$reference" >/dev/null 2>&1; then docker pull "$reference"; fi
done
read -r server_os architecture < <(docker info --format '{{.OSType}} {{.Architecture}}')
case "$architecture" in x86_64) architecture=amd64 ;; aarch64) architecture=arm64 ;; esac
test "$server_os" = linux
for reference in "$image" "$node_image" "$registry_image"; do
  test "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$reference")" = "linux/$architecture"
done
node_id="$(docker image inspect --format '{{.Id}}' "$node_image")"
registry_id="$(docker image inspect --format '{{.Id}}' "$registry_image")"
owner="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
name="factory-compose-prebuild-$owner"
directory="$PWD/.factory/test-results/runtime-compose-prebuild/$owner"
mkdir -p "$directory"
printf '{"owner":"%s","image":"%s","platform":"linux/%s","nativeFactoryboxProof":false,"network":"none","cpu":3,"memoryGiB":3}\n' \
  "$owner" "$image" "$architecture" > "$directory/intent.json"
cleanup() {
  result=$?
  trap - EXIT
  if docker inspect "$name" > "$directory/container.json" 2> "$directory/cleanup-observation.log"; then
    actual="$(docker inspect --format '{{ index .Config.Labels "factory.compose-prebuild-proof" }}' "$name")"
    if [[ "$actual" != "$owner" ]]; then echo "Owned Compose proof identity changed" >&2; exit 1; fi
    docker cp "$name:/tmp/compose-prebuild-result.json" "$directory/native-result.json" 2>/dev/null || true
    for kind in build image-only; do
      docker cp "$name:/tmp/compose-prebuild-result-$kind.json" "$directory/native-$kind-result.json" 2>/dev/null || true
    done
    docker cp "$name:/tmp/owned-devcontainer-build.log" "$directory/devcontainer-build.log" 2>/dev/null || true
    docker rm --force --volumes "$name" > "$directory/cleanup.log" || result=1
  elif ! grep -Fq "No such object: $name" "$directory/cleanup-observation.log"; then
    result=1
  fi
  rm -f "$directory/images.tar" "$directory/compose-prebuild.test"
  printf '{"owner":"%s","exitCode":%s,"nativeFactoryboxProof":false}\n' "$owner" "$result" > "$directory/result.json"
  exit "$result"
}
trap cleanup EXIT
(
  cd services/runtime-connector
  CGO_ENABLED=0 GOOS=linux GOARCH="$architecture" go test -c -o "$directory/compose-prebuild.test" ./connector
)
docker save --output "$directory/images.tar" "$node_id" "$registry_id"
docker create --pull=never --name "$name" --label "factory.compose-prebuild-proof=$owner" \
  --privileged --cgroupns=private --network=none --cpus=3 --memory=3g --pids-limit=512 \
  --env "FACTORY_COMPOSE_PREBUILD_NATIVE=1" \
  --env "FACTORY_COMPOSE_PROOF_PLATFORM=linux/$architecture" \
  --env "FACTORY_COMPOSE_PROOF_NODE=$node_id" --env "FACTORY_COMPOSE_PROOF_REGISTRY=$registry_id" \
  --entrypoint timeout "$image" -s KILL 420 /bin/sh -euc '
    export DOCKER_HOST=unix:///var/run/docker.sock
    dockerd --host="$DOCKER_HOST" >/tmp/owned-dockerd.log 2>&1 &
    daemon=$!
    trap "kill $daemon 2>/dev/null || true" EXIT
    until docker info >/dev/null 2>&1; do
      if ! kill -0 "$daemon" 2>/dev/null; then cat /tmp/owned-dockerd.log; exit 1; fi
      sleep 0.1
    done
    docker load --input /tmp/images.tar >/dev/null
    for kind in build image-only; do
      FACTORY_COMPOSE_PROOF_KIND="$kind" /tmp/compose-prebuild.test -test.run "^TestPrebuildComposeNative$" -test.v
    done
  ' >/dev/null
docker cp "$directory/images.tar" "$name:/tmp/images.tar"
docker cp "$directory/compose-prebuild.test" "$name:/tmp/compose-prebuild.test"
docker start --attach "$name" 2>&1 | tee "$directory/proof.log"
test "$(docker inspect --format '{{.State.ExitCode}}' "$name")" = 0
