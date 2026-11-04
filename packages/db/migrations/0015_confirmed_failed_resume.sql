BEGIN;

-- Set only after Factory read the original native record and it positively
-- proves the Resume was attempted and failed before activation. An attempt
-- stuck in 'resuming' without this stamp is an unknown outcome and stays
-- quarantined. Existing attempts keep NULL.
ALTER TABLE factory.runtime_attempt
  ADD COLUMN resume_failed_at timestamp with time zone;

INSERT INTO factory.schema_migration(version) VALUES(15);
COMMIT;
