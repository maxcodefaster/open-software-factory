-- Common routines. Run before Drizzle tables, with check_function_bodies disabled.

CREATE FUNCTION factory.deterministic_uuid(seed text) RETURNS uuid
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT encode(
    set_byte(
      set_byte(raw, 6, (get_byte(raw, 6) & 15) | 80),
      8,
      (get_byte(raw, 8) & 63) | 128
    ),
    'hex'
  )::uuid
  FROM (SELECT substring(factory.digest(seed, 'sha256') FROM 1 FOR 16) AS raw) d;
$$;

CREATE FUNCTION factory.guard_immutable_columns() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  mutable_cols text[] := CASE WHEN TG_NARGS > 2 THEN TG_ARGV[2 : TG_NARGS - 1] ELSE ARRAY[]::text[] END;
  locked boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF TG_ARGV[1] = 'no-delete' THEN
      RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_ARGV[1] LIKE 'lock-on:%' THEN
    EXECUTE format('SELECT ($1).%I IS NOT NULL', substr(TG_ARGV[1], 9)) INTO locked USING OLD;
    IF locked THEN
      RAISE EXCEPTION '%', TG_ARGV[0] USING ERRCODE = '23514';
    END IF;
  END IF;
  IF (to_jsonb(NEW) - mutable_cols) IS DISTINCT FROM (to_jsonb(OLD) - mutable_cols) THEN
    RAISE EXCEPTION '%', TG_ARGV[0] USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.guard_operation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  op_kind text := CASE WHEN TG_OP = 'INSERT' THEN NEW.kind ELSE OLD.kind END;
  paused boolean;
  review factory.candidate_review;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.kind IN ('project.setup_inspection', 'knowledge.generation') THEN
    SELECT (state = 'enabled') INTO paused FROM factory.operation
      WHERE kind = 'installation.maintenance' AND idempotency_key = 'installation.maintenance:singleton'
      FOR SHARE;
    IF paused THEN
      RAISE EXCEPTION 'Factory is in maintenance; new work was not admitted'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  CASE op_kind
    WHEN 'attachment.storage', 'attachment.turn_context', 'coding.turn_mcp', 'runtime.environment_intent' THEN
      IF TG_OP IN ('UPDATE', 'DELETE') THEN
        RAISE EXCEPTION '% is immutable', TG_TABLE_NAME;
      END IF;

    WHEN 'learning.source_artifact' THEN
      IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION '% is immutable', TG_TABLE_NAME;
      END IF;

    WHEN 'project.setup_inspection' THEN
      IF TG_OP = 'UPDATE' THEN
        IF (NEW.id,NEW.scope_id,NEW.created_by,NEW.created_at,
            NEW.payload-'output'-'failure')
          IS DISTINCT FROM (OLD.id,OLD.scope_id,OLD.created_by,OLD.created_at,
            OLD.payload-'output'-'failure')
          OR (OLD.payload->'output' IS NOT NULL AND OLD.payload->'output' <> 'null'::jsonb
            AND NEW.payload->'output' IS DISTINCT FROM OLD.payload->'output')
          OR (OLD.state IN ('confirmed','complete') AND NEW.state<>OLD.state)
        THEN RAISE EXCEPTION 'Setup inspection intent and published proposal are immutable'; END IF;
      END IF;

    WHEN 'tickets.implementation_order' THEN
      IF TG_OP = 'UPDATE' THEN
        IF ROW(NEW.id,NEW.scope_type,NEW.scope_id,NEW.created_by,NEW.created_at,
            NEW.payload->>'commandId',NEW.payload->>'projectId',NEW.payload->>'ticketId',
            NEW.payload->>'createdBy',NEW.payload->>'requirementRevisionId',
            NEW.payload->>'technicalDesignRevisionId',NEW.payload->>'codingReasoning',
            NEW.payload->>'sourceSha')
          IS DISTINCT FROM ROW(OLD.id,OLD.scope_type,OLD.scope_id,OLD.created_by,OLD.created_at,
            OLD.payload->>'commandId',OLD.payload->>'projectId',OLD.payload->>'ticketId',
            OLD.payload->>'createdBy',OLD.payload->>'requirementRevisionId',
            OLD.payload->>'technicalDesignRevisionId',OLD.payload->>'codingReasoning',
            OLD.payload->>'sourceSha')
          OR (OLD.state<>'waiting' AND NEW IS DISTINCT FROM OLD) THEN
          RAISE EXCEPTION 'Commissioned implementation scope is immutable';
        END IF;
      END IF;

    WHEN 'learning.trial' THEN
      IF TG_OP = 'UPDATE' THEN
        IF (to_jsonb(NEW)-ARRAY['state','result','error','lease_expires_at','updated_at','completed_at','payload'])
          IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','result','error','lease_expires_at','updated_at','completed_at','payload'])
          OR ((NEW.payload)-ARRAY['result','reason','steps'])
          IS DISTINCT FROM ((OLD.payload)-ARRAY['result','reason','steps'])
          OR (OLD.state<>'running' AND NEW IS DISTINCT FROM OLD)
        THEN RAISE EXCEPTION 'Learning admission and settled evidence are immutable'; END IF;
      END IF;

    WHEN 'workspace.submission' THEN
      IF TG_OP = 'INSERT' THEN
        IF NOT EXISTS(
          SELECT 1 FROM factory.change_commit_operation operation
          JOIN factory.runtime_attempt attempt ON attempt.id=operation.runtime_attempt_id
          JOIN factory.development_workspace workspace ON workspace.id=attempt.workspace_id
          JOIN factory.change_writer writer ON writer.change_id=operation.change_id
          WHERE operation.id=NEW.id AND operation.source='workspace' AND operation.state='commit-intended'
            AND operation.created_by=(NEW.payload->>'actorId')::uuid AND workspace.id=(NEW.scope_id)::uuid
            AND workspace.kind='ticket' AND workspace.change_id=operation.change_id
            AND writer.state='unassigned' AND writer.epoch=(NEW.payload->>'writerEpoch')::bigint
            AND attempt.state='ready' AND attempt.stop_intended_at IS NULL
            AND attempt.atespace IS NOT NULL AND attempt.delete_intended_at IS NULL AND attempt.deleted_at IS NULL)
          THEN RAISE EXCEPTION 'Workspace submission requires its matching ready native commit intent'; END IF;
      ELSIF TG_OP = 'UPDATE' THEN
        IF ROW(NEW.id,NEW.scope_id,NEW.payload->>'actorId',NEW.payload->>'writerEpoch',
            NEW.payload->>'remoteHead',NEW.payload->>'repositoryUrl',NEW.created_at)
          IS DISTINCT FROM ROW(OLD.id,OLD.scope_id,OLD.payload->>'actorId',OLD.payload->>'writerEpoch',
            OLD.payload->>'remoteHead',OLD.payload->>'repositoryUrl',OLD.created_at)
          OR (OLD.payload->>'prepareAttemptedAt' IS NOT NULL
            AND NEW.payload->>'prepareAttemptedAt' IS DISTINCT FROM OLD.payload->>'prepareAttemptedAt')
          THEN RAISE EXCEPTION 'Workspace submission identity and dispatch facts are immutable'; END IF;
      END IF;

    WHEN 'coding.session_archive' THEN
      IF TG_OP = 'INSERT' THEN
        IF NOT EXISTS (
          SELECT 1 FROM factory.agent_turn turn
          JOIN factory.change_agent_turn_intent intent ON intent.turn_id=turn.id
          JOIN factory.runtime_attempt attempt ON attempt.id=intent.runtime_attempt_id
            AND attempt.change_id=turn.change_id AND attempt.project_id=turn.project_id
          WHERE turn.id=(NEW.scope_id)::uuid AND turn.state='completed'
            AND intent.runtime_attempt_id=(NEW.payload->>'runtimeAttemptId')::uuid
            AND intent.session_id=NEW.payload->>'sessionId'
            AND intent.prompt_id=NEW.payload->>'promptId'
        ) THEN RAISE EXCEPTION 'Transcript archive requires its exact completed native turn'; END IF;
      ELSIF TG_OP = 'DELETE' OR OLD.state='saved'
        OR (NEW.scope_id,NEW.payload->>'runtimeAttemptId',NEW.payload->>'sessionId',
            NEW.payload->>'promptId',NEW.payload->'sourceRefs',NEW.created_at)
          IS DISTINCT FROM (OLD.scope_id,OLD.payload->>'runtimeAttemptId',OLD.payload->>'sessionId',
            OLD.payload->>'promptId',OLD.payload->'sourceRefs',OLD.created_at)
      THEN RAISE EXCEPTION 'Native transcript checkpoint identity is immutable'; END IF;

    WHEN 'coding.turn_skill' THEN
      IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM factory.agent_turn WHERE id = (OLD.scope_id)::uuid) THEN
        RETURN OLD;
      END IF;
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'Loaded Skill identities are immutable';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM factory.agent_turn WHERE id = (NEW.scope_id)::uuid
        AND state IN ('dispatching', 'running') AND authority->'skillRevisionIds' ? (NEW.payload->>'revisionId')) THEN
        RAISE EXCEPTION 'Loaded Skill revision was not admitted';
      END IF;

    WHEN 'workspace.developer_ide' THEN
      IF TG_OP = 'UPDATE' THEN
        IF NEW.scope_id IS DISTINCT FROM OLD.scope_id
          OR (NEW.payload->>'resourceId') IS DISTINCT FROM (OLD.payload->>'resourceId')
          OR (NEW.payload->>'serviceEpoch')::bigint < (OLD.payload->>'serviceEpoch')::bigint THEN
          RAISE EXCEPTION 'Developer IDE identity is immutable' USING ERRCODE = '23514';
        END IF;
        IF (NEW.payload->>'serviceEpoch')::bigint = (OLD.payload->>'serviceEpoch')::bigint AND (
          (NEW.payload->>'image') IS DISTINCT FROM (OLD.payload->>'image') OR
          ((OLD.payload->>'namespaceUid') IS NOT NULL AND (NEW.payload->>'namespaceUid') IS DISTINCT FROM (OLD.payload->>'namespaceUid')) OR
          ((OLD.payload->>'podUid') IS NOT NULL AND (NEW.payload->>'podUid') IS DISTINCT FROM (OLD.payload->>'podUid'))
        ) THEN RAISE EXCEPTION 'Developer IDE intent outcome is immutable' USING ERRCODE = '23514'; END IF;
        IF (NEW.payload->>'serviceEpoch')::bigint <> (OLD.payload->>'serviceEpoch')::bigint AND (
          (NEW.payload->>'serviceEpoch')::bigint <> (OLD.payload->>'serviceEpoch')::bigint + 1
          OR OLD.state <> 'stopped' OR NEW.state <> 'create-intended' OR
          (NEW.payload->>'podUid') IS NOT NULL OR (NEW.payload->>'namespaceUid') IS DISTINCT FROM (OLD.payload->>'namespaceUid')
        ) THEN RAISE EXCEPTION 'Stop the Developer IDE before issuing a new epoch' USING ERRCODE = '23514'; END IF;
      END IF;

    WHEN 'releases.attempt' THEN
      IF TG_OP = 'UPDATE' THEN
        IF (NEW.id,NEW.scope_id,NEW.payload->>'commandId',NEW.payload->>'ordinal',NEW.created_at)
          IS DISTINCT FROM (OLD.id,OLD.scope_id,OLD.payload->>'commandId',OLD.payload->>'ordinal',OLD.created_at)
          OR (OLD.payload->>'dispatchIntendedAt' IS NOT NULL AND NEW.payload->>'dispatchIntendedAt' IS DISTINCT FROM OLD.payload->>'dispatchIntendedAt')
          OR (OLD.payload->>'runId' IS NOT NULL AND NEW.payload->>'runId' IS DISTINCT FROM OLD.payload->>'runId')
          OR (OLD.payload->>'jobHandle' IS NOT NULL AND NEW.payload->>'jobHandle' IS DISTINCT FROM OLD.payload->>'jobHandle')
          OR (OLD.payload->>'runtimeAttemptId' IS NOT NULL AND NEW.payload->>'runtimeAttemptId' IS DISTINCT FROM OLD.payload->>'runtimeAttemptId')
          OR (OLD.payload->>'runnerId' IS NOT NULL AND (NEW.payload->>'runnerId',NEW.payload->>'runnerUuid') IS DISTINCT FROM (OLD.payload->>'runnerId',OLD.payload->>'runnerUuid')) THEN
          RAISE EXCEPTION 'Publication attempt identity is immutable' USING ERRCODE='23514';
        END IF;
      END IF;

    WHEN 'review.scenario' THEN
      IF TG_OP IN ('INSERT', 'UPDATE') THEN
        SELECT * INTO review FROM factory.candidate_review WHERE id=(NEW.scope_id)::uuid FOR UPDATE;
        IF review.result IS NOT NULL OR review.state NOT IN ('pending','running')
          OR (TG_OP='UPDATE' AND (
            OLD.payload->>'endedAt' IS NOT NULL OR
            ROW(NEW.scope_id,NEW.payload->>'id',NEW.payload->>'title',NEW.payload->>'category',
                NEW.payload->>'criterion',NEW.payload->>'expected',NEW.payload->>'startedAt',
                NEW.payload->>'observationKind')
            IS DISTINCT FROM ROW(OLD.scope_id,OLD.payload->>'id',OLD.payload->>'title',OLD.payload->>'category',
                OLD.payload->>'criterion',OLD.payload->>'expected',OLD.payload->>'startedAt',
                OLD.payload->>'observationKind')))
        THEN RAISE EXCEPTION 'Review scenario intent and completed outcome are immutable'; END IF;
      END IF;

    ELSE
      NULL;
  END CASE;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE FUNCTION factory.reject_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME;
END;
$$;

CREATE FUNCTION factory.require_installation_admission() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE paused boolean;
BEGIN
  SELECT (state = 'enabled') INTO paused FROM factory.operation
    WHERE kind = 'installation.maintenance' AND idempotency_key = 'installation.maintenance:singleton'
    FOR SHARE;
  IF paused THEN
    RAISE EXCEPTION 'Factory is in maintenance; new work was not admitted'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.require_untrashed_ticket() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE target uuid; trashed timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'agent_turn' THEN target := NEW.ticket_id;
  ELSE SELECT ticket_id INTO target FROM factory.change WHERE id = NEW.change_id;
  END IF;
  IF target IS NOT NULL THEN
    SELECT trashed_at INTO trashed FROM factory.ticket WHERE id = target FOR SHARE;
    IF trashed IS NOT NULL THEN RAISE EXCEPTION 'Restore the Ticket before starting work' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
