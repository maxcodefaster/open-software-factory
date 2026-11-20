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

CREATE FUNCTION factory.guard_review_media() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.id,NEW.change_id,NEW.review_id,NEW.browser_session_id,NEW.created_by,
      NEW.kind,NEW.commit_sha,NEW.runtime_attempt_id,NEW.source_context)
    IS DISTINCT FROM ROW(OLD.id,OLD.change_id,OLD.review_id,OLD.browser_session_id,OLD.created_by,
      OLD.kind,OLD.commit_sha,OLD.runtime_attempt_id,OLD.source_context)
    OR (OLD.state='complete' AND (
      ROW(NEW.sha256,NEW.byte_length,NEW.duration_ms,NEW.completed_at,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.sha256,OLD.byte_length,OLD.duration_ms,OLD.completed_at,OLD.created_at)
      OR NEW.state NOT IN ('complete','deleted')))
    OR (OLD.state IN ('deleted','unavailable') AND NEW.state<>OLD.state)
    OR (OLD.kind='still' AND OLD.sha256 IS NOT NULL AND
      ROW(NEW.sha256,NEW.byte_length) IS DISTINCT FROM ROW(OLD.sha256,OLD.byte_length))
  THEN RAISE EXCEPTION 'Review media identity and completed content are immutable'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION factory.guard_review_scenario() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE review factory.candidate_review;
BEGIN
  SELECT * INTO review FROM factory.candidate_review WHERE id=NEW.review_id FOR UPDATE;
  IF review.result IS NOT NULL OR review.state NOT IN ('pending','running')
    OR (TG_OP='UPDATE' AND (
      OLD.ended_at IS NOT NULL OR
      ROW(NEW.review_id,NEW.id,NEW.title,NEW.category,NEW.criterion,NEW.expected,NEW.started_at,NEW.observation_kind)
      IS DISTINCT FROM ROW(OLD.review_id,OLD.id,OLD.title,OLD.category,OLD.criterion,OLD.expected,OLD.started_at,OLD.observation_kind)))
  THEN RAISE EXCEPTION 'Review scenario intent and completed outcome are immutable'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION factory.protect_delivery_policy() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.id,NEW.project_id,NEW.delegated_by,NEW.created_at) IS DISTINCT FROM
    ROW(OLD.id,OLD.project_id,OLD.delegated_by,OLD.created_at)
    OR (OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Delivery delegation and revocation are immutable';
  END IF;
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

CREATE FUNCTION factory.protect_promotion_operation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE previous factory.promotion_operation%ROWTYPE;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.ordinal>1 THEN
      SELECT * INTO previous FROM factory.promotion_operation WHERE id=NEW.supersedes_id;
      IF NOT FOUND OR previous.state<>'failed' OR previous.ordinal+1<>NEW.ordinal
        OR ROW(NEW.change_id,NEW.project_id,NEW.commit_sha,NEW.previous_runtime_attempt_id)
          IS DISTINCT FROM ROW(previous.change_id,previous.project_id,previous.commit_sha,previous.previous_runtime_attempt_id)
        OR NEW.state<>'pending' OR NEW.replacement_runtime_attempt_id IS NOT NULL
        OR NOT EXISTS(SELECT 1 FROM factory.execution_policy_command command
          WHERE command.command_id=NEW.retry_command_id
            AND command.scope='promotion-retry:'||NEW.change_id
            AND command.input->>'changeID'=NEW.change_id::text
            AND command.input->>'promotionID'=previous.id::text)
      THEN RAISE EXCEPTION 'Promotion retry requires its exact failed predecessor and human command'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.change_id,NEW.project_id,NEW.commit_sha,NEW.previous_runtime_attempt_id,
      NEW.requested_at,NEW.ordinal,NEW.supersedes_id,NEW.retry_command_id)
    IS DISTINCT FROM ROW(OLD.id,OLD.change_id,OLD.project_id,OLD.commit_sha,OLD.previous_runtime_attempt_id,
      OLD.requested_at,OLD.ordinal,OLD.supersedes_id,OLD.retry_command_id)
    OR (OLD.replacement_runtime_attempt_id IS NOT NULL
      AND NEW.replacement_runtime_attempt_id IS DISTINCT FROM OLD.replacement_runtime_attempt_id)
    OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)
    OR (OLD.state IN ('succeeded','failed') AND NEW.state IS DISTINCT FROM OLD.state)
    OR (OLD.state='failed' AND NEW IS DISTINCT FROM OLD)
  THEN RAISE EXCEPTION 'Promotion identity and terminal outcome are immutable'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION factory.protect_pull_request_operation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.change_id <> OLD.change_id
    OR NEW.repository_owner <> OLD.repository_owner
    OR NEW.repository_name <> OLD.repository_name
    OR NEW.base_branch <> OLD.base_branch
    OR NEW.head_branch <> OLD.head_branch
    OR NEW.first_head_sha <> OLD.first_head_sha
    OR NEW.title <> OLD.title
    OR NEW.body <> OLD.body
    OR NEW.idempotency_key <> OLD.idempotency_key
    OR (OLD.state IN ('succeeded', 'failed') AND NEW IS DISTINCT FROM OLD)
  THEN
    RAISE EXCEPTION 'Pull request intent or terminal result is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.protect_release_attempt_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (NEW.id,NEW.release_id,NEW.command_id,NEW.ordinal,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.release_id,OLD.command_id,OLD.ordinal,OLD.created_at)
    OR (OLD.dispatch_intended_at IS NOT NULL AND NEW.dispatch_intended_at IS DISTINCT FROM OLD.dispatch_intended_at)
    OR (OLD.run_id IS NOT NULL AND NEW.run_id IS DISTINCT FROM OLD.run_id)
    OR (OLD.job_handle IS NOT NULL AND NEW.job_handle IS DISTINCT FROM OLD.job_handle)
    OR (OLD.runtime_attempt_id IS NOT NULL AND NEW.runtime_attempt_id IS DISTINCT FROM OLD.runtime_attempt_id)
    OR (OLD.runner_id IS NOT NULL AND (NEW.runner_id,NEW.runner_uuid) IS DISTINCT FROM (OLD.runner_id,OLD.runner_uuid)) THEN
    RAISE EXCEPTION 'Publication attempt identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;

