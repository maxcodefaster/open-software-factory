# shellcheck source=common.sh
. /scripts/common.sh
load_set

# The dump runs inside the Forgejo container, which owns its data volumes and configuration.
# Only the archive streams back here. It holds forgejo-db.sql (a consistent SQL dump) and the
# repositories, attachments and configuration.
dump() {
  rm -f "$DIR/forgejo.tar.gz.part"
  kubectl exec --namespace "$BACKUP_NAMESPACE" "$FORGEJO_POD" --container forgejo -- sh -c \
    'mkdir -p /var/lib/gitea/git/repositories && exec forgejo dump --quiet --skip-log --type tar.gz --file - --tempdir /tmp' \
    > "$DIR/forgejo.tar.gz.part" &&
    gzip -t "$DIR/forgejo.tar.gz.part" &&
    tar -tzf "$DIR/forgejo.tar.gz.part" > /tmp/forgejo.list &&
    grep -q '^forgejo-db.sql$' /tmp/forgejo.list &&
    mv "$DIR/forgejo.tar.gz.part" "$DIR/forgejo.tar.gz"
}

step forgejo retry 3 dump
