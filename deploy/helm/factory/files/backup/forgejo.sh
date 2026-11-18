# shellcheck source=common.sh
. /scripts/common.sh
load_set

# The dump runs inside the Forgejo container, which owns its data volumes and configuration.
# The stock SQL export omits Forgejo's own migration history. Retain the archive for files,
# but use SQLite's Online Backup API for its authoritative, complete database snapshot.
dump() {
  rm -f "$DIR/forgejo.tar.gz.part"
  sh /scripts/run.sh exec forgejo.dump kubectl exec -i --namespace "$BACKUP_NAMESPACE" "$FORGEJO_POD" --container forgejo -- sh -c \
    'set -eu
     set -o pipefail
     umask 077
     temporary="$(mktemp -d "/tmp/factory-backup.$1.XXXXXX")"
     cleanup() { rm -rf "$temporary"; }
     trap cleanup EXIT
     trap "exit 143" TERM
     trap "exit 130" INT
     cat > "$temporary/sqlite"
     test -s "$temporary/sqlite"
     chmod 500 "$temporary/sqlite"
     "$temporary/sqlite" -init /dev/null -batch -bail -readonly -cmd ".timeout 30000" \
       /var/lib/gitea/data/forgejo.db ".backup $temporary/forgejo.sqlite3"
     test "$("$temporary/sqlite" -init /dev/null -batch -bail "$temporary/forgejo.sqlite3" "PRAGMA journal_mode=DELETE;")" = delete
     test "$("$temporary/sqlite" -init /dev/null -batch -bail -readonly "$temporary/forgejo.sqlite3" "PRAGMA integrity_check;")" = ok
     test -z "$("$temporary/sqlite" -init /dev/null -batch -bail -readonly "$temporary/forgejo.sqlite3" "PRAGMA foreign_key_check;")"
     mkdir -p /var/lib/gitea/git/repositories
     forgejo dump --quiet --skip-log --type tar --file "$temporary/files.tar" --tempdir "$temporary" > /dev/null
     tar -tf "$temporary/files.tar" > "$temporary/files.list"
     if grep -Eq "^(\./)?forgejo.sqlite3/?$" "$temporary/files.list"; then exit 1; fi
     size="$(wc -c < "$temporary/files.tar")"
     test "$size" -ge 1024
     test "$((size % 512))" -eq 0
     test "$(tail -c 1024 "$temporary/files.tar" | tr -d "\000" | wc -c)" -eq 0
     # The pinned Go tar writer ends with exactly two zero blocks. Append the snapshot
     # before those terminators, without extracting any archived file or running hooks.
     blocks="$((size / 512 - 2))"
     { dd if="$temporary/files.tar" bs=512 count="$blocks" 2> /dev/null || exit 1
       tar -cf - -C "$temporary" forgejo.sqlite3
     } | gzip' \
    sh "$BACKUP_POD_UID" \
    < /tools/factory-sqlite \
    > "$DIR/forgejo.tar.gz.part" &&
    gzip -t "$DIR/forgejo.tar.gz.part" &&
    tar -tzf "$DIR/forgejo.tar.gz.part" > /tmp/forgejo.list &&
    grep -q '^app.ini$' /tmp/forgejo.list &&
    grep -q '^forgejo.sqlite3$' /tmp/forgejo.list &&
    mv "$DIR/forgejo.tar.gz.part" "$DIR/forgejo.tar.gz"
}

step forgejo retry 3 dump
