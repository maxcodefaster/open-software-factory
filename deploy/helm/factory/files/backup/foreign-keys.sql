-- One row per foreign key in the auth and factory schemas: constraint|table|rows without a parent.
-- The server enforces the constraints on writes, but a bulk delete with triggers disabled leaves
-- orphans that pg_restore rejects when it recreates the constraint. The backup Job warns about them,
-- and restore-rehearsal.ts reads the same file before it backs anything up.
WITH fk AS (
  SELECT c.conname, c.conrelid::regclass AS child, c.confrelid::regclass AS parent,
    (SELECT string_agg(format('c.%I = p.%I', ca.attname, pa.attname), ' AND ' ORDER BY k.n)
       FROM unnest(c.conkey, c.confkey) WITH ORDINALITY k(child_att, parent_att, n)
       JOIN pg_attribute ca ON ca.attrelid = c.conrelid AND ca.attnum = k.child_att
       JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = k.parent_att) AS matches,
    (SELECT string_agg(format('c.%I IS NOT NULL', ca.attname), ' AND ')
       FROM unnest(c.conkey) k(att)
       JOIN pg_attribute ca ON ca.attrelid = c.conrelid AND ca.attnum = k.att) AS present
  FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
  WHERE c.contype = 'f' AND n.nspname IN ('auth', 'factory'))
SELECT conname || '|' || child || '|' ||
  (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %s c WHERE %s AND NOT EXISTS (SELECT 1 FROM %s p WHERE %s)', child, present, parent, matches), false, true, '')))[1]::text
FROM fk ORDER BY 1;
