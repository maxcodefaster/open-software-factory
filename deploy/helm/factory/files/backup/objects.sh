# shellcheck source=common.sh
. /scripts/common.sh
load_set

# One mirror of the bucket. Objects that were replaced or deleted since the previous run move to
# objects-changed/<set> instead of vanishing, and finalize.sh prunes them with that set. This runs
# after the PostgreSQL dump, so the mirror holds every object that dump refers to.
mirror() {
  rclone sync objects:factory "$BACKUP/objects" --backup-dir "$BACKUP/objects-changed/$SET" \
    --retries 3 --low-level-retries 5 --create-empty-src-dirs &&
    rclone check objects:factory "$BACKUP/objects" --one-way --size-only
}

step objects retry 3 mirror
