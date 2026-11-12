BEGIN;

-- A one-job runner must consume its own native job, not an older queued run
-- sharing the repository's Verification label. Existing executions stay intact.
ALTER TABLE factory.verification ADD COLUMN runner_job_handle text;
ALTER TABLE factory.verification ADD CHECK (runner_job_handle IS NULL OR
  (action_run_id IS NOT NULL AND runner_job_handle ~ '^[A-Za-z0-9_-]{1,200}$'));
CREATE FUNCTION factory.protect_verification_job_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.runner_job_handle IS NOT NULL AND
    (NEW.runner_job_handle IS DISTINCT FROM OLD.runner_job_handle OR
     NEW.action_run_id IS DISTINCT FROM OLD.action_run_id OR NEW.commit_sha<>OLD.commit_sha)
    THEN RAISE EXCEPTION 'Verification native job binding is immutable'; END IF;
  IF OLD.runner_job_handle IS NULL AND NEW.runner_job_handle IS NOT NULL AND EXISTS(
    SELECT 1 FROM factory.factorybox_lifecycle_operation
    WHERE runtime_attempt_id=OLD.runtime_attempt_id AND action='start' AND attempted_at IS NOT NULL)
    THEN RAISE EXCEPTION 'Cannot change a dispatched Verification runner'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER verification_job_binding BEFORE UPDATE ON factory.verification
  FOR EACH ROW EXECUTE FUNCTION factory.protect_verification_job_binding();

INSERT INTO factory.schema_migration(version) VALUES(18);
COMMIT;
