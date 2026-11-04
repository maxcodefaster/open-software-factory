# Shared by .github/workflows/images.yaml. Source it; it defines functions only.
# A published combined version tag is never overwritten. A per-architecture tag left by an
# earlier attempt is reused only when it was built from this exact commit.

release_exists() {
  docker buildx imagetools inspect "$1" > /dev/null 2>&1
}

release_digest() {
  local digest
  digest="$(docker buildx imagetools inspect "$1" --format '{{.Manifest.Digest}}')"
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]
  printf '%s\n' "$digest"
}

release_revision() {
  docker buildx imagetools inspect "$1" --format '{{json .Image}}' |
    jq -r '[.. | objects | select(has("Labels")) | .Labels["org.opencontainers.image.revision"] | select(. != null)] | first // empty'
}

# Prints the digests a combined manifest must contain for one source image.
release_children() {
  docker buildx imagetools inspect "$1" --format '{{json .Manifest}}' |
    jq -r 'if .manifests then [.manifests[].digest] else [.digest] end | .[]'
}

release_require_revision() {
  local found
  found="$(release_revision "$1")"
  if [[ "$found" != "$2" ]]; then
    echo "$1 exists but was built from '${found:-unknown}', not $2. Choose a new release version."
    return 1
  fi
}

release_sign() {
  cosign verify \
    --certificate-identity-regexp "^https://github.com/${GITHUB_REPOSITORY}/" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    "$1" > /dev/null 2>&1 || cosign sign --yes "$1"
}

# release_combine COMBINED SOURCE... prints the combined manifest digest.
release_combine() {
  local combined="$1" missing
  shift
  if release_exists "$combined"; then
    missing="$(comm -23 \
      <(for source in "$@"; do release_children "$source"; done | sort -u) \
      <(release_children "$combined" | sort -u))"
    if [[ -n "$missing" ]]; then
      echo "$combined already exists with different contents. Choose a new release version." >&2
      return 1
    fi
  else
    docker buildx imagetools create --tag "$combined" "$@" >&2
  fi
  release_digest "$combined"
}
