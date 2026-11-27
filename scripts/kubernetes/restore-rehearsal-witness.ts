// Witness verification shell programs for restored PostgreSQL and Forgejo repositories.
import { shellQuote, tableWitnesses } from "./restore-rehearsal-common";
import type { Digest } from "./restore-rehearsal-types";

export function forgejoWitnessProgram(repositories: string[]) {
  return `set -eu
export HOME=/tmp GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_NO_REPLACE_OBJECTS=1
${repositories
  .map(
    (repo) => `# Restored config, including includes, must not weaken the independent check.
if git --git-dir=${shellQuote(repo)} config --includes --get-regexp '^fsck\\.' >/dev/null 2>&1; then
  exit 1
else
  test "$?" -eq 1
fi
git --git-dir=${shellQuote(repo)} fsck --full --strict >/dev/null 2>&1`,
  )
  .join("\n")}
`;
}

export function postgresWitnessProgram(tables: Record<string, Digest>, foreignKeys: string) {
  tableWitnesses(tables, true);
  const names = Object.keys(tables).sort();
  return `set -euo pipefail
# PG_WITNESS: canonical COPY bytes, no raw row leaves the owned container.
export PGOPTIONS='-c timezone=UTC -c extra_float_digits=3 -c bytea_output=hex -c default_transaction_read_only=on'
psql() { command psql -X -q -v ON_ERROR_STOP=1 -U factory -d factory "$@"; }
actual="$(psql -Atc "SELECT n.nspname||'.'||c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('auth','factory') AND c.relkind='r' ORDER BY (n.nspname||'.'||c.relname) COLLATE \\"C\\"")"
test "$actual" = ${shellQuote(names.join("\n"))}
test "$(psql -Atc "SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname IN ('auth','factory') AND c.contype='f' AND NOT c.convalidated")" = 0
fk="$(psql -At <<'FACTORY_FK_SQL'
${foreignKeys}
FACTORY_FK_SQL
)"
test -n "$fk"
if printf '%s\\n' "$fk" | grep -qv '|0$'; then exit 1; fi
printf '{'
${names
  .map((table, i) => {
    const qualified = table
      .split(".")
      .map((part) => `"${part}"`)
      .join(".");
    return `count="$(psql -Atc 'SELECT count(*) FROM ${qualified}')"
digest="$(psql -c 'COPY (SELECT row_to_json(t)::text AS row FROM ${qualified} t ORDER BY row_to_json(t)::text COLLATE "C") TO STDOUT' | sha256sum)"
printf '${i ? "," : ""}"${table}":{"rows":%s,"sha256":"%s"}' "$count" "\${digest%% *}"`;
  })
  .join("\n")}
printf '}'
`;
}
