# shellcheck source=common.sh
. /scripts/common.sh
load_set

# pg_dump reads one snapshot, so the custom-format file is consistent while Factory runs.
dump() {
  rm -f "$DIR/postgres.dump.part"
  pg_dump --format=custom --no-password --file="$DIR/postgres.dump.part" &&
    pg_restore --list "$DIR/postgres.dump.part" > /dev/null &&
    mv "$DIR/postgres.dump.part" "$DIR/postgres.dump"
}

step postgres retry 5 dump