CREATE FUNCTION factory.protect_staging_configuration() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Staging execution declaration is immutable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM factory.runtime_attempt WHERE id=NEW.runtime_attempt_id
    AND isolated_kind='staging' AND state='create-intended' AND stop_intended_at IS NULL) THEN
    RAISE EXCEPTION 'Staging declaration requires its active execution intent';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION factory.protect_substrate_isolated() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE raw bytea; initial_owner uuid;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Native isolated provisioning names cannot be reused'; END IF;
  IF TG_OP='INSERT' THEN
    raw:=digest(NEW.owner_id::text||':'||NEW.generation::text,'sha256');
    raw:=set_byte(raw,6,(get_byte(raw,6)&15)|80);
    raw:=set_byte(raw,8,(get_byte(raw,8)&63)|128);
    IF NEW.runtime_attempt_id<>encode(substring(raw from 1 for 16),'hex')::uuid
      OR (NEW.intent#>>'{configuration,projectID}') IS DISTINCT FROM NEW.project_id::text
      OR (NEW.intent#>>'{configuration,database}') IS DISTINCT FROM current_database()
      OR NOT EXISTS(SELECT 1 FROM factory.project project WHERE project.id=NEW.project_id
        AND project.repository_url=NEW.intent->>'repository'
        AND project.devcontainer_path=NEW.intent->>'devcontainerPath')
      OR NOT EXISTS(SELECT 1 FROM auth."user" principal WHERE principal.id::text=NEW.intent->>'createdBy'
        AND (EXISTS(SELECT 1 FROM factory.project_membership member WHERE member.user_id=principal.id AND member.project_id=NEW.project_id)
          OR EXISTS(SELECT 1 FROM factory.administrator administrator WHERE administrator.user_id=principal.id)))
      OR EXISTS(SELECT 1 FROM factory.runtime_attempt WHERE id=NEW.runtime_attempt_id)
      THEN RAISE EXCEPTION 'Native isolated provisioning requires deterministic fresh product intent'; END IF;
    IF NEW.kind='publication' THEN
      IF NEW.intent->>'promotionID' IS NOT NULL OR NOT EXISTS(
        SELECT 1 FROM factory.release_attempt publication JOIN factory.project_release release ON release.id=publication.release_id
        WHERE publication.id=NEW.owner_id AND release.project_id=NEW.project_id
          AND release.created_by::text=NEW.intent->>'createdBy' AND release.commit_sha=NEW.intent->>'revision'
          AND release.version=NEW.intent->>'version' AND publication.job_handle=NEW.intent->>'jobHandle'
          AND publication.runner_uuid=NEW.intent->>'runnerUUID' AND publication.runner_token IS NOT NULL
          AND publication.run_id IS NOT NULL AND publication.dispatch_intended_at IS NOT NULL
          AND publication.runtime_attempt_id IS NULL AND publication.state='running' AND release.state='running'
          AND publication.id=(SELECT id FROM factory.release_attempt WHERE release_id=release.id ORDER BY ordinal DESC LIMIT 1))
        OR (NEW.intent#>>'{environment,environment}') IS DISTINCT FROM 'development'
        OR (NEW.intent#>>'{environment,version}') IS DISTINCT FROM '0' OR NEW.intent#>>'{environment,secretKey}' IS NOT NULL
        THEN RAISE EXCEPTION 'Native publication requires its exact active job and empty Project environment'; END IF;
    ELSIF NEW.intent->>'promotionID' IS NOT NULL THEN
      IF NEW.owner_id::text<>NEW.intent->>'promotionID' OR NOT EXISTS(
        SELECT 1 FROM factory.promotion_operation promotion JOIN factory.change change ON change.id=promotion.change_id
        JOIN factory.ticket ticket ON ticket.id=change.ticket_id
        JOIN factory.merge_operation merge ON merge.change_id=change.id AND merge.state='succeeded'
          AND merge.commit_sha=promotion.commit_sha AND merge.observed_default_sha=merge.commit_sha
        JOIN factory.delivery_approval approval ON approval.id=merge.delivery_approval_id
          AND approval.change_id=change.id AND approval.commit_sha=merge.commit_sha
        JOIN factory.verification verification ON verification.id=approval.verification_id
          AND verification.change_id=change.id AND verification.commit_sha=merge.commit_sha AND verification.state='succeeded'
        JOIN factory.candidate_review review ON review.id=approval.candidate_review_id AND review.verification_id=verification.id
          AND review.change_id=change.id AND review.commit_sha=merge.commit_sha AND review.state='passed'
        WHERE promotion.id=NEW.owner_id AND promotion.project_id=NEW.project_id AND change.project_id=NEW.project_id
          AND promotion.commit_sha=NEW.intent->>'revision' AND promotion.state='pending'
          AND promotion.replacement_runtime_attempt_id IS NULL AND change.state='delivering'
          AND change.cancel_requested_at IS NULL AND ticket.trashed_at IS NULL
          AND EXISTS(SELECT 1 FROM factory.current_promotion WHERE id=promotion.id))
        THEN RAISE EXCEPTION 'Native Staging replacement requires its approved exact-commit promotion'; END IF;
    ELSE
      raw:=digest('staging:'||NEW.project_id::text||':1','sha256');
      raw:=set_byte(raw,6,(get_byte(raw,6)&15)|80);
      raw:=set_byte(raw,8,(get_byte(raw,8)&63)|128);
      initial_owner:=encode(substring(raw from 1 for 16),'hex')::uuid;
      IF NEW.owner_id<>initial_owner OR NOT EXISTS(
        SELECT 1 FROM factory.staging_preview preview WHERE preview.project_id=NEW.project_id
          AND preview.revision=NEW.intent->>'revision' AND (preview.runtime_attempt_id IS NULL
            OR EXISTS(SELECT 1 FROM factory.runtime_attempt predecessor JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=predecessor.id
              WHERE predecessor.id=preview.runtime_attempt_id
                AND predecessor.state='stopped' AND binding.deleted_at IS NOT NULL)))
        OR (NEW.generation>1 AND NOT EXISTS(
          SELECT 1 FROM factory.substrate_isolated previous JOIN factory.runtime_attempt predecessor ON predecessor.id=previous.runtime_attempt_id
          JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=predecessor.id
          WHERE previous.owner_id=NEW.owner_id AND previous.kind=NEW.kind AND previous.generation=NEW.generation-1
            AND predecessor.state='stopped' AND binding.deleted_at IS NOT NULL))
        THEN RAISE EXCEPTION 'Native initial Staging requires its pinned Preview and confirmed predecessor cleanup'; END IF;
    END IF;
    IF NEW.kind='staging' AND ((NEW.intent#>>'{environment,environment}') IS DISTINCT FROM 'main-preview'
      OR NOT EXISTS(SELECT 1 FROM factory.project project
        LEFT JOIN factory.project_environment environment ON environment.project_id=project.id AND environment.environment='main-preview'
        WHERE project.id=NEW.project_id AND NEW.intent#>>'{environment,version}'=COALESCE(environment.version,0)::text
          AND (NEW.intent#>>'{environment,secretKey}') IS NOT DISTINCT FROM environment.secret_key))
      THEN RAISE EXCEPTION 'Native Staging requires its frozen main-preview environment'; END IF;
  ELSIF ROW(NEW.owner_id,NEW.kind,NEW.project_id,NEW.generation,NEW.runtime_attempt_id,NEW.intent)
      IS DISTINCT FROM ROW(OLD.owner_id,OLD.kind,OLD.project_id,OLD.generation,OLD.runtime_attempt_id,OLD.intent)
    OR (OLD.atespace_attempted_at IS NOT NULL AND NEW.atespace_attempted_at IS DISTINCT FROM OLD.atespace_attempted_at)
    OR (OLD.policy_attempted_at IS NOT NULL AND NEW.policy_attempted_at IS DISTINCT FROM OLD.policy_attempted_at)
    OR (OLD.template_attempted_at IS NOT NULL AND NEW.template_attempted_at IS DISTINCT FROM OLD.template_attempted_at)
    OR (OLD.atespace IS NOT NULL AND NEW.atespace IS DISTINCT FROM OLD.atespace)
    OR (OLD.policy IS NOT NULL AND NEW.policy IS DISTINCT FROM OLD.policy)
    OR (OLD.template IS NOT NULL AND NEW.template IS DISTINCT FROM OLD.template)
    OR (OLD.atespace_rejected AND NOT NEW.atespace_rejected)
    OR (OLD.policy_rejected AND NOT NEW.policy_rejected)
    OR (OLD.template_rejected AND NOT NEW.template_rejected)
    THEN RAISE EXCEPTION 'Native isolated intent, identities and dispatch facts are immutable'; END IF;
  RETURN NEW;
END $$;
