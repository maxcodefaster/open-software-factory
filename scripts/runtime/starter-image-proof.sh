#!/usr/bin/env bash
# Package proof only: execute the recipe's default non-root user and version tools,
# not the App, a database server, a native Actor or a snapshot.
set -euo pipefail
image="${1:?Supply the exact locally loaded image ID}"
role="${2:?Supply starter-work or starter-postgres}"
[[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
case "$role" in
  starter-work)
    recipe=work
    base=node
    proof='
      test "$(id -u)" = 1000
      test "$(id -g)" = 1000
      test "$(node --version)" = "v$FACTORY_STARTER_VERSION"
      case "$(git --version)" in "git version "*) ;; *) exit 1 ;; esac
    '
    ;;
  starter-postgres)
    recipe=postgres
    base=postgres
    proof='
      test "$(id -u)" -ne 0
      test "$(id -u)" = "$(id -u postgres)"
      test "$(id -g)" = "$(id -g postgres)"
      case "$(postgres --version)" in
        "postgres (PostgreSQL) $FACTORY_STARTER_VERSION"|"postgres (PostgreSQL) $FACTORY_STARTER_VERSION ("*) ;;
        *) exit 1 ;;
      esac
    '
    ;;
  *) echo "Unsupported Starter proof role: $role" >&2; exit 1 ;;
esac
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
version="$(sed -n "s|^FROM docker.io/library/$base:\\([0-9.]*\\)-.*$|\\1|p" "$root/templates/starter-app/.factory/images/$recipe/Dockerfile")"
[[ "$version" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]] || exit 1
platform="$(docker image inspect "$image" --format '{{.Os}}/{{.Architecture}}')"
case "$platform" in linux/amd64|linux/arm64) ;; *) echo "Unsupported Starter platform: $platform" >&2; exit 1 ;; esac
test "$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')" = "$platform"
owner="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
name="factory-starter-image-proof-$owner"
directory="$(mktemp -d "${TMPDIR:-/tmp}/factory-starter-proof.XXXXXX")"
child=""
cleanup() {
  result=$?
  trap - EXIT
  trap '' INT TERM
  # Killing only the CLI does not remove a daemon-owned container. Reap it first
  # so it cannot issue a later start while exact container cleanup is in progress.
  if [[ -n "$child" ]]; then
    kill -KILL "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  if docker container inspect --format '{{.Id}} {{index .Config.Labels "factory.starter-image-proof"}}' "$name" \
    > "$directory/observation" 2> "$directory/error"; then
    read -r actual_id actual_owner < "$directory/observation"
    expected_id="$(cat "$directory/cid" 2>/dev/null || true)"
    # A cancelled create can precede its cidfile. Its unique name and owner still
    # identify the disposable resource; a recorded CID must never be replaced.
    if [[ "$actual_owner" != "$owner" || ! "$actual_id" =~ ^[a-f0-9]{64}$ ||
      ( -n "$expected_id" && "$actual_id" != "$expected_id" ) ]]; then
      echo "Refusing Starter proof cleanup: container identity changed ($name)" >&2
      result=1
    elif ! docker rm --force --volumes "$actual_id" > "$directory/removal" 2>&1; then
      cat "$directory/removal" >&2
      result=1
    fi
  elif ! grep -Fq "No such container: $name" "$directory/error" &&
    ! grep -Fq "No such object: $name" "$directory/error"; then
    cat "$directory/error" >&2
    result=1
  fi
  rm -rf -- "$directory"
  if [[ "$result" == 0 ]]; then
    printf '{"starterImagePackages":true,"role":"%s","platform":"%s","version":"%s","nativeActorLifecycle":false}\n' "$role" "$platform" "$version"
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Deliberately no --user: overriding it would conceal a root-default recipe.
docker run --pull=never --name "$name" --label "factory.starter-image-proof=$owner" \
  --cidfile "$directory/cid" --network=none --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges --cpus=1 --memory=256m \
  --env "FACTORY_STARTER_VERSION=$version" --entrypoint /bin/sh "$image" -ec "$proof" &
child=$!
result=0
wait "$child" || result=$?
child=""
exit "$result"
