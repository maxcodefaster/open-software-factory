-- Learning routines. Run before Drizzle tables, with check_function_bodies disabled.

CREATE FUNCTION factory.guard_learning_record() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_TABLE_NAME IN ('learning_review','learning_trial') THEN
    IF (to_jsonb(NEW)-'state'-'result'-'calibrated'-'reason'-'owner_expires_at'-'completed_at')
      IS DISTINCT FROM (to_jsonb(OLD)-'state'-'result'-'calibrated'-'reason'-'owner_expires_at'-'completed_at')
      OR (OLD.state<>'running' AND NEW IS DISTINCT FROM OLD)
    THEN RAISE EXCEPTION 'Learning admission and settled evidence are immutable'; END IF;
  ELSIF TG_TABLE_NAME='learning_trial_step' THEN
    IF (to_jsonb(NEW)-'state'-'result'-'completed_at')
      IS DISTINCT FROM (to_jsonb(OLD)-'state'-'result'-'completed_at')
      OR (OLD.state<>'running' AND NEW IS DISTINCT FROM OLD)
    THEN RAISE EXCEPTION 'Learning comparison calls are immutable'; END IF;
  ELSIF TG_TABLE_NAME='learning_case' THEN
    IF (to_jsonb(NEW)-'batch_id') IS DISTINCT FROM (to_jsonb(OLD)-'batch_id')
      OR (OLD.batch_id IS NOT NULL AND NEW IS DISTINCT FROM OLD)
    THEN RAISE EXCEPTION 'Learning source evidence is immutable'; END IF;
  ELSIF TG_TABLE_NAME='learning_proposal' THEN
    IF (to_jsonb(NEW)-'state'-'decision_id'-'decided_by'-'decided_at'-'ticket_id')
      IS DISTINCT FROM (to_jsonb(OLD)-'state'-'decision_id'-'decided_by'-'decided_at'-'ticket_id')
      OR (OLD.state<>'proposed' AND NEW IS DISTINCT FROM OLD)
    THEN RAISE EXCEPTION 'Learning proposals and decisions are immutable'; END IF;
  ELSIF TG_TABLE_NAME='learning_application' THEN
    IF (to_jsonb(NEW)-'state'-'reverted_revision_id'-'reverted_version'-'reverted_by'-'reverted_at'-'reverted_comparison_id')
      IS DISTINCT FROM (to_jsonb(OLD)-'state'-'reverted_revision_id'-'reverted_version'-'reverted_by'-'reverted_at'-'reverted_comparison_id')
      OR (OLD.state<>'applied' AND NEW IS DISTINCT FROM OLD)
    THEN RAISE EXCEPTION 'Learning application and rollback evidence are immutable'; END IF;
  ELSE
    RAISE EXCEPTION 'Learning command receipts are immutable';
  END IF;
  RETURN NEW;
END; $$;
