# shellcheck source=common.sh
. /scripts/common.sh
load_set

failed=0
for name in postgres forgejo objects openbao state; do
  if [ ! -f "$DIR/$name.ok" ] && [ ! -f "$DIR/$name.skipped" ]; then
    echo "Backup set $SET is incomplete: $name did not finish" >&2
    failed=1
  fi
done
if [ "$failed" -ne 0 ]; then
  exit 1
fi
: > "$DIR/COMPLETE"
echo "Backup set $SET is complete"
if [ -f "$DIR/openbao.skipped" ]; then echo "WARNING: set $SET has no OpenBao snapshot" >&2; fi

# Keep the newest BACKUP_RETENTION complete sets. Incomplete sets from earlier runs and the object
# changes that belong to deleted sets go with them.
sets=''
for path in "$BACKUP"/[0-9]*T*Z; do
  if [ -d "$path" ]; then sets="$(basename "$path") $sets"; fi
done
kept=0
for old in $sets; do
  if [ "$old" = "$SET" ] || [ -f "$BACKUP/$old/COMPLETE" ]; then
    kept=$((kept + 1))
    if [ "$kept" -le "$BACKUP_RETENTION" ]; then continue; fi
  fi
  echo "Pruning backup set $old"
  rm -rf "${BACKUP:?}/$old" "${BACKUP:?}/objects-changed/$old"
done

if [ -n "${BACKUP_REMOTE:-}" ]; then
  # Sets and the object mirror are copied, never synchronized: lifecycle rules at the remote decide
  # what to delete.
  upload() {
    retry 5 rclone copy "$1" "$BACKUP_REMOTE/$2" --retries 3 --low-level-retries 5
  }
  uploaded=1
  upload "$DIR" "$SET" || uploaded=0
  upload "$BACKUP/objects" objects || uploaded=0
  if [ -d "$BACKUP/objects-changed/$SET" ]; then
    upload "$BACKUP/objects-changed/$SET" "objects-changed/$SET" || uploaded=0
  fi
  if [ "$uploaded" -ne 1 ]; then
    echo "Backup set $SET is complete locally but the upload to the remote failed" >&2
    exit 1
  fi
  echo "Uploaded backup set $SET"
fi
