# shellcheck source=common.sh
. /scripts/common.sh
SET="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir "$BACKUP/$SET"
printf '%s' "$SET" > "$BACKUP/.current"
echo "Backup set $SET"
