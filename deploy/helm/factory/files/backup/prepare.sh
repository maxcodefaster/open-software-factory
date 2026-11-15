# shellcheck source=common.sh
. /scripts/common.sh
SET="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir "$BACKUP/$SET" || exit 1
printf '%s' "$SET" > "$BACKUP/.current" || exit 1
echo "Backup set $SET"
