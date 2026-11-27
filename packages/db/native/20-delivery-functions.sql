-- Delivery routines. Run before Drizzle tables, with check_function_bodies disabled.

CREATE FUNCTION factory.guard_candidate_review() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.id,NEW.verification_id,NEW.change_id,NEW.commit_sha,NEW.base_sha,NEW.created_at,NEW.repair_command_id,NEW.ordinal,NEW.created_by,NEW.supersedes_id,NEW.finding_source_id,NEW.focus_review_id)
    IS DISTINCT FROM ROW(OLD.id,OLD.verification_id,OLD.change_id,OLD.commit_sha,OLD.base_sha,OLD.created_at,OLD.repair_command_id,OLD.ordinal,OLD.created_by,OLD.supersedes_id,OLD.finding_source_id,OLD.focus_review_id)
    OR (OLD.turn_id IS NOT NULL AND NEW.turn_id IS DISTINCT FROM OLD.turn_id)
    OR (OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result)
    OR (OLD.finding_checks IS NOT NULL AND NEW.finding_checks IS DISTINCT FROM OLD.finding_checks)
    OR (OLD.state IN ('passed','changes-requested','incomplete') AND
      ROW(NEW.state,NEW.evidence,NEW.completed_at,NEW.finding_checks,NEW.ui_required) IS DISTINCT FROM
      ROW(OLD.state,OLD.evidence,OLD.completed_at,OLD.finding_checks,OLD.ui_required))
  THEN RAISE EXCEPTION 'Candidate review intent and confirmed outcome are immutable'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION factory.protect_project_release_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (NEW.id,NEW.project_id,NEW.command_id,NEW.version,NEW.commit_sha,NEW.workflow,NEW.contract,NEW.notes,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM
    (OLD.id,OLD.project_id,OLD.command_id,OLD.version,OLD.commit_sha,OLD.workflow,OLD.contract,OLD.notes,OLD.created_by,OLD.created_at)
    OR (OLD.state='published' AND NEW IS DISTINCT FROM OLD)
    OR (OLD.artifacts<>'[]'::jsonb AND NEW.artifacts IS DISTINCT FROM OLD.artifacts) THEN
    RAISE EXCEPTION 'Release identity and published outcome are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
