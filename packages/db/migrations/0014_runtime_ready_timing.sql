BEGIN;

-- Compact readiness timestamps. Existing attempts keep NULL / an empty map.
-- ready_at is the latest transition into 'ready'; app_ready_at maps each
-- declared App to the first moment Factory observed it serving.
ALTER TABLE factory.runtime_attempt
  ADD COLUMN ready_at timestamp with time zone,
  ADD COLUMN app_ready_at jsonb DEFAULT '{}'::jsonb NOT NULL,
  ADD CONSTRAINT runtime_attempt_app_ready_shape CHECK (
    jsonb_typeof(app_ready_at)='object' AND octet_length(app_ready_at::text)<=4096
  );

INSERT INTO factory.schema_migration(version) VALUES(14);
COMMIT;
