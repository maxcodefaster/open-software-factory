-- Verification routines. Run before Drizzle tables, with check_function_bodies disabled.

CREATE FUNCTION factory.protect_verification_job_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.runner_job_handle IS NOT NULL AND
    (NEW.runner_job_handle IS DISTINCT FROM OLD.runner_job_handle OR
      NEW.action_run_id IS DISTINCT FROM OLD.action_run_id OR NEW.commit_sha<>OLD.commit_sha)
    THEN RAISE EXCEPTION 'Verification native job binding is immutable'; END IF;
  IF OLD.runner_job_handle IS NULL AND NEW.runner_job_handle IS NOT NULL AND EXISTS(
    SELECT 1 FROM factory.runtime_attempt a
    WHERE a.id=OLD.runtime_attempt_id AND a.create_attempted_at IS NOT NULL)
    THEN RAISE EXCEPTION 'Cannot change a dispatched Verification runner'; END IF;
  RETURN NEW;
END $$;
