-- Learning routines. Run before Drizzle tables, with check_function_bodies disabled.

CREATE FUNCTION factory.guard_learning_record() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_TABLE_NAME='learning_review' THEN
    IF (to_jsonb(NEW)-'state'-'result'-'calibrated'-'reason'-'owner_expires_at'-'completed_at'-'steps')
      IS DISTINCT FROM (to_jsonb(OLD)-'state'-'result'-'calibrated'-'reason'-'owner_expires_at'-'completed_at'-'steps')
      OR (OLD.state<>'running' AND NEW IS DISTINCT FROM OLD)
    THEN RAISE EXCEPTION 'Learning admission and settled evidence are immutable'; END IF;
  ELSIF TG_TABLE_NAME='learning_case' THEN
    IF (to_jsonb(NEW)-'batch_id') IS DISTINCT FROM (to_jsonb(OLD)-'batch_id')
      OR (OLD.batch_id IS NOT NULL AND NEW IS DISTINCT FROM OLD)
    THEN RAISE EXCEPTION 'Learning source evidence is immutable'; END IF;
  ELSIF TG_TABLE_NAME='learning_proposal' THEN
    IF (to_jsonb(NEW)-'state'-'decision_id'-'decided_by'-'decided_at'-'ticket_id'-'application')
      IS DISTINCT FROM (to_jsonb(OLD)-'state'-'decision_id'-'decided_by'-'decided_at'-'ticket_id'-'application') THEN
      RAISE EXCEPTION 'Learning proposals and decisions are immutable';
    END IF;
    IF OLD.state<>'proposed' THEN
      IF OLD.state='applied' AND (to_jsonb(NEW)-'application') IS NOT DISTINCT FROM (to_jsonb(OLD)-'application') THEN
        IF OLD.application IS NULL THEN
          -- Allow recording initial application JSON right after proposal transitions to applied.
          NULL;
        ELSIF OLD.application->>'state'='applied'
          AND NEW.application IS NOT NULL
          AND (NEW.application-'state'-'revertedRevisionId'-'revertedVersion'-'revertedBy'-'revertedAt'-'revertedComparisonId')
            IS NOT DISTINCT FROM (OLD.application-'state'-'revertedRevisionId'-'revertedVersion'-'revertedBy'-'revertedAt'-'revertedComparisonId') THEN
          NULL;
        ELSIF NEW IS DISTINCT FROM OLD THEN
          RAISE EXCEPTION 'Learning application and rollback evidence are immutable';
        END IF;
      ELSIF NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Learning proposals and decisions are immutable';
      END IF;
    END IF;
  ELSE
    RAISE EXCEPTION '% is immutable', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END; $$;
