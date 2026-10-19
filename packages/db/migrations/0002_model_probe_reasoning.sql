BEGIN;

ALTER TABLE factory.model_role_probe
  ADD COLUMN reasoning_effort text,
  ADD CONSTRAINT model_role_probe_reasoning_check CHECK (
    reasoning_effort IS NULL OR
    (role = 'build' AND reasoning_effort IN ('medium', 'high', 'xhigh', 'max'))
  );

INSERT INTO factory.schema_migration(version) VALUES (2);
COMMIT;
