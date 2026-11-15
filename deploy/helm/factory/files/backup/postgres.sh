# shellcheck source=common.sh
. /scripts/common.sh
load_set

# Use the existing pinned PostgreSQL Pod's tools, password and local socket. The runner needs
# no database password or PostgreSQL binaries. Only the archive streams onto the backup PVC.
dump() {
  rm -f "$DIR/postgres.dump.part"
  kubectl exec --namespace "$BACKUP_NAMESPACE" "$POSTGRES_POD" --container postgres -- sh -c \
    'export PGPASSWORD="$POSTGRES_PASSWORD"
     exec pg_dump --format=custom --no-password --username=factory --dbname=factory' \
    > "$DIR/postgres.dump.part" &&
    kubectl exec --stdin --namespace "$BACKUP_NAMESPACE" "$POSTGRES_POD" --container postgres -- \
      pg_restore --list < "$DIR/postgres.dump.part" > /dev/null &&
    mv "$DIR/postgres.dump.part" "$DIR/postgres.dump"
}

step postgres retry 5 dump

# A bulk delete with triggers disabled leaves rows whose parent is gone. pg_dump still writes them
# and pg_restore then cannot recreate the foreign key, so the set restores with errors. The set is
# kept, the Job warns, and postgres.orphans lists the constraints and row counts.
orphans() {
  kubectl exec --stdin --namespace "$BACKUP_NAMESPACE" "$POSTGRES_POD" --container postgres -- sh -c \
    'export PGPASSWORD="$POSTGRES_PASSWORD"
     exec psql --no-password --username=factory --dbname=factory -X -At' \
    < /scripts/foreign-keys.sql | awk -F'|' '$3 > 0'
}

rm -f "$DIR/postgres.orphans"
if [ -f "$DIR/postgres.ok" ]; then
  found="$(orphans 2> /dev/null || true)"
  if [ -n "$found" ]; then
    printf '%s\n' "$found" > "$DIR/postgres.orphans"
    echo "WARNING: the database has rows without a parent row (see postgres.orphans); pg_restore will fail to recreate those foreign keys" >&2
  fi
fi
