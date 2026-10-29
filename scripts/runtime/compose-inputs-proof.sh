#!/usr/bin/env bash
set -euo pipefail
umask 077

image="${1:?Pass one immutable runtime-host image ID or digest reference}"
if [[ ! "$image" =~ ^sha256:[a-f0-9]{64}$ && ! "$image" =~ ^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$ ]]; then
  echo "The Compose proof requires an immutable image reference" >&2
  exit 1
fi
read -r image_os image_arch < <(docker image inspect --format '{{.Os}} {{.Architecture}}' "$image")
read -r server_os server_arch < <(docker info --format '{{.OSType}} {{.Architecture}}')
case "$server_arch" in x86_64) server_arch=amd64 ;; aarch64) server_arch=arm64 ;; esac
test "$image_os" = linux
test "$server_os" = linux
test "$image_arch" = "$server_arch"

owner="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
name="factory-compose-inputs-$owner"
directory=".factory/test-results/runtime-compose-inputs/$owner"
mkdir -p "$directory"
printf '{"owner":"%s","image":"%s","architecture":"%s","nativeFactoryboxProof":false}\n' \
  "$owner" "$image" "$image_arch" > "$directory/intent.json"
cleanup() {
  result=$?
  trap - EXIT
  if docker inspect "$name" > "$directory/container.json" 2> "$directory/cleanup-observation.log"; then
    actual="$(docker inspect --format '{{ index .Config.Labels "factory.runtime-compose-proof" }}' "$name")"
    if [[ "$actual" != "$owner" ]]; then
      echo "Refusing cleanup of changed Compose proof ownership" >&2
      exit 1
    fi
    docker rm --force --volumes "$name" > "$directory/cleanup.log" || result=1
  elif ! grep -Fq "No such object: $name" "$directory/cleanup-observation.log"; then
    echo "Compose proof cleanup observation is unavailable" >&2
    result=1
  fi
  printf '{"owner":"%s","exitCode":%s}\n' "$owner" "$result" > "$directory/result.json"
  exit "$result"
}
trap cleanup EXIT

# No Project source, credentials, host Docker socket or network access.
# Scratch-only builds exercise the real pinned Compose/Buildx contract.
docker run --pull=never --name "$name" \
  --label "factory.runtime-compose-proof=$owner" \
  --privileged --cgroupns=private --network=none --cpus=3 --memory=3g --pids-limit=512 \
  --env "FACTORY_COMPOSE_PROOF_OWNER=$owner" --entrypoint timeout "$image" \
  -s KILL 420 /bin/sh -euc '
  export DOCKER_HOST=unix:///var/run/docker.sock BUILDX_BAKE_ENTITLEMENTS_FS=1
  dockerd --host="$DOCKER_HOST" >/tmp/owned-dockerd.log 2>&1 &
  daemon=$!
  trap "kill $daemon 2>/dev/null || true" EXIT
  until docker info >/dev/null 2>&1; do
    if ! kill -0 "$daemon" 2>/dev/null; then cat /tmp/owned-dockerd.log; exit 1; fi
    sleep 0.1
  done
  mkdir /tmp/owned-context /tmp/owned-generated
  printf "FROM scratch\nLABEL factory.compose-proof=%s\n" "$FACTORY_COMPOSE_PROOF_OWNER" \
    > /tmp/owned-generated/Dockerfile
  printf "{\"services\":{\"workspace\":{\"build\":{\"context\":\"/tmp/owned-context\",\"dockerfile\":\"/tmp/owned-generated/Dockerfile\"}}}}\n" \
    > /tmp/owned-context/compose.json
  cd /tmp/owned-context
  project="proof_$FACTORY_COMPOSE_PROOF_OWNER"
  docker compose -f compose.json --project-name "$project" build
  test "$(docker image inspect "$project-workspace" --format "{{index .Config.Labels \"factory.compose-proof\"}}")" = "$FACTORY_COMPOSE_PROOF_OWNER"
  printf "{\"target\":{\"default\":{\"context\":\"/tmp/owned-context\",\"dockerfile\":\"/tmp/owned-generated/Dockerfile\"}}}\n" > bake.json
  if docker buildx bake --file bake.json --progress=rawjson >/tmp/owned-negative.log 2>&1; then
    echo "Unconfigured external Dockerfile was not protected" >&2
    exit 1
  fi
  if ! grep -Fq "fs.read=/tmp/owned-generated/Dockerfile\"" /tmp/owned-negative.log \
     && ! grep -Fq "fs.read=../owned-generated/Dockerfile\"" /tmp/owned-negative.log; then
    cat /tmp/owned-negative.log
    echo "The refusal did not identify the exact ungranted Dockerfile" >&2
    exit 1
  fi
  cat /tmp/owned-negative.log
  printf "{\"configuredDockerfileBuilt\":true,\"unconfiguredReadRefused\":true,\"filesystemChecksEnabled\":true}\n"
  ' 2>&1 | tee "$directory/proof.log"
