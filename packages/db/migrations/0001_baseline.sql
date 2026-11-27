-- Generated from Drizzle models and owned native PostgreSQL protections. Do not edit.
BEGIN;
CREATE SCHEMA "auth";

CREATE SCHEMA "factory";

SET LOCAL search_path = factory, public;
CREATE TYPE "factory"."agent_turn_state" AS ENUM('pending', 'dispatching', 'running', 'completed', 'failed', 'stopped', 'uncertain');
CREATE TYPE "factory"."change_agent_state" AS ENUM('starting', 'working', 'waiting', 'stopped', 'failed', 'committed');
CREATE TYPE "factory"."change_commit_source" AS ENUM('agent', 'integration', 'workspace');
CREATE TYPE "factory"."change_commit_state" AS ENUM('commit-intended', 'committed', 'push-intended', 'succeeded', 'failed');
CREATE TYPE "factory"."change_state" AS ENUM('branch-pending', 'starting', 'active', 'cancelling', 'cancelled', 'failed', 'delivering', 'delivered');
CREATE TYPE "factory"."conversation_actor" AS ENUM('user', 'project-agent', 'change-agent', 'system');
CREATE TYPE "factory"."conversation_entry_kind" AS ENUM('user-message', 'agent-message', 'question', 'answer', 'requirement', 'mode-change');
CREATE TYPE "factory"."conversation_mode" AS ENUM('investigate', 'plan', 'build');
CREATE TYPE "factory"."isolated_runtime_kind" AS ENUM('staging', 'verification', 'publication');
CREATE TYPE "factory"."knowledge_page_state" AS ENUM('active', 'archived');
CREATE TYPE "factory"."knowledge_revision_kind" AS ENUM('generated', 'human', 'proposed');
CREATE TYPE "factory"."runtime_attempt_state" AS ENUM('create-intended', 'starting', 'ready', 'stop-intended', 'stopping', 'stopped', 'cleanup-failed', 'failed', 'pausing', 'paused', 'resuming');
CREATE TYPE "factory"."ticket_state" AS ENUM('inbox', 'backlog', 'ready', 'in-progress', 'cancelled', 'done');
CREATE TYPE "factory"."verification_state" AS ENUM('pending', 'runner-starting', 'running', 'succeeded', 'failed', 'cancelled');
CREATE TYPE "factory"."development_workspace_kind" AS ENUM('personal', 'ticket');
-- Native 00-extensions.sql.
-- Install after the Drizzle-owned auth and factory schemas, before types, routines and tables.
-- Compose functions before Drizzle tables/indexes/FKs, then native constraints/triggers/views/publication/seeds.
-- The composer owns BEGIN/COMMIT, search_path and the final schema_migration digest.

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA factory;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA factory;

-- Native 01-function-authoring.sql.
-- Pre-table routines retain forward references to table row types and SQL relations.
-- Run after schemas/extensions/enum types and before the *-functions.sql files.

SET check_function_bodies = false;

-- Native 10-common-functions.sql.
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

-- Native 11-access-functions.sql.
-- Access routines. Run before Drizzle tables, with check_function_bodies disabled.

CREATE FUNCTION factory.check_session_access() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE access factory.account_access;
BEGIN
  SELECT * INTO access FROM factory.account_access WHERE user_id=NEW.user_id FOR SHARE;
  IF NOT FOUND OR access.disabled_at IS NOT NULL OR access.directory_disabled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Account access is disabled' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION factory.enqueue_access_revocation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE targets uuid[]; notify_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'project' THEN
    SELECT ARRAY(
      SELECT user_id FROM factory.administrator
      UNION SELECT user_id FROM factory.project_membership WHERE project_id=NEW.id
    ) INTO targets;
    notify_id := NEW.id;
  ELSIF TG_TABLE_NAME = 'account_access' THEN
    IF NEW.disabled_at IS NOT DISTINCT FROM OLD.disabled_at AND
       NEW.directory_disabled_at IS NOT DISTINCT FROM OLD.directory_disabled_at THEN
      RETURN NEW;
    END IF;
    notify_id := NEW.user_id;
    targets := ARRAY[notify_id];
    IF NEW.disabled_at IS NOT NULL OR NEW.directory_disabled_at IS NOT NULL THEN
      DELETE FROM auth.session WHERE user_id=notify_id;
    END IF;
  ELSE
    IF TG_OP = 'UPDATE' AND NEW.role = OLD.role AND NEW.manage_project = OLD.manage_project THEN
      RETURN NEW;
    END IF;
    notify_id := COALESCE(NEW.user_id, OLD.user_id);
    targets := ARRAY[notify_id];
  END IF;
  INSERT INTO factory.operation(
    id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload,updated_at)
  SELECT gen_random_uuid(),'access.revocation','user',user_id::text,
    'access.revocation:'||user_id::text,NULL,'pending',
    jsonb_build_object('userId',user_id::text,'version',1,'processedVersion',0),now()
  FROM unnest(targets) AS user_id
  ON CONFLICT(idempotency_key) DO UPDATE SET
    state='pending',
    payload=jsonb_set(factory.operation.payload,'{version}',
      to_jsonb(((factory.operation.payload->>'version')::bigint+1))),
    completed_at=NULL,
    updated_at=now();
  PERFORM pg_notify('factory_access_revoked', notify_id::text);
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE FUNCTION factory.initialize_account_access() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO factory.account_access(user_id) VALUES (NEW.id);
  RETURN NEW;
END $$;

-- Native 12-attachments-functions.sql.
-- Attachments routines. Run before Drizzle tables, with check_function_bodies disabled.

CREATE FUNCTION factory.bind_attachment_references(project uuid, actor uuid, reference_kind text, target uuid, content text, is_shared boolean) RETURNS void
    LANGUAGE plpgsql
    AS $_$
DECLARE matched text[]; asset factory.attachment; authored text;
BEGIN
  authored := regexp_replace(COALESCE(content,''),'```.*?```|~~~.*?~~~','','gs');
  authored := regexp_replace(authored,'`[^`]*`','','g');
  FOR matched IN SELECT regexp_matches(authored,$ref$/api/attachments/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?=[/)\s"'\\]|$)$ref$,'gi') LOOP
    SELECT * INTO asset FROM factory.attachment WHERE id=matched[1]::uuid FOR SHARE;
    IF NOT FOUND OR asset.project_id<>project OR asset.state<>'ready' OR
      (asset.owner_id IS DISTINCT FROM actor AND NOT EXISTS(
        SELECT 1 FROM factory.attachment_reference r WHERE r.attachment_id=asset.id AND r.shared
      )) THEN
      RAISE EXCEPTION 'Attachment is unavailable in this document context' USING ERRCODE='23514';
    END IF;
    INSERT INTO factory.attachment_reference(attachment_id,kind,reference_id,shared)
      VALUES(asset.id,reference_kind,target,is_shared) ON CONFLICT DO NOTHING;
  END LOOP;
END $_$;

CREATE FUNCTION factory.bind_authored_attachments() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE project uuid; actor uuid; target uuid; reference_kind text; content text; shared boolean := true;
BEGIN
  actor := (to_jsonb(NEW)->>'created_by')::uuid;
  IF TG_TABLE_NAME='knowledge_revision' THEN
    SELECT project_id INTO project FROM factory.knowledge_page WHERE id=NEW.page_id;
    reference_kind := 'knowledge'; target := NEW.id; content := NEW.body;
  ELSIF TG_TABLE_NAME='ticket_document_revision' THEN
    SELECT project_id INTO project FROM factory.ticket WHERE id=NEW.ticket_id;
    reference_kind := 'ticket'; target := NEW.id;
    content := NEW.description || COALESCE(NEW.canonical_content,'');
  ELSIF TG_TABLE_NAME='requirement_revision' THEN
    SELECT project_id INTO project FROM factory.ticket WHERE id=NEW.ticket_id;
    reference_kind := 'requirement'; target := NEW.id; content := NEW.canonical_content;
  ELSIF TG_TABLE_NAME='ticket' THEN
    project := NEW.project_id; reference_kind := 'ticket'; target := NEW.id; content := NEW.description;
  ELSIF TG_TABLE_NAME='conversation_entry' THEN
    SELECT project_id,(ticket_id IS NOT NULL) INTO project,shared
      FROM factory.ticket_conversation WHERE id=NEW.conversation_id;
    IF actor IS NULL THEN
      SELECT created_by INTO actor FROM factory.ticket_conversation WHERE id=NEW.conversation_id;
    END IF;
    reference_kind := 'conversation'; target := NEW.conversation_id; content := NEW.body;
  ELSE
    SELECT c.project_id INTO project FROM factory.review_feedback f
      JOIN factory.change c ON c.id=f.change_id WHERE f.id=(NEW.scope_id)::uuid;
    actor := NEW.actor_id; reference_kind := 'feedback'; target := NEW.id; content := NEW.payload->>'body';
  END IF;
  PERFORM factory.bind_attachment_references(project,actor,reference_kind,target,content,shared);
  IF TG_TABLE_NAME='ticket' THEN
    DELETE FROM factory.operation WHERE kind='attachments.draft' AND scope_type='attachment'
      AND idempotency_key='attachments.draft:' || NEW.id::text || ':' || NEW.created_by::text
      AND payload->>'projectId'=NEW.project_id::text;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION factory.protect_attachment_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.id,NEW.project_id,NEW.owner_id,NEW.draft_id,NEW.name,NEW.media_type,NEW.sha256,NEW.byte_length)
    IS DISTINCT FROM ROW(OLD.id,OLD.project_id,OLD.owner_id,OLD.draft_id,OLD.name,OLD.media_type,OLD.sha256,OLD.byte_length)
    OR (OLD.completed_at IS NOT NULL AND ROW(NEW.objects,NEW.text_content,NEW.reserved_bytes,NEW.completed_at)
      IS DISTINCT FROM ROW(OLD.objects,OLD.text_content,OLD.reserved_bytes,OLD.completed_at)) THEN
    RAISE EXCEPTION 'Attachment content and ownership are immutable';
  END IF;
  RETURN NEW;
END $$;

-- Native 13-planning-functions.sql.
-- Planning routines. Run before Drizzle tables, with check_function_bodies disabled.

CREATE FUNCTION factory.guard_tree_hierarchy() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  has_cycle boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.project_id <> OLD.project_id) THEN
    RAISE EXCEPTION '% identity and Project are immutable', TG_ARGV[0] USING ERRCODE = '23514';
  END IF;
  PERFORM id FROM factory.project WHERE id = NEW.project_id FOR UPDATE;
  IF TG_TABLE_NAME = 'epic' THEN
    SELECT EXISTS (
      WITH RECURSIVE ancestors AS (
        SELECT id, parent_id FROM factory.epic WHERE id = NEW.parent_id AND project_id = NEW.project_id
        UNION
        SELECT parent.id, parent.parent_id FROM factory.epic parent
        JOIN ancestors child ON parent.id = child.parent_id WHERE parent.project_id = NEW.project_id
      )
      -- During a multi-row INSERT the closing Epic might not exist yet.
      SELECT 1 FROM ancestors WHERE id = NEW.id OR parent_id = NEW.id
    ) INTO has_cycle;
  ELSE
    SELECT EXISTS (
      WITH RECURSIVE ancestors AS (
        SELECT id, parent_id FROM factory.knowledge_page WHERE id = NEW.parent_id AND project_id = NEW.project_id
        UNION
        SELECT parent.id, parent.parent_id FROM factory.knowledge_page parent
        JOIN ancestors child ON parent.id = child.parent_id WHERE parent.project_id = NEW.project_id
      )
      SELECT 1 FROM ancestors WHERE id = NEW.id OR parent_id = NEW.id
    ) INTO has_cycle;
  END IF;
  IF has_cycle THEN
    RAISE EXCEPTION '% cannot contain a cycle', TG_ARGV[1] USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.guard_ticket_dependency() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Remove and add a dependency explicitly; its identity is immutable' USING ERRCODE = '23514';
  END IF;
  -- A graph lock avoids locking the Project row, which Change creation references after its Ticket lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('ticket-dependencies:' || NEW.project_id::text, 0));
  PERFORM id FROM factory.ticket WHERE id = NEW.ticket_id AND project_id = NEW.project_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM factory.change WHERE ticket_id = NEW.ticket_id) THEN
    RAISE EXCEPTION 'Implementation has already been admitted. Create a new Ticket for new prerequisites.' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    WITH RECURSIVE prerequisites AS (
      SELECT prerequisite_id FROM factory.ticket_dependency
        WHERE ticket_id = NEW.prerequisite_id AND project_id = NEW.project_id
      UNION
      SELECT edge.prerequisite_id FROM factory.ticket_dependency edge
        JOIN prerequisites previous ON edge.ticket_id = previous.prerequisite_id
        WHERE edge.project_id = NEW.project_id
    )
    SELECT 1 FROM prerequisites WHERE prerequisite_id = NEW.ticket_id
  ) THEN
    RAISE EXCEPTION 'Ticket dependencies cannot contain a cycle' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.research_vector(title text, body text) RETURNS tsvector
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
    SELECT setweight(to_tsvector('simple',coalesce(title,'')),'A') ||
      setweight(to_tsvector('simple',coalesce(body,'')),'B');
  $$;

CREATE FUNCTION factory.ticket_prerequisites(project uuid, dependent uuid) RETURNS TABLE(prerequisite_id uuid, title text, state factory.ticket_state, delivered boolean)
    LANGUAGE sql STABLE
    AS $$
  SELECT prerequisite.id, prerequisite.title, prerequisite.state,
    prerequisite.state = 'done' AND EXISTS (
      SELECT 1 FROM factory.change change
      JOIN factory.operation merge ON merge.kind = 'delivery.merge'
        AND merge.scope_type = 'change' AND merge.scope_id = change.id::text
        AND merge.state = 'succeeded'
        AND merge.result->>'mergeSha' = merge.payload->>'commitSha'
      JOIN factory.delivery_approval approval ON approval.id::text = merge.payload->>'approvalId'
        AND approval.change_id = change.id AND approval.commit_sha = merge.payload->>'commitSha'
      JOIN factory.verification verification ON verification.id = approval.verification_id
        AND verification.change_id = change.id AND verification.commit_sha = merge.payload->>'commitSha'
        AND verification.state = 'succeeded'
      JOIN factory.operation promotion ON promotion.kind = 'delivery.promotion'
        AND promotion.scope_type = 'change' AND promotion.scope_id = change.id::text
        AND promotion.payload->>'projectId' = edge.project_id::text
        AND promotion.payload->>'commitSha' = merge.payload->>'commitSha'
        AND promotion.state = 'succeeded'
      WHERE change.ticket_id = prerequisite.id AND change.project_id = edge.project_id
        AND change.state = 'delivered'
    ) AS delivered
  FROM factory.ticket_dependency edge
  JOIN factory.ticket prerequisite ON prerequisite.id = edge.prerequisite_id AND prerequisite.project_id = edge.project_id
  WHERE edge.project_id = project AND edge.ticket_id = dependent
  ORDER BY prerequisite.title, prerequisite.id
$$;

-- Native 14-conversation-functions.sql.
-- Conversation routines. Run before Drizzle tables, with check_function_bodies disabled.

CREATE FUNCTION factory.prevent_conversation_entry_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM factory.ticket_conversation WHERE id = OLD.conversation_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Conversation Entries are immutable';
END;
$$;

-- Native 15-coding-functions.sql.
-- Coding routines. Run before Drizzle tables, with check_function_bodies disabled.

CREATE FUNCTION factory.guard_agent_turn() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.command_id, NEW.project_id, NEW.ticket_id, NEW.conversation_id,
      NEW.change_id, NEW.created_by, NEW.input, NEW.input_digest, NEW.authority, NEW.created_at)
      IS DISTINCT FROM
      ROW(OLD.id, OLD.command_id, OLD.project_id, OLD.ticket_id, OLD.conversation_id,
      OLD.change_id, OLD.created_by, OLD.input, OLD.input_digest, OLD.authority, OLD.created_at)
    THEN
      RAISE EXCEPTION 'Agent Turn admission is immutable';
    END IF;
    IF OLD.state IN ('completed', 'failed', 'stopped') AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Terminal Agent Turn is immutable';
    END IF;
    IF NEW.state <> OLD.state AND NOT (
      (OLD.state = 'pending' AND NEW.state IN ('dispatching', 'failed', 'stopped')) OR
      (OLD.state = 'dispatching' AND NEW.state IN ('running', 'completed', 'failed', 'stopped', 'uncertain')) OR
      (OLD.state = 'running' AND NEW.state IN ('completed', 'failed', 'stopped', 'uncertain')) OR
      (OLD.state = 'uncertain' AND NEW.state IN ('running', 'failed', 'stopped'))
    ) THEN
      RAISE EXCEPTION 'Invalid Agent Turn transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.ticket_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM factory.ticket WHERE id = NEW.ticket_id AND project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'Agent Turn Ticket scope mismatch';
  END IF;
  IF NEW.conversation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM factory.ticket_conversation WHERE id = NEW.conversation_id
      AND project_id = NEW.project_id AND ticket_id IS NOT DISTINCT FROM NEW.ticket_id
      AND (ticket_id IS NOT NULL OR created_by = NEW.created_by)
  ) THEN
    RAISE EXCEPTION 'Agent Turn Conversation scope mismatch';
  END IF;
  IF NEW.change_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM factory.change change
    JOIN factory.requirement_approval approval ON approval.id = change.requirement_approval_id
    WHERE change.id = NEW.change_id AND change.ticket_id = NEW.ticket_id
      AND approval.requirement_revision_id::text = NEW.authority->>'requirementRevisionId'
  ) THEN
    RAISE EXCEPTION 'Agent Turn Change scope mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.guard_build_browser_session() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.ordinal IS DISTINCT FROM OLD.ordinal THEN
      RAISE EXCEPTION 'Build browser ordinal is immutable';
    END IF;
    IF NEW.reopen_allowed IS DISTINCT FROM OLD.reopen_allowed AND NOT (
      OLD.state IN ('intended','active') AND NEW.state = 'closing'
    ) THEN
      RAISE EXCEPTION 'Build browser recovery admission is immutable';
    END IF;
    IF ROW(NEW.id, NEW.turn_id, NEW.change_id, NEW.runtime_attempt_id, NEW.generation,
      NEW.agent_session_id, NEW.owner_id, NEW.create_intended_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.turn_id, OLD.change_id, OLD.runtime_attempt_id, OLD.generation,
      OLD.agent_session_id, OLD.owner_id, OLD.create_intended_at) THEN
      RAISE EXCEPTION 'Build browser create intent is immutable';
    END IF;
    IF OLD.state = 'closed' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Confirmed Build browser cleanup is immutable';
    END IF;
    IF NEW.state <> OLD.state AND NOT (
      (OLD.state = 'intended' AND NEW.state IN ('active', 'closing')) OR
      (OLD.state = 'active' AND NEW.state = 'closing') OR
      (OLD.state = 'closing' AND NEW.state = 'closed')
    ) THEN
      RAISE EXCEPTION 'Invalid Build browser session transition';
    END IF;
    IF (OLD.create_confirmed_at IS NOT NULL AND NEW.create_confirmed_at IS DISTINCT FROM OLD.create_confirmed_at)
      OR (OLD.cleanup_intended_at IS NOT NULL AND NEW.cleanup_intended_at IS DISTINCT FROM OLD.cleanup_intended_at) THEN
      RAISE EXCEPTION 'Build browser external outcome is immutable';
    END IF;
    IF NEW.state = 'closed' AND EXISTS (
      SELECT 1 FROM factory.operation native WHERE native.id=NEW.id AND native.kind='runtime.browser'
        AND ((native.payload->>'actorDeletedAt') IS NULL OR (native.payload->>'templateDeletedAt') IS NULL)
    ) THEN
      RAISE EXCEPTION 'Native Browser cleanup remains unconfirmed';
    END IF;
  ELSE
    IF NEW.reopen_allowed THEN
      RAISE EXCEPTION 'Browser recovery requires a confirmed Connector failure';
    END IF;
    IF NEW.ordinal > 1 AND NOT EXISTS (
      SELECT 1 FROM factory.build_browser_session previous
      WHERE previous.turn_id = NEW.turn_id AND previous.owner_id = NEW.owner_id
        AND previous.ordinal = NEW.ordinal - 1 AND previous.state = 'closed'
        AND previous.reopen_allowed
        AND previous.cleanup_confirmed_at IS NOT NULL
        AND previous.change_id = NEW.change_id
        AND previous.runtime_attempt_id = NEW.runtime_attempt_id
        AND previous.generation = NEW.generation
        AND previous.agent_session_id = NEW.agent_session_id
    ) THEN
      RAISE EXCEPTION 'Confirm previous browser cleanup before a new inspection';
    END IF;
    IF NEW.state <> 'intended' OR NEW.create_confirmed_at IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM factory.agent_turn turn
      JOIN factory.change_agent_turn_intent intent ON intent.turn_id = turn.id
      JOIN factory.change_agent_session session ON session.change_id = intent.change_id
      JOIN factory.change change ON change.id = intent.change_id
      JOIN factory.runtime_attempt attempt ON attempt.id = intent.runtime_attempt_id
      WHERE turn.id = NEW.turn_id AND turn.change_id = NEW.change_id AND turn.authority->>'mode' = 'build'
        AND turn.state IN ('dispatching', 'running') AND turn.owner_expires_at > clock_timestamp()
        AND encode(digest(turn.owner_token::text, 'sha256'), 'hex') = NEW.owner_id
        AND intent.change_id = NEW.change_id AND intent.runtime_attempt_id = NEW.runtime_attempt_id
        AND intent.session_id = NEW.agent_session_id AND attempt.generation = NEW.generation
        AND change.runtime_attempt_id = NEW.runtime_attempt_id AND attempt.state = 'ready'
        AND session.runtime_attempt_id = NEW.runtime_attempt_id AND session.active_turn_id = NEW.turn_id
        AND session.opencode_session_id = NEW.agent_session_id AND NOT session.stop_pending
        AND session.state IN ('starting', 'working')
    ) THEN
      RAISE EXCEPTION 'Build browser session does not own an admitted execution';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.guard_change_agent_turn_intent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.terminal_outcome IS NOT NULL OR NEW.model_request_epoch <> 0 THEN
      RAISE EXCEPTION 'Terminal checkpoint requires an existing admitted execution';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM factory.agent_turn WHERE id = NEW.turn_id
      AND change_id = NEW.change_id AND authority->>'mode' = 'build') THEN
      RAISE EXCEPTION 'Change Agent intent scope mismatch';
    END IF;
  ELSE
    IF ROW(NEW.turn_id, NEW.change_id, NEW.session_id, NEW.prompt_id, NEW.prompt_text,
      NEW.bootstrap, NEW.session_title, NEW.created_at,
      NEW.skill_manifest, NEW.skill_attachments) IS DISTINCT FROM
      ROW(OLD.turn_id, OLD.change_id, OLD.session_id, OLD.prompt_id, OLD.prompt_text,
      OLD.bootstrap, OLD.session_title, OLD.created_at,
      OLD.skill_manifest, OLD.skill_attachments)
      OR (OLD.runtime_attempt_id IS NOT NULL AND NEW.runtime_attempt_id IS DISTINCT FROM OLD.runtime_attempt_id) THEN
      RAISE EXCEPTION 'Change Agent dispatch intent is immutable';
    END IF;
    IF NEW.model_request_epoch < OLD.model_request_epoch
      OR NEW.model_request_epoch > OLD.model_request_epoch + 1
      OR (OLD.terminal_outcome IS NOT NULL AND
        ROW(NEW.terminal_outcome,NEW.model_request_epoch) IS DISTINCT FROM
        ROW(OLD.terminal_outcome,OLD.model_request_epoch)) THEN
      RAISE EXCEPTION 'Terminal checkpoint and closed inference epoch are immutable';
    END IF;
    IF NEW.terminal_outcome IS NOT NULL AND OLD.terminal_outcome IS NULL THEN
      IF NEW.model_request_epoch <> OLD.model_request_epoch OR NOT EXISTS(
        SELECT 1 FROM factory.agent_turn turn
        JOIN factory.change_agent_session session ON session.active_turn_id=turn.id
        JOIN factory.change change ON change.id=turn.change_id
        JOIN factory.change_writer writer ON writer.change_id=change.id
        JOIN factory.runtime_attempt attempt ON attempt.id=NEW.runtime_attempt_id
        WHERE turn.id=NEW.turn_id AND turn.change_id=NEW.change_id
          AND turn.state='running' AND turn.owner_token IS NOT NULL
          AND turn.owner_expires_at>clock_timestamp()
          AND session.change_id=NEW.change_id AND session.state='working'
          AND session.opencode_session_id=NEW.session_id AND session.active_inbox_id=NEW.prompt_id
          AND session.native_session_confirmed_at IS NOT NULL AND NOT session.stop_pending
          AND session.runtime_attempt_id=NEW.runtime_attempt_id
          AND change.runtime_attempt_id=NEW.runtime_attempt_id AND attempt.state='ready'
          AND writer.state='agent' AND writer.turn_id=turn.id AND NOT writer.fence_required
      ) THEN
        RAISE EXCEPTION 'Terminal checkpoint no longer owns its current running input';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.guard_change_prerequisites() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE blockers text;
BEGIN
  -- Shares the dependent Ticket lock with planning writes. Read prerequisites AFTER any wait.
  PERFORM id FROM factory.ticket WHERE id = NEW.ticket_id AND project_id = NEW.project_id FOR UPDATE;
  SELECT string_agg(title, ', ' ORDER BY title) INTO blockers
    FROM factory.ticket_prerequisites(NEW.project_id, NEW.ticket_id) WHERE NOT delivered;
  IF blockers IS NOT NULL THEN
    RAISE EXCEPTION 'Prerequisites must be delivered before implementation: %', blockers USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.initialize_change_writer() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO factory.change_writer(change_id) VALUES(NEW.id);
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.require_ticket_execution_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.change_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM factory.change WHERE id=NEW.change_id AND project_id=NEW.project_id
  ) AND NOT EXISTS (
    SELECT 1 FROM factory.change change
    WHERE change.id=NEW.change_id AND change.project_id=NEW.project_id
      AND NEW.revision=COALESCE(
        (SELECT commit_sha FROM factory.change_commit_operation
          WHERE change_id=change.id AND state='succeeded' ORDER BY sequence DESC LIMIT 1),
        change.base_sha)
  ) THEN
    RAISE EXCEPTION 'Ticket execution revision must match the latest submitted Change commit or its initial base'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

-- Native 16-inputs-functions.sql.
-- Inputs routines. Run before Drizzle tables, with check_function_bodies disabled.

CREATE FUNCTION factory.cascade_deleted_agent_turn_skills() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  DELETE FROM factory.operation
  WHERE kind = 'coding.turn_skill' AND scope_type = 'agent_turn' AND scope_id = OLD.id::text;
  RETURN OLD;
END;
$$;

CREATE FUNCTION factory.protect_model_connection_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Model connection versions are immutable' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM factory.operation WHERE kind='models.connection_write'
    AND scope_type='connection' AND scope_id=NEW.connection_id::text
    AND (payload->>'baseVersion')::bigint=NEW.version-1
    AND payload->>'provider'=NEW.provider AND payload->>'endpoint'=NEW.endpoint
    AND payload->>'secretKey'=NEW.secret_key AND created_by=NEW.created_by
    AND state='write-intended') THEN
    RAISE EXCEPTION 'Model connection requires its exact write intent' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Native 17-learning-functions.sql.
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

-- Native 18-usage-functions.sql.
-- Usage routines. Run before Drizzle tables, with check_function_bodies disabled.

CREATE FUNCTION factory.guard_usage_operation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (to_jsonb(NEW)-'settled_at'-'outcome') IS DISTINCT FROM (to_jsonb(OLD)-'settled_at'-'outcome')
    OR (OLD.settled_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Usage attribution and rate snapshots are immutable';
  END IF;
  RETURN NEW;
END;
$$;

-- Native 19-runtime-functions.sql.
-- Runtime routines. Run before Drizzle tables, with check_function_bodies disabled.

CREATE FUNCTION factory.protect_runtime_attempt_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.atespace IS NOT NULL THEN RAISE EXCEPTION 'Native names and bindings cannot be reused'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW.project_id,NEW.change_id,NEW.workspace_id,NEW.generation,NEW.revision,
        NEW.isolated_kind,NEW.verification_id,NEW.parent_connector_token_hash,
        NEW.create_intended_at,NEW.created_by,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.project_id,OLD.change_id,OLD.workspace_id,OLD.generation,OLD.revision,
        OLD.isolated_kind,OLD.verification_id,OLD.parent_connector_token_hash,
        OLD.create_intended_at,OLD.created_by,OLD.created_at)
      OR (OLD.declared_apps<>'[]'::jsonb AND NEW.declared_apps IS DISTINCT FROM OLD.declared_apps)
       THEN RAISE EXCEPTION 'Runtime Attempt identity and create intent are immutable'; END IF;
    IF (OLD.stop_intended_at IS NOT NULL AND NEW.stop_intended_at IS DISTINCT FROM OLD.stop_intended_at)
      OR (NEW.stop_intended_at IS NOT NULL AND NEW.state NOT IN ('stopping','stopped')) THEN
      RAISE EXCEPTION 'Final Stop intent cannot be cleared or reopen execution';
    END IF;
  END IF;
  IF (TG_OP='INSERT' AND NEW.atespace IS NOT NULL)
    OR (TG_OP='UPDATE' AND OLD.atespace IS NULL AND NEW.atespace IS NOT NULL) THEN
    IF NOT (NEW.state='create-intended' AND NEW.stop_intended_at IS NULL
      AND (EXISTS(SELECT 1 FROM factory.development_workspace w WHERE w.id=NEW.workspace_id)
        OR EXISTS(SELECT 1 FROM factory.substrate_provision p WHERE p.kind='verification'
          AND p.owner_id=NEW.verification_id
          AND p.runtime_attempt_id=NEW.id AND p.generation=NEW.generation AND NEW.isolated_kind='verification'
          AND NEW.workspace_id IS NULL AND NEW.change_id IS NULL
          AND jsonb_typeof(p.resources->'atespace'->'value')='object'
          AND jsonb_typeof(p.resources->'policy'->'value')='object'
          AND jsonb_typeof(p.resources->'template'->'value')='object'
          AND NEW.binding_intent->>'projectID'=NEW.project_id::text
          AND NEW.binding_intent->>'generation'=NEW.generation::text
          AND NEW.binding_intent->>'verificationID'=p.owner_id::text
          AND NEW.binding_intent->>'atespaceUID'=p.resources#>>'{atespace,value,metadata,uid}'
          AND NEW.binding_intent->>'templateUID'=p.resources#>>'{template,value,metadata,uid}'
          AND NEW.binding_intent->>'templateVersion'=p.resources#>>'{template,value,metadata,version}'
          AND NEW.binding_intent->>'templateSHA256'=p.intent->>'templateSHA256')
        OR EXISTS(SELECT 1 FROM factory.substrate_provision p
          WHERE p.kind IN ('staging','publication')
            AND p.runtime_attempt_id=NEW.id AND p.project_id=NEW.project_id AND p.generation=NEW.generation
            AND p.kind=NEW.isolated_kind::text AND NEW.workspace_id IS NULL AND NEW.change_id IS NULL AND NEW.verification_id IS NULL
            AND p.intent->>'revision'=NEW.revision AND p.intent->>'createdBy'=NEW.created_by::text
            AND jsonb_typeof(p.resources->'atespace'->'value')='object'
            AND jsonb_typeof(p.resources->'policy'->'value')='object'
            AND jsonb_typeof(p.resources->'template'->'value')='object'
            AND NOT COALESCE((p.resources#>>'{atespace,rejected}')::boolean,false)
            AND NOT COALESCE((p.resources#>>'{policy,rejected}')::boolean,false)
            AND NOT COALESCE((p.resources#>>'{template,rejected}')::boolean,false)
            AND NEW.binding_intent->>'projectID'=NEW.project_id::text AND NEW.binding_intent->>'generation'=NEW.generation::text
            AND NEW.binding_intent->>'isolatedID'=p.owner_id::text AND NEW.binding_intent->>'isolatedKind'=p.kind
            AND (NEW.binding_intent->>'promotionID') IS NOT DISTINCT FROM p.intent->>'promotionID'
            AND NEW.binding_intent->>'atespaceUID'=p.resources#>>'{atespace,value,metadata,uid}'
            AND NEW.binding_intent->>'templateUID'=p.resources#>>'{template,value,metadata,uid}'
            AND NEW.binding_intent->>'templateVersion'=p.resources#>>'{template,value,metadata,version}'
            AND NEW.binding_intent->>'templateSHA256'=p.intent->>'templateSHA256'
            AND NEW.binding_intent->'environment'=p.intent->'environment'))
      AND NEW.atespace='fa-'||replace(NEW.id::text,'-','')
      AND NEW.actor_name='runtime-'||replace(NEW.id::text,'-',''))
      THEN RAISE EXCEPTION 'Native binding requires deterministic active Attempt intent'; END IF;
  ELSIF TG_OP='UPDATE' AND OLD.atespace IS NOT NULL AND (
    ROW(NEW.atespace,NEW.actor_name,NEW.binding_intent)
      IS DISTINCT FROM ROW(OLD.atespace,OLD.actor_name,OLD.binding_intent)
    OR (OLD.actor_uid IS NOT NULL AND NEW.actor_uid IS DISTINCT FROM OLD.actor_uid)
    OR (OLD.create_attempted_at IS NOT NULL AND NEW.create_attempted_at IS DISTINCT FROM OLD.create_attempted_at)
    OR (OLD.create_rejected AND NOT NEW.create_rejected)
    OR (OLD.delete_intended_at IS NOT NULL AND NEW.delete_intended_at IS DISTINCT FROM OLD.delete_intended_at)
    OR (OLD.deleted_at IS NOT NULL AND ROW(NEW.atespace,NEW.actor_name,NEW.binding_intent,NEW.actor_uid,
        NEW.create_attempted_at,NEW.create_rejected,NEW.delete_intended_at,NEW.deleted_at,
        NEW.observation,NEW.checkpoint)
      IS DISTINCT FROM ROW(OLD.atespace,OLD.actor_name,OLD.binding_intent,OLD.actor_uid,
        OLD.create_attempted_at,OLD.create_rejected,OLD.delete_intended_at,OLD.deleted_at,
        OLD.observation,OLD.checkpoint)))
    THEN RAISE EXCEPTION 'Native binding identity and dispatch facts are immutable'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION factory.protect_substrate_source() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Source ownership and checkpoints cannot be discarded'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.writer_epoch<>1 OR NOT NEW.writable OR NEW.generation<>0 OR NEW.seed_confirmed_at IS NOT NULL
      THEN RAISE EXCEPTION 'Source requires an initial writable generation'; END IF;
    IF NEW.owner='service' THEN
      IF NEW.actor_uid IS NOT NULL OR NEW.seed IS NULL
        OR NEW.service_base::text IS DISTINCT FROM NEW.seed->>'id'
        OR NOT EXISTS(SELECT 1 FROM factory.development_workspace w JOIN factory.project p ON p.id=w.project_id
          WHERE w.id=NEW.workspace_id AND w.id::text=NEW.seed->>'workspaceID'
            AND w.project_id::text=NEW.seed->>'projectID'
            AND p.repository_url=NEW.seed->>'repositoryURL'
            AND w.source_branch=NEW.seed->>'branch' AND w.source_revision=NEW.seed->>'revision')
        OR EXISTS(SELECT 1 FROM factory.runtime_attempt a WHERE a.workspace_id=NEW.workspace_id)
        THEN RAISE EXCEPTION 'Initial service Source requires its exact Workspace seed before any Attempt'; END IF;
    ELSIF NEW.owner<>'actor' OR NEW.seed IS NOT NULL
      OR NOT EXISTS(SELECT 1 FROM factory.runtime_attempt a
        WHERE a.workspace_id=NEW.workspace_id AND a.actor_uid=NEW.actor_uid
          AND a.delete_intended_at IS NULL AND a.deleted_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt n WHERE n.workspace_id=a.workspace_id AND n.generation>a.generation))
      THEN RAISE EXCEPTION 'Source requires its current original Actor binding'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.seed IS DISTINCT FROM OLD.seed
    THEN RAISE EXCEPTION 'Source seed is immutable'; END IF;
  IF OLD.seed_confirmed_at IS NOT NULL AND NEW.seed_confirmed_at IS DISTINCT FROM OLD.seed_confirmed_at
    THEN RAISE EXCEPTION 'Source seed confirmation is immutable'; END IF;
  IF OLD.seed_confirmed_at IS NULL AND NEW.seed_confirmed_at IS NOT NULL AND (
    OLD.seed IS NULL OR OLD.actor_uid IS NOT NULL OR OLD.owner<>'service'
    OR OLD.service_base::text IS DISTINCT FROM OLD.seed->>'id'
    OR ROW(NEW.actor_uid,NEW.owner,NEW.writer_epoch,NEW.writable,NEW.generation,
        NEW.checkpoint_id,NEW.checkpoint,NEW.service_base)
      IS DISTINCT FROM ROW(OLD.actor_uid,OLD.owner,OLD.writer_epoch,OLD.writable,OLD.generation,
        OLD.checkpoint_id,OLD.checkpoint,OLD.service_base))
    THEN RAISE EXCEPTION 'Source seed confirmation requires its unchanged initialized service owner'; END IF;
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.writer_epoch<OLD.writer_epoch OR NEW.writer_epoch>OLD.writer_epoch+1
    OR NEW.generation<OLD.generation OR NEW.generation>OLD.generation+1
    THEN RAISE EXCEPTION 'Source identity/epoch/generation changed'; END IF;
  IF NEW.actor_uid IS DISTINCT FROM OLD.actor_uid THEN
    IF OLD.owner<>'service' OR NEW.owner<>'actor' OR OLD.writable OR NOT NEW.writable
      THEN RAISE EXCEPTION 'Source Actor transfer requires its confirmed stopped predecessor and current native successor'; END IF;
    IF OLD.actor_uid IS NULL THEN
      IF NEW.actor_uid IS NULL OR OLD.seed IS NULL OR OLD.seed_confirmed_at IS NULL
        OR OLD.service_base::text IS DISTINCT FROM OLD.seed->>'id'
        OR NOT EXISTS(
          SELECT 1 FROM factory.runtime_attempt current
          JOIN factory.substrate_provision provision ON provision.owner_id=current.workspace_id
            AND provision.kind='workspace' AND provision.generation=current.generation
          WHERE current.workspace_id=NEW.workspace_id
            AND current.project_id::text=OLD.seed->>'projectID' AND current.revision=OLD.seed->>'revision'
            AND (current.state='create-intended' OR (current.state='starting'
              AND current.binding_intent->>'sourceRestoreProtocol'='2'))
            AND current.stop_intended_at IS NULL
            AND current.actor_uid=NEW.actor_uid AND NOT current.create_rejected
            AND current.create_attempted_at IS NOT NULL
            AND current.delete_intended_at IS NULL AND current.deleted_at IS NULL
            AND current.observation#>>'{metadata,uid}'=NEW.actor_uid::text
            AND current.observation#>>'{metadata,name}'=current.actor_name
            AND current.observation#>>'{metadata,atespace}'=current.atespace
            AND current.binding_intent->>'projectID'=current.project_id::text
            AND current.binding_intent->>'workspaceID'=NEW.workspace_id::text
            AND current.binding_intent->>'generation'=current.generation::text
            AND current.binding_intent->>'atespaceUID'=provision.resources#>>'{atespace,value,metadata,uid}'
            AND current.binding_intent->>'templateUID'=provision.resources#>>'{template,value,metadata,uid}'
            AND current.binding_intent->>'templateVersion'=provision.resources#>>'{template,value,metadata,version}'
            AND current.binding_intent->>'templateSHA256'=provision.intent->>'templateSHA256'
            AND jsonb_typeof(provision.resources->'atespace'->'value')='object'
            AND jsonb_typeof(provision.resources->'policy'->'value')='object'
            AND jsonb_typeof(provision.resources->'template'->'value')='object'
            AND NOT COALESCE((provision.resources#>>'{atespace,rejected}')::boolean,false)
            AND NOT COALESCE((provision.resources#>>'{policy,rejected}')::boolean,false)
            AND NOT COALESCE((provision.resources#>>'{template,rejected}')::boolean,false)
            AND provision.intent->>'revision'=OLD.seed->>'revision'
            AND provision.intent->>'branch'=OLD.seed->>'branch'
            AND provision.intent->>'repositoryURL'=OLD.seed->>'repositoryURL'
            AND NOT EXISTS(
              SELECT 1 FROM factory.runtime_attempt other
              WHERE other.workspace_id=current.workspace_id AND other.id<>current.id
                AND (other.generation<current.generation AND other.state='stopped'
                  AND other.deleted_at IS NOT NULL AND other.binding_intent->>'sourceRestoreProtocol'='2') IS NOT TRUE))
        THEN RAISE EXCEPTION 'Source first Actor transfer requires its confirmed seed and exact generation-one native binding'; END IF;
    ELSIF NOT EXISTS(
        SELECT 1 FROM factory.runtime_attempt predecessor
        JOIN factory.runtime_attempt current ON current.workspace_id=predecessor.workspace_id
          AND current.generation>predecessor.generation
        JOIN factory.substrate_provision provision ON provision.owner_id=current.workspace_id
          AND provision.kind='workspace' AND provision.generation=current.generation
        WHERE predecessor.workspace_id=NEW.workspace_id AND predecessor.state='stopped'
          AND predecessor.actor_uid=OLD.actor_uid AND predecessor.deleted_at IS NOT NULL
          AND (current.state='create-intended' OR (current.state='starting'
            AND current.binding_intent->>'sourceRestoreProtocol'='2'))
          AND current.stop_intended_at IS NULL
          AND current.actor_uid=NEW.actor_uid AND NOT current.create_rejected
          AND current.create_attempted_at IS NOT NULL
          AND current.delete_intended_at IS NULL AND current.deleted_at IS NULL
          AND current.binding_intent->>'workspaceID'=NEW.workspace_id::text
          AND current.binding_intent->>'generation'=current.generation::text
          AND current.binding_intent->>'atespaceUID'=provision.resources#>>'{atespace,value,metadata,uid}'
          AND current.binding_intent->>'templateUID'=provision.resources#>>'{template,value,metadata,uid}'
          AND current.binding_intent->>'templateVersion'=provision.resources#>>'{template,value,metadata,version}'
          AND current.binding_intent->>'templateSHA256'=provision.intent->>'templateSHA256'
          AND NOT EXISTS(
            SELECT 1 FROM factory.runtime_attempt skipped
            WHERE skipped.workspace_id=current.workspace_id
              AND skipped.generation>predecessor.generation AND skipped.generation<current.generation
              AND (skipped.state='stopped' AND skipped.deleted_at IS NOT NULL
                AND skipped.binding_intent->>'sourceRestoreProtocol'='2') IS NOT TRUE)
          AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt newer WHERE newer.workspace_id=current.workspace_id AND newer.generation>current.generation))
      THEN RAISE EXCEPTION 'Source Actor transfer requires its confirmed stopped predecessor and current native successor'; END IF;
  END IF;
  IF NEW.generation<>OLD.generation THEN
    IF NEW.writable OR NEW.owner<>OLD.owner OR NEW.writer_epoch<>OLD.writer_epoch
      OR NEW.checkpoint_id IS DISTINCT FROM OLD.checkpoint_id
      OR NEW.checkpoint->>'id' IS DISTINCT FROM NEW.checkpoint_id::text
      OR NEW.checkpoint->>'workspaceID' IS DISTINCT FROM NEW.workspace_id::text
      OR NEW.checkpoint->>'actorUID' IS DISTINCT FROM NEW.actor_uid::text
      OR (NEW.actor_uid IS NULL AND (
        NEW.seed_confirmed_at IS NULL
        OR NEW.checkpoint->'actorUID' IS DISTINCT FROM 'null'::jsonb
        OR NEW.checkpoint->'seedID' IS DISTINCT FROM NEW.seed->'id'))
      OR (NEW.actor_uid IS NOT NULL AND NEW.checkpoint ? 'seedID')
      OR NEW.checkpoint->>'generation' IS DISTINCT FROM NEW.generation::text
      OR NEW.checkpoint->>'writerEpoch' IS DISTINCT FROM NEW.writer_epoch::text
      THEN RAISE EXCEPTION 'Source checkpoint confirmation differs from frozen writer'; END IF;
  ELSIF NEW.checkpoint IS DISTINCT FROM OLD.checkpoint THEN
    RAISE EXCEPTION 'Last confirmed Source is immutable until a new generation';
  END IF;
  IF NEW.owner<>OLD.owner THEN
    IF OLD.writable OR NOT NEW.writable OR NEW.writer_epoch<>OLD.writer_epoch+1
      OR OLD.checkpoint_id IS NULL OR OLD.checkpoint->>'id' IS DISTINCT FROM OLD.checkpoint_id::text
      OR NEW.checkpoint_id IS NOT NULL OR NEW.generation<>OLD.generation
      OR (NEW.owner='service' AND NEW.service_base IS DISTINCT FROM OLD.checkpoint_id)
      THEN RAISE EXCEPTION 'Source transfer requires a completely confirmed frozen generation'; END IF;
    IF NEW.actor_uid=OLD.actor_uid AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt a
      WHERE a.workspace_id=NEW.workspace_id AND a.actor_uid=NEW.actor_uid
        AND a.checkpoint->>'actorUID'=NEW.actor_uid::text
        AND a.checkpoint->>'fidelity' IN ('SNAPSHOT_FIDELITY_ROOTFS','SNAPSHOT_FIDELITY_MEMORY')
        AND a.checkpoint#>>'{durableSnapshot,state}'='SNAPSHOT_STORAGE_STATE_COMPLETED'
        AND ((a.state='paused' AND a.observation#>>'{status,state}'='ACTOR_STATE_SUSPENDED'
          AND a.checkpoint->>'generation'=a.observation#>>'{status,lastAssignedGeneration}')
          OR (NEW.owner='actor' AND a.state='starting' AND a.stop_intended_at IS NULL
            AND a.binding_intent->>'sourceRestoreProtocol'='2' AND EXISTS(
              SELECT 1 FROM factory.operation resumed
              WHERE resumed.kind='runtime.actor_rpc' AND resumed.scope_type='runtime_attempt'
                AND resumed.scope_id=a.id::text AND (resumed.payload->>'actorUid')::uuid=NEW.actor_uid
                AND resumed.payload->>'action'='resume'
                AND NULLIF(resumed.payload->'originCheckpoint','null'::jsonb) IS NOT DISTINCT FROM a.checkpoint
                AND (resumed.payload->>'attemptedAt') IS NOT NULL))))
      AND NOT (NEW.owner='service' AND EXISTS(
        SELECT 1 FROM factory.runtime_attempt a
        WHERE a.workspace_id=NEW.workspace_id AND a.state='stopping' AND a.stop_intended_at IS NOT NULL
          AND a.actor_uid=NEW.actor_uid AND a.create_attempted_at IS NOT NULL AND NOT a.create_rejected
          AND a.delete_intended_at IS NULL AND a.deleted_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt newer
            WHERE newer.workspace_id=a.workspace_id AND newer.generation>a.generation)))
      THEN RAISE EXCEPTION 'Source transfer requires original durable paused ROOTFS or final Stop intent'; END IF;
  ELSIF NEW.writable IS DISTINCT FROM OLD.writable THEN
    IF OLD.owner='service' AND NOT OLD.writable AND NEW.writable
      AND NEW.writer_epoch=OLD.writer_epoch+1 AND NEW.checkpoint_id IS NULL
      AND EXISTS(
        SELECT 1 FROM factory.runtime_attempt a
        WHERE a.workspace_id=NEW.workspace_id AND a.state='stopping' AND a.stop_intended_at IS NOT NULL
          AND a.binding_intent->>'sourceRestoreProtocol'='2' AND a.actor_uid IS NOT NULL
          AND a.create_attempted_at IS NOT NULL AND NOT a.create_rejected AND a.deleted_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt newer
            WHERE newer.workspace_id=a.workspace_id AND newer.generation>a.generation))
      THEN NULL; -- No v2 writer grant was committed; retain the same saved service tree.
    ELSIF NOT OLD.writable OR NEW.writable OR NEW.writer_epoch<>OLD.writer_epoch+1 OR NEW.checkpoint_id IS NULL
      THEN RAISE EXCEPTION 'Source freeze must advance the writer epoch'; END IF;
  ELSIF ROW(NEW.writer_epoch,NEW.checkpoint_id,NEW.service_base) IS DISTINCT FROM ROW(OLD.writer_epoch,OLD.checkpoint_id,OLD.service_base) THEN
    RAISE EXCEPTION 'Source lease facts cannot change outside freeze/transfer';
  END IF;
  IF NEW.owner=OLD.owner AND NEW.service_base IS DISTINCT FROM OLD.service_base THEN
    RAISE EXCEPTION 'Source service base is immutable for its ownership interval'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION factory.protect_substrate_provision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  previous_generation bigint;
  previous_provision factory.substrate_provision;
  k text;
  old_r jsonb;
  new_r jsonb;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Native provisioning names cannot be reused'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.kind='workspace' THEN
      SELECT max(generation) INTO previous_generation FROM factory.substrate_provision
        WHERE owner_id=NEW.owner_id AND kind='workspace';
      IF (previous_generation IS NULL AND NEW.generation<>1)
        OR (previous_generation IS NOT NULL AND (
          NEW.generation<>previous_generation+1 OR NOT EXISTS(
            SELECT 1 FROM factory.runtime_attempt a
            JOIN factory.substrate_source s ON s.workspace_id=a.workspace_id
            WHERE a.workspace_id=NEW.owner_id AND a.generation=previous_generation
              AND a.state='stopped' AND a.deleted_at IS NOT NULL
              AND s.owner='service' AND s.writable AND s.service_base IS NOT NULL
              AND ((s.actor_uid=a.actor_uid AND s.checkpoint IS NOT NULL)
                OR (a.binding_intent->>'sourceRestoreProtocol'='2'
                  AND (s.checkpoint IS NOT NULL OR s.seed_confirmed_at IS NOT NULL))))))
        THEN RAISE EXCEPTION 'Native Workspace successor requires exact cleanup and independent Source'; END IF;
      IF NOT EXISTS(SELECT 1 FROM factory.development_workspace w WHERE w.id=NEW.owner_id
        AND (w.kind='personal' OR EXISTS (
          SELECT 1 FROM factory.change c JOIN factory.ticket t ON t.id=c.ticket_id
          JOIN factory.operation b ON b.kind='delivery.branch_create' AND b.scope_type='change' AND b.scope_id=c.id::text
          WHERE c.id=w.change_id AND c.ticket_id=w.ticket_id AND c.project_id=w.project_id
            AND c.cancel_requested_at IS NULL AND c.state IN ('starting','active','failed')
            AND t.trashed_at IS NULL AND b.state='succeeded' AND b.result->>'observedHeadSha'=c.base_sha
            AND w.source_revision=c.base_sha AND w.source_branch=c.branch_name))
        AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt a WHERE a.workspace_id=w.id AND a.generation>=NEW.generation))
        THEN RAISE EXCEPTION 'Native provisioning requires a fresh personal or approved Ticket Workspace'; END IF;
    ELSIF NEW.kind='verification' THEN
      SELECT * INTO previous_provision FROM factory.substrate_provision
        WHERE owner_id=NEW.owner_id AND kind='verification' ORDER BY generation DESC LIMIT 1;
      IF (previous_provision.runtime_attempt_id IS NULL AND NEW.generation<>1)
        OR (previous_provision.runtime_attempt_id IS NOT NULL AND (
          NEW.generation<>previous_provision.generation+1 OR NOT EXISTS(
            SELECT 1 FROM factory.runtime_attempt a
            JOIN factory.verification v ON v.id=NEW.owner_id
            JOIN factory.audit_event decision ON decision.kind='usage.policy_command'
              AND decision.scope_type='execution_policy'
              AND decision.scope_id='checks-bootstrap-retry:'||v.change_id::text
            WHERE a.id=previous_provision.runtime_attempt_id AND a.verification_id=v.id
              AND a.state='stopped' AND a.deleted_at IS NOT NULL
              AND decision.payload->'input'->>'verificationID'=v.id::text
              AND decision.payload->'input'->>'runtimeAttemptID'=a.id::text
              AND decision.payload->'result'->>'runtimeAttemptID'=a.id::text
              AND decision.payload->'result'->>'state'='failed')))
        THEN RAISE EXCEPTION 'Native Verification successor requires exact cleanup and an explicit bootstrap retry decision'; END IF;
      IF NEW.runtime_attempt_id<>factory.deterministic_uuid(NEW.owner_id::text||':'||NEW.generation::text)
        OR NOT EXISTS(SELECT 1 FROM factory.verification v JOIN factory.change c ON c.id=v.change_id
          JOIN factory.ticket t ON t.id=c.ticket_id
          WHERE v.id=NEW.owner_id AND v.runtime_attempt_id IS NULL
            AND v.state='pending' AND v.action_run_id IS NOT NULL AND v.runner_uuid IS NOT NULL
            AND v.runner_token IS NOT NULL AND v.runner_job_handle IS NOT NULL
            AND c.state='active' AND c.cancel_requested_at IS NULL AND t.trashed_at IS NULL
            AND NEW.intent#>>'{configuration,projectID}'=c.project_id::text
            AND NEW.intent#>>'{configuration,database}'=current_database()
            AND NEW.intent->>'revision'=v.commit_sha AND NEW.intent->>'jobHandle'=v.runner_job_handle
            AND NEW.intent->>'runnerUUID'=v.runner_uuid::text
            AND NOT EXISTS(SELECT 1 FROM factory.change_agent_session s WHERE s.change_id=c.id AND (s.state='stopped' OR s.stop_pending))
            AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt a WHERE a.id=NEW.runtime_attempt_id))
        THEN RAISE EXCEPTION 'Native Verification requires deterministic fresh exact-job intent'; END IF;
    ELSE
      IF NEW.runtime_attempt_id<>factory.deterministic_uuid(NEW.owner_id::text||':'||NEW.generation::text)
        OR (NEW.intent#>>'{configuration,projectID}') IS DISTINCT FROM NEW.project_id::text
        OR (NEW.intent#>>'{configuration,database}') IS DISTINCT FROM current_database()
        OR NOT EXISTS(SELECT 1 FROM factory.project project WHERE project.id=NEW.project_id
          AND project.repository_url=NEW.intent->>'repository'
          AND project.actor_template_path=NEW.intent->>'actorTemplatePath')
        OR NOT EXISTS(SELECT 1 FROM auth."user" principal WHERE principal.id::text=NEW.intent->>'createdBy'
          AND (EXISTS(SELECT 1 FROM factory.project_membership member WHERE member.user_id=principal.id AND member.project_id=NEW.project_id)
            OR EXISTS(SELECT 1 FROM factory.administrator administrator WHERE administrator.user_id=principal.id)))
        OR EXISTS(SELECT 1 FROM factory.runtime_attempt WHERE id=NEW.runtime_attempt_id)
        THEN RAISE EXCEPTION 'Native isolated provisioning requires deterministic fresh product intent'; END IF;
      IF NEW.kind='publication' THEN
        IF NEW.intent->>'promotionID' IS NOT NULL OR NOT EXISTS(
          SELECT 1 FROM factory.operation publication JOIN factory.project_release release ON release.id=(publication.scope_id)::uuid
          WHERE publication.kind='releases.attempt' AND publication.scope_type='project_release'
            AND publication.id=NEW.owner_id AND release.project_id=NEW.project_id
            AND release.created_by::text=NEW.intent->>'createdBy' AND release.commit_sha=NEW.intent->>'revision'
            AND release.version=NEW.intent->>'version' AND publication.payload->>'jobHandle'=NEW.intent->>'jobHandle'
            AND publication.payload->>'runnerUuid'=NEW.intent->>'runnerUUID' AND publication.payload->>'runnerToken' IS NOT NULL
            AND publication.payload->>'runId' IS NOT NULL AND publication.payload->>'dispatchIntendedAt' IS NOT NULL
            AND publication.payload->>'runtimeAttemptId' IS NULL AND publication.state='running' AND release.state='running'
            AND publication.id=(SELECT id FROM factory.operation
              WHERE kind='releases.attempt' AND scope_type='project_release' AND scope_id=release.id::text
              ORDER BY (payload->>'ordinal')::int DESC LIMIT 1))
          OR (NEW.intent#>>'{environment,environment}') IS DISTINCT FROM 'development'
          OR (NEW.intent#>>'{environment,version}') IS DISTINCT FROM '0' OR NEW.intent#>>'{environment,secretKey}' IS NOT NULL
          THEN RAISE EXCEPTION 'Native publication requires its exact active job and empty Project environment'; END IF;
      ELSIF NEW.intent->>'promotionID' IS NOT NULL THEN
        IF NEW.owner_id::text<>NEW.intent->>'promotionID' OR NOT EXISTS(
          SELECT 1 FROM factory.operation promotion JOIN factory.change change ON change.id::text=promotion.payload->>'changeId'
          JOIN factory.ticket ticket ON ticket.id=change.ticket_id
          JOIN factory.operation merge ON merge.kind='delivery.merge' AND merge.scope_type='change'
            AND merge.scope_id=change.id::text AND merge.state='succeeded'
            AND merge.payload->>'commitSha'=promotion.payload->>'commitSha'
            AND merge.result->>'mergeSha'=merge.payload->>'commitSha'
          JOIN factory.delivery_approval approval ON approval.id::text=merge.payload->>'approvalId'
            AND approval.change_id=change.id AND approval.commit_sha=merge.payload->>'commitSha'
          JOIN factory.verification verification ON verification.id=approval.verification_id
            AND verification.change_id=change.id AND verification.commit_sha=merge.payload->>'commitSha' AND verification.state='succeeded'
          JOIN factory.candidate_review review ON review.id=approval.candidate_review_id AND review.verification_id=verification.id
            AND review.change_id=change.id AND review.commit_sha=merge.payload->>'commitSha' AND review.state='passed'
          WHERE promotion.id=NEW.owner_id AND promotion.kind='delivery.promotion' AND promotion.scope_type='change'
            AND promotion.scope_id=change.id::text
            AND promotion.payload->>'projectId'=NEW.project_id::text AND change.project_id=NEW.project_id
            AND promotion.payload->>'commitSha'=NEW.intent->>'revision' AND promotion.state='pending'
            AND (promotion.payload->>'replacementRuntimeAttemptId') IS NULL AND change.state='delivering'
            AND change.cancel_requested_at IS NULL AND ticket.trashed_at IS NULL
            AND EXISTS(SELECT 1 FROM factory.current_promotion WHERE id=promotion.id))
          THEN RAISE EXCEPTION 'Native Staging replacement requires its approved exact-commit promotion'; END IF;
      ELSE
        IF NEW.owner_id<>factory.deterministic_uuid('staging:'||NEW.project_id::text||':1') OR NOT EXISTS(
          SELECT 1 FROM factory.operation preview
          WHERE preview.kind='delivery.staging_preview' AND preview.scope_type='project'
            AND preview.scope_id=NEW.project_id::text
            AND preview.payload->>'revision'=NEW.intent->>'revision'
            AND (preview.payload->>'runtimeAttemptId' IS NULL
              OR EXISTS(SELECT 1 FROM factory.runtime_attempt predecessor
                WHERE predecessor.id::text=preview.payload->>'runtimeAttemptId'
                  AND predecessor.state='stopped' AND predecessor.deleted_at IS NOT NULL)))
          OR (NEW.generation>1 AND NOT EXISTS(
            SELECT 1 FROM factory.substrate_provision previous JOIN factory.runtime_attempt predecessor ON predecessor.id=previous.runtime_attempt_id
            WHERE previous.owner_id=NEW.owner_id AND previous.kind=NEW.kind AND previous.generation=NEW.generation-1
              AND predecessor.state='stopped' AND predecessor.deleted_at IS NOT NULL))
          THEN RAISE EXCEPTION 'Native initial Staging requires its pinned Preview and confirmed predecessor cleanup'; END IF;
      END IF;
      IF NEW.kind='staging' AND ((NEW.intent#>>'{environment,environment}') IS DISTINCT FROM 'main-preview'
        OR NOT EXISTS(SELECT 1 FROM factory.project project
          LEFT JOIN factory.operation environment ON environment.kind='environments.environment'
            AND environment.scope_type='project' AND environment.scope_id=project.id::text
            AND environment.idempotency_key='environments.environment:'||project.id::text||':main-preview'
          WHERE project.id=NEW.project_id AND NEW.intent#>>'{environment,version}'=COALESCE((environment.payload->>'version')::bigint,0)::text
            AND (NEW.intent#>>'{environment,secretKey}') IS NOT DISTINCT FROM (environment.payload->>'secretKey')))
        THEN RAISE EXCEPTION 'Native Staging requires its frozen main-preview environment'; END IF;
    END IF;
  ELSE
    IF ROW(NEW.owner_id,NEW.kind,NEW.generation,NEW.project_id,NEW.runtime_attempt_id,NEW.intent)
        IS DISTINCT FROM ROW(OLD.owner_id,OLD.kind,OLD.generation,OLD.project_id,OLD.runtime_attempt_id,OLD.intent) THEN
      RAISE EXCEPTION 'Native provisioning identity and dispatch facts are immutable';
    END IF;
    FOREACH k IN ARRAY ARRAY['atespace','policy','template'] LOOP
      old_r := COALESCE(OLD.resources->k,'{}'::jsonb);
      new_r := COALESCE(NEW.resources->k,'{}'::jsonb);
      IF (old_r->>'attemptedAt' IS NOT NULL AND new_r->>'attemptedAt' IS DISTINCT FROM old_r->>'attemptedAt')
        OR (NULLIF(old_r->'value','null'::jsonb) IS NOT NULL AND new_r->'value' IS DISTINCT FROM old_r->'value')
        OR (COALESCE((old_r->>'rejected')::boolean,false) AND NOT COALESCE((new_r->>'rejected')::boolean,false)) THEN
        RAISE EXCEPTION 'Native provisioning identity and dispatch facts are immutable';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;

-- Native 20-delivery-functions.sql.
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

-- Native 21-verification-functions.sql.
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

-- Native 22-projections-functions.sql.
-- Projections routines. Run before Drizzle tables, with check_function_bodies disabled.

CREATE FUNCTION factory.invalidate_factory_reads() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
<<projection>>
DECLARE
  record jsonb := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  project uuid;
  ticket uuid;
  change uuid;
  conversation uuid;
  audience text := 'shared';
  person uuid;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME='agent_turn' THEN
      IF (OLD.state,OLD.outcome_summary) IS NOT DISTINCT FROM (NEW.state,NEW.outcome_summary) THEN RETURN NULL; END IF;
    ELSIF TG_TABLE_NAME='conversation_context' THEN
      IF (to_jsonb(OLD)-ARRAY['transcript','archived_session']) = (to_jsonb(NEW)-ARRAY['transcript','archived_session']) THEN RETURN NULL; END IF;
    ELSIF (to_jsonb(OLD)-ARRAY['updated_at','owner_expires_at','owner_token']) =
          (to_jsonb(NEW)-ARRAY['updated_at','owner_expires_at','owner_token']) THEN RETURN NULL;
    END IF;
  END IF;

  IF TG_TABLE_NAME IN ('account_access','administrator') THEN
    person := (record->>'user_id')::uuid;
    FOR project IN
      SELECT id FROM factory.project WHERE EXISTS(
        SELECT 1 FROM factory.project_membership WHERE project_id=id AND user_id=person)
        OR EXISTS(SELECT 1 FROM factory.administrator WHERE user_id=person)
      ORDER BY id
    LOOP
      PERFORM factory.touch_read_version(project,'inbox',project,person::text);
      PERFORM factory.touch_read_version(project,'inbox',project);
    END LOOP;
    RETURN NULL;
  END IF;

  project := (record->>'project_id')::uuid;
  ticket := (record->>'ticket_id')::uuid;
  change := (record->>'change_id')::uuid;
  conversation := (record->>'conversation_id')::uuid;
  IF TG_TABLE_NAME='project' THEN project := (record->>'id')::uuid; END IF;
  IF TG_TABLE_NAME='ticket' THEN ticket := (record->>'id')::uuid; END IF;
  IF TG_TABLE_NAME='audit_event' THEN
    IF record->>'kind'='tickets.responsibility_event' AND record->>'scope_type'='ticket' THEN
      ticket := (record->>'scope_id')::uuid;
    ELSIF record->>'kind'='access.change_editing_decision' AND record->>'scope_type'='change' THEN
      change := (record->>'scope_id')::uuid;
    ELSIF record->>'kind'='review.feedback_message' AND record->>'scope_type'='review_feedback' THEN
      SELECT change_id INTO change FROM factory.review_feedback WHERE id=(record->>'scope_id')::uuid;
    ELSE
      RETURN NULL;
    END IF;
  END IF;
  IF TG_TABLE_NAME='operation' THEN
    IF record->>'kind'='inbox.receipt' AND record->>'scope_type'='user' THEN
      person := (record->>'scope_id')::uuid;
      FOR project IN
        SELECT id FROM factory.project WHERE EXISTS(
          SELECT 1 FROM factory.project_membership WHERE project_id=id AND user_id=person)
          OR EXISTS(SELECT 1 FROM factory.administrator WHERE user_id=person)
        ORDER BY id
      LOOP
        PERFORM factory.touch_read_version(project,'inbox',project,person::text);
      END LOOP;
      RETURN NULL;
    ELSIF record->>'kind' IN ('delivery.merge','delivery.pull_request','delivery.promotion') AND record->>'scope_type'='change' THEN
      change := (record->>'scope_id')::uuid;
    ELSIF record->>'kind'='access.change_editing_request' AND record->>'scope_type'='change' THEN
      change := (record->>'scope_id')::uuid;
      audience := record->'payload'->>'ownerId';
    ELSIF record->>'kind'='review.scenario' AND record->>'scope_type'='candidate_review' THEN
      SELECT change_id INTO change FROM factory.candidate_review WHERE id=(record->>'scope_id')::uuid;
    ELSIF record->>'kind' IN ('project.delivery_queue','delivery.staging_preview','knowledge.generation') AND record->>'scope_type'='project' THEN
      project := (record->>'scope_id')::uuid;
    ELSIF record->>'kind' IN ('tickets.responsibility','tickets.implementation_order') AND record->>'scope_type'='ticket' THEN
      ticket := (record->>'scope_id')::uuid;
    ELSIF record->>'kind'='tickets.follow' AND record->>'scope_type'='ticket' THEN
      ticket := (record->>'scope_id')::uuid;
      audience := record->'payload'->>'userId';
    ELSIF record->>'kind'='usage.coding_pause' AND record->>'scope_type'='agent_turn' THEN
      SELECT change_id INTO change FROM factory.agent_turn WHERE id=(record->>'scope_id')::uuid;
    ELSIF record->>'kind'='runtime.compute_wait' AND record->>'scope_type'='runtime_attempt' THEN
      SELECT project_id,change_id INTO project,change FROM factory.runtime_attempt WHERE id=(record->>'scope_id')::uuid;
    ELSE
      RETURN NULL;
    END IF;
  END IF;
  IF TG_TABLE_NAME='change' THEN change := (record->>'id')::uuid; END IF;
  IF TG_TABLE_NAME='ticket_conversation' THEN conversation := (record->>'id')::uuid; END IF;
  IF change IS NOT NULL THEN
    SELECT project_id,ticket_id INTO project,ticket FROM factory.change WHERE id=projection.change;
  ELSIF conversation IS NOT NULL THEN
    SELECT project_id,ticket_id,CASE WHEN ticket_id IS NULL THEN created_by::text ELSE 'shared' END
      INTO project,ticket,audience FROM factory.ticket_conversation WHERE id=projection.conversation;
  ELSIF ticket IS NOT NULL THEN
    SELECT project_id INTO project FROM factory.ticket WHERE id=projection.ticket;
  END IF;
  IF TG_TABLE_NAME='agent_turn' AND ticket IS NULL THEN audience := record->>'created_by'; END IF;
  IF audience='shared' AND (
    TG_TABLE_NAME='technical_design_revision' OR
    (TG_TABLE_NAME='conversation_entry' AND record->'payload'->>'visibility'='developer') OR
    (TG_TABLE_NAME='conversation_context' AND record->>'kind'='coding') OR
    (TG_TABLE_NAME='agent_turn' AND (
      record->'authority'->>'visibility'='developer' OR
      record->'authority'->>'mode'='build' OR
      record->'input'->>'intent' IN ('technical-planning','full-planning')))
  ) THEN audience := 'developer'; END IF;
  IF project IS NULL OR audience IS NULL THEN RETURN NULL; END IF;

  PERFORM factory.touch_read_version(project,'inbox',project,audience);
  IF TG_TABLE_NAME IN ('conversation_entry','conversation_context','ticket_conversation','agent_turn',
    'ticket','ticket_document_revision','requirement_revision','requirement_approval','technical_design_revision') THEN
    PERFORM factory.touch_read_version(project,'conversation',COALESCE(ticket,project),audience);
  END IF;
  IF ticket IS NOT NULL THEN
    PERFORM factory.touch_read_version(project,'ticket',ticket,audience);
  END IF;
  IF change IS NOT NULL THEN
    PERFORM factory.touch_read_version(project,'review',change,audience);
  END IF;
  IF TG_TABLE_NAME IN ('change','runtime_attempt','verification','candidate_review',
    'change_agent_session','change_writer',
    'delivery_approval',
    'review_feedback','review_media')
    OR (TG_TABLE_NAME='agent_turn' AND change IS NOT NULL)
    OR (TG_TABLE_NAME='audit_event' AND record->>'kind' IN ('access.change_editing_decision','review.feedback_message'))
    OR (TG_TABLE_NAME='operation' AND record->>'kind' IN ('delivery.merge','delivery.pull_request','delivery.promotion','delivery.staging_preview','project.delivery_queue','runtime.compute_wait','review.scenario','tickets.implementation_order','usage.coding_pause')) THEN
    PERFORM factory.touch_read_version(project,'lifecycle',project);
  END IF;
  IF TG_TABLE_NAME='knowledge_page' OR (TG_TABLE_NAME='operation' AND record->>'kind'='knowledge.generation') THEN
    PERFORM factory.touch_read_version(project,'knowledge',project);
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION factory.invalidate_settings_reads() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  record jsonb := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  project uuid;
  library uuid;
  library_scope text;
  target_scope text;
BEGIN
  IF TG_OP='UPDATE' AND
    (to_jsonb(OLD)-ARRAY['updated_at','owner_expires_at','owner_token','received_window','received_count']) =
    (to_jsonb(NEW)-ARRAY['updated_at','owner_expires_at','owner_token','received_window','received_count'])
    THEN RETURN NULL;
  END IF;
  IF TG_TABLE_NAME='project_membership' THEN
    IF TG_OP='UPDATE' AND (OLD.role,OLD.manage_project) IS NOT DISTINCT FROM (NEW.role,NEW.manage_project)
      THEN RETURN NULL;
    END IF;
    project := (record->>'project_id')::uuid;
    -- Cached Settings capabilities must follow current Project authority even
    -- when the member remains authorized to read the same version rows.
    FOREACH target_scope IN ARRAY ARRAY['inputs','sources','releases'] LOOP
      PERFORM factory.touch_read_version(project,target_scope,project);
    END LOOP;
    RETURN NULL;
  ELSIF TG_TABLE_NAME IN ('monitoring_hook','monitoring_incident') THEN
    project := (record->>'project_id')::uuid;
    target_scope := 'inputs';
  ELSIF TG_TABLE_NAME='project_release' THEN
    project := (record->>'project_id')::uuid;
    target_scope := 'releases';
  ELSIF TG_TABLE_NAME='operation' THEN
    IF record->>'kind'='releases.access' AND record->>'scope_type'='project' THEN
      project := (record->>'scope_id')::uuid;
      target_scope := 'releases';
    ELSIF record->>'kind'='releases.attempt' AND record->>'scope_type'='project_release' THEN
      SELECT project_id INTO project FROM factory.project_release WHERE id=(record->>'scope_id')::uuid;
      IF project IS NULL THEN RETURN NULL; END IF;
      target_scope := 'releases';
    ELSIF record->>'kind'='mcp.choice' THEN
      IF record->>'scope_type'='personal' THEN RETURN NULL; END IF;
      IF record->>'scope_type'='project' THEN project := (record->>'scope_id')::uuid; END IF;
      target_scope := 'sources';
    ELSE
      RETURN NULL;
    END IF;
  ELSE
    library := COALESCE((record->>'library_id')::uuid,(record->>'id')::uuid);
    IF TG_TABLE_NAME='mcp_library' THEN
      project := (record->>'project_id')::uuid;
      library_scope := record->>'scope';
    ELSE
      SELECT scope,project_id INTO library_scope,project FROM factory.mcp_library WHERE id=library;
    END IF;
    IF TG_TABLE_NAME='mcp_connection' AND library_scope='personal' THEN
      FOR project IN
        SELECT DISTINCT key::uuid FROM (
          SELECT jsonb_object_keys(COALESCE(CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN OLD.project_grants END,'{}'::jsonb)) AS key
          UNION
          SELECT jsonb_object_keys(COALESCE(CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN NEW.project_grants END,'{}'::jsonb)) AS key
        ) keys
        WHERE key ~ '^[0-9a-f-]{36}$'
        ORDER BY 1
      LOOP
        PERFORM factory.touch_read_version(project,'sources',project);
      END LOOP;
      RETURN NULL;
    END IF;
    IF library_scope IS NULL OR library_scope='personal' THEN RETURN NULL; END IF;
    target_scope := 'sources';
  END IF;
  IF project IS NOT NULL THEN
    PERFORM factory.touch_read_version(project,target_scope,project);
  ELSE
    -- Shared Factory source changes invalidate authorized Project reads, not
    -- personal choices or private connection contents.
    FOR project IN SELECT id FROM factory.project ORDER BY id LOOP
      PERFORM factory.touch_read_version(project,target_scope,project);
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION factory.project_knowledge_page_outline() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    DELETE FROM factory.knowledge_page_outline WHERE id=OLD.id;
  ELSE
    INSERT INTO factory.knowledge_page_outline
      SELECT NEW.id,NEW.project_id,NEW.slug,NEW.title,NEW.parent_id,NEW.sort_order,NEW.icon,
        NEW.metadata_version,NEW.state,NEW.version,NEW.current_revision_id,NEW.created_at,NEW.updated_at
    ON CONFLICT (id) DO UPDATE SET
      project_id=EXCLUDED.project_id,slug=EXCLUDED.slug,title=EXCLUDED.title,parent_id=EXCLUDED.parent_id,sort_order=EXCLUDED.sort_order,
      icon=EXCLUDED.icon,metadata_version=EXCLUDED.metadata_version,state=EXCLUDED.state,
      version=EXCLUDED.version,current_revision_id=EXCLUDED.current_revision_id,updated_at=EXCLUDED.updated_at;
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION factory.touch_read_version(project uuid, target_scope text, resource uuid, target_audience text DEFAULT 'shared'::text) RETURNS void
    LANGUAGE plpgsql
    AS $_$
BEGIN
  IF $1 IS NULL OR $3 IS NULL OR NOT EXISTS(SELECT 1 FROM factory.project WHERE id=$1) THEN RETURN; END IF;
  -- Read projections lock last, after domain writes, and serialize all of a
  -- Project's audiences in one order. They never enter an admission lock chain.
  PERFORM pg_advisory_xact_lock(hashtextextended('read-version:'||$1::text,0));
  INSERT INTO factory.read_version(project_id,audience,scope,resource_id)
    VALUES ($1,$4,$2,$3)
  ON CONFLICT (project_id,audience,scope,resource_id)
    DO UPDATE SET revision=EXCLUDED.revision;
END;
$_$;

-- Native 29-function-validation.sql.
-- All pre-table routines are defined. Restore validation before Drizzle table/index/FK DDL.

RESET check_function_bodies;

CREATE TABLE "factory"."account_access" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"disabled_at" timestamp with time zone,
	"directory_disabled_at" timestamp with time zone,
	"disabled_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "factory"."administrator" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "factory"."agent_turn" (
	"id" uuid PRIMARY KEY NOT NULL,
	"command_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"ticket_id" uuid,
	"conversation_id" uuid,
	"change_id" uuid,
	"created_by" uuid NOT NULL,
	"input" jsonb NOT NULL,
	"input_digest" text NOT NULL,
	"authority" jsonb NOT NULL,
	"state" "factory"."agent_turn_state" DEFAULT 'pending' NOT NULL,
	"owner_token" uuid,
	"owner_expires_at" timestamp with time zone,
	"outcome_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_turn_command_id_key" UNIQUE("command_id"),
	CONSTRAINT "agent_turn_authority_check" CHECK ((jsonb_typeof("factory"."agent_turn"."authority") = 'object'::text) AND ("factory"."agent_turn"."authority" ? 'mode'::text) AND (octet_length(("factory"."agent_turn"."authority")::text) <= 2000)),
	CONSTRAINT "agent_turn_check" CHECK (("factory"."agent_turn"."owner_token" IS NULL) = ("factory"."agent_turn"."owner_expires_at" IS NULL)),
	CONSTRAINT "agent_turn_check1" CHECK (((("factory"."agent_turn"."input" ->> 'kind'::text) = ANY (ARRAY['project-message'::text, 'project-answer'::text])) AND ("factory"."agent_turn"."conversation_id" IS NOT NULL) AND ("factory"."agent_turn"."change_id" IS NULL) AND (("factory"."agent_turn"."authority" ->> 'mode'::text) = ANY (ARRAY['investigate'::text, 'plan'::text]))) OR ((("factory"."agent_turn"."input" ->> 'kind'::text) = ANY (ARRAY['change-start'::text, 'change-prompt'::text, 'change-repair'::text, 'change-review'::text])) AND ("factory"."agent_turn"."change_id" IS NOT NULL) AND ("factory"."agent_turn"."ticket_id" IS NOT NULL) AND (("factory"."agent_turn"."authority" ->> 'mode'::text) = 'build'::text))),
	CONSTRAINT "agent_turn_check2" CHECK ((("factory"."agent_turn"."input" ->> 'kind'::text) <> 'project-answer'::text) OR (("factory"."agent_turn"."authority" ->> 'mode'::text) = 'plan'::text)),
	CONSTRAINT "agent_turn_check3" CHECK (("factory"."agent_turn"."state" <> ALL (ARRAY['dispatching'::agent_turn_state, 'running'::agent_turn_state])) OR ("factory"."agent_turn"."owner_token" IS NOT NULL)),
	CONSTRAINT "agent_turn_check4" CHECK (("factory"."agent_turn"."state" <> ALL (ARRAY['completed'::agent_turn_state, 'failed'::agent_turn_state, 'stopped'::agent_turn_state, 'uncertain'::agent_turn_state])) OR ("factory"."agent_turn"."owner_token" IS NULL)),
	CONSTRAINT "agent_turn_input_check" CHECK ((jsonb_typeof("factory"."agent_turn"."input") = 'object'::text) AND ("factory"."agent_turn"."input" ? 'kind'::text) AND (octet_length(("factory"."agent_turn"."input")::text) <= 100000)),
	CONSTRAINT "agent_turn_input_digest_check" CHECK ("factory"."agent_turn"."input_digest" ~ '^[a-f0-9]{64}$'::text),
	CONSTRAINT "agent_turn_outcome_summary_check" CHECK (length("factory"."agent_turn"."outcome_summary") <= 2000),
	CONSTRAINT "agent_turn_review_authority" CHECK ((("factory"."agent_turn"."input" ->> 'kind'::text) = 'change-review'::text) = ("factory"."agent_turn"."authority" ? 'review'::text))
);

CREATE TABLE "factory"."attachment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"draft_id" uuid,
	"name" text NOT NULL,
	"media_type" text NOT NULL,
	"sha256" text NOT NULL,
	"byte_length" bigint NOT NULL,
	"reserved_bytes" bigint NOT NULL,
	"state" text NOT NULL,
	"text_content" text DEFAULT '' NOT NULL,
	"objects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failure" text,
	"upload_token" uuid,
	"upload_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "attachment_byte_length_check" CHECK ("factory"."attachment"."byte_length" > 0),
	CONSTRAINT "attachment_check" CHECK ("factory"."attachment"."reserved_bytes" >= "factory"."attachment"."byte_length"),
	CONSTRAINT "attachment_name_check" CHECK ((length("factory"."attachment"."name") >= 1) AND (length("factory"."attachment"."name") <= 240)),
	CONSTRAINT "attachment_objects_check" CHECK (jsonb_typeof("factory"."attachment"."objects") = 'array'::text),
	CONSTRAINT "attachment_sha256_check" CHECK ("factory"."attachment"."sha256" ~ '^[a-f0-9]{64}$'::text),
	CONSTRAINT "attachment_state_check" CHECK ("factory"."attachment"."state" = ANY (ARRAY['uploading'::text, 'ready'::text, 'failed'::text, 'deleting'::text, 'deleted'::text]))
);

CREATE TABLE "factory"."attachment_reference" (
	"attachment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"reference_id" uuid NOT NULL,
	"shared" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_reference_pkey" PRIMARY KEY("attachment_id","kind","reference_id"),
	CONSTRAINT "attachment_reference_kind_check" CHECK ("factory"."attachment_reference"."kind" = ANY (ARRAY['ticket'::text, 'requirement'::text, 'knowledge'::text, 'conversation'::text, 'feedback'::text, 'turn'::text]))
);

CREATE TABLE "factory"."audit_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"dedupe_key" text,
	"actor_id" uuid NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_event_dedupe_key_key" UNIQUE("dedupe_key"),
	CONSTRAINT "audit_event_payload_check" CHECK (jsonb_typeof("factory"."audit_event"."payload") = 'object'::text)
);

CREATE TABLE "auth"."account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_provider_id_account_id_key" UNIQUE("provider_id","account_id")
);

CREATE TABLE "auth"."session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	"authenticated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"login_method" text DEFAULT 'password' NOT NULL,
	CONSTRAINT "session_token_key" UNIQUE("token"),
	CONSTRAINT "session_login_method_check" CHECK ("auth"."session"."login_method" = ANY (ARRAY['password'::text, 'sso'::text, 'emergency'::text, 'identity-test'::text]))
);

CREATE TABLE "auth"."user" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_key" UNIQUE("email")
);

CREATE TABLE "auth"."verification" (
	"id" uuid PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "factory"."build_browser_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"turn_id" uuid NOT NULL,
	"change_id" uuid NOT NULL,
	"runtime_attempt_id" uuid NOT NULL,
	"generation" bigint NOT NULL,
	"agent_session_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"state" text DEFAULT 'intended' NOT NULL,
	"create_intended_at" timestamp with time zone DEFAULT now() NOT NULL,
	"create_confirmed_at" timestamp with time zone,
	"cleanup_intended_at" timestamp with time zone,
	"cleanup_confirmed_at" timestamp with time zone,
	"outcome_summary" text,
	"inspection_context" jsonb,
	"ordinal" integer DEFAULT 1 NOT NULL,
	"reopen_allowed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "build_browser_session_owner_ordinal_key" UNIQUE("turn_id","owner_id","ordinal"),
	CONSTRAINT "build_browser_session_agent_session_id_check" CHECK (("factory"."build_browser_session"."agent_session_id" ~~ 'ses%'::text) AND (length("factory"."build_browser_session"."agent_session_id") <= 200)),
	CONSTRAINT "build_browser_session_check" CHECK (("factory"."build_browser_session"."inspection_context" IS NULL) OR (((jsonb_typeof("factory"."build_browser_session"."inspection_context") = 'object'::text) AND (octet_length(("factory"."build_browser_session"."inspection_context")::text) <= 2048) AND (("factory"."build_browser_session"."inspection_context" ->> 'sessionId'::text) = ("factory"."build_browser_session"."id")::text) AND (("factory"."build_browser_session"."inspection_context" ->> 'turnId'::text) = ("factory"."build_browser_session"."turn_id")::text) AND (("factory"."build_browser_session"."inspection_context" ->> 'changeId'::text) = ("factory"."build_browser_session"."change_id")::text) AND (("factory"."build_browser_session"."inspection_context" ->> 'runtimeAttemptId'::text) = ("factory"."build_browser_session"."runtime_attempt_id")::text) AND ((("factory"."build_browser_session"."inspection_context" ->> 'generation'::text))::bigint = "factory"."build_browser_session"."generation") AND (("factory"."build_browser_session"."inspection_context" ->> 'headCommit'::text) ~ '^[a-f0-9]{40}$'::text) AND (("factory"."build_browser_session"."inspection_context" ->> 'app'::text) ~ '^[a-z][a-z0-9-]{0,31}$'::text) AND (jsonb_typeof(("factory"."build_browser_session"."inspection_context" -> 'workingTreeModified'::text)) = 'boolean'::text)) IS TRUE)),
	CONSTRAINT "build_browser_session_check1" CHECK (("factory"."build_browser_session"."state" <> 'active'::text) OR ("factory"."build_browser_session"."create_confirmed_at" IS NOT NULL)),
	CONSTRAINT "build_browser_session_check2" CHECK (("factory"."build_browser_session"."state" <> 'active'::text) OR ("factory"."build_browser_session"."inspection_context" IS NOT NULL)),
	CONSTRAINT "build_browser_session_check3" CHECK (("factory"."build_browser_session"."state" = ANY (ARRAY['closing'::text, 'closed'::text])) = ("factory"."build_browser_session"."cleanup_intended_at" IS NOT NULL)),
	CONSTRAINT "build_browser_session_check4" CHECK (("factory"."build_browser_session"."state" = 'closed'::text) = ("factory"."build_browser_session"."cleanup_confirmed_at" IS NOT NULL)),
	CONSTRAINT "build_browser_session_generation_check" CHECK ("factory"."build_browser_session"."generation" > 0),
	CONSTRAINT "build_browser_session_ordinal_check" CHECK ("factory"."build_browser_session"."ordinal" > 0),
	CONSTRAINT "build_browser_session_outcome_summary_check" CHECK (octet_length("factory"."build_browser_session"."outcome_summary") <= 512),
	CONSTRAINT "build_browser_session_owner_id_check" CHECK ("factory"."build_browser_session"."owner_id" ~ '^[a-f0-9]{64}$'::text),
	CONSTRAINT "build_browser_session_state_check" CHECK ("factory"."build_browser_session"."state" = ANY (ARRAY['intended'::text, 'active'::text, 'closing'::text, 'closed'::text]))
);

CREATE TABLE "factory"."candidate_review" (
	"id" uuid PRIMARY KEY NOT NULL,
	"verification_id" uuid NOT NULL,
	"ordinal" integer DEFAULT 1 NOT NULL,
	"supersedes_id" uuid,
	"finding_source_id" uuid,
	"focus_review_id" uuid,
	"finding_checks" jsonb,
	"change_id" uuid NOT NULL,
	"commit_sha" text NOT NULL,
	"base_sha" text NOT NULL,
	"created_by" uuid NOT NULL,
	"turn_id" uuid,
	"state" text DEFAULT 'pending' NOT NULL,
	"ui_required" boolean DEFAULT false NOT NULL,
	"result" jsonb,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repair_command_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"repair_prompted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "candidate_review_id_change_id_verification_id_commit_sha_key" UNIQUE("id","change_id","verification_id","commit_sha"),
	CONSTRAINT "candidate_review_verification_id_ordinal_key" UNIQUE("verification_id","ordinal"),
	CONSTRAINT "candidate_review_supersedes_id_key" UNIQUE("supersedes_id"),
	CONSTRAINT "candidate_review_turn_id_key" UNIQUE("turn_id"),
	CONSTRAINT "candidate_review_repair_command_id_key" UNIQUE("repair_command_id"),
	CONSTRAINT "candidate_review_commit_sha_check" CHECK ("factory"."candidate_review"."commit_sha" ~ '^[a-f0-9]{40}$'::text),
	CONSTRAINT "candidate_review_base_sha_check" CHECK ("factory"."candidate_review"."base_sha" ~ '^[a-f0-9]{40}$'::text),
	CONSTRAINT "candidate_review_check" CHECK (("factory"."candidate_review"."state" <> ALL (ARRAY['passed'::text, 'changes-requested'::text])) OR ("factory"."candidate_review"."result" IS NOT NULL)),
	CONSTRAINT "candidate_review_evidence_check" CHECK ((jsonb_typeof("factory"."candidate_review"."evidence") = 'array'::text) AND (jsonb_array_length("factory"."candidate_review"."evidence") <= 256)),
	CONSTRAINT "candidate_review_finding_checks_check" CHECK (("factory"."candidate_review"."finding_checks" IS NULL) OR (("factory"."candidate_review"."finding_source_id" IS NOT NULL) AND (jsonb_typeof("factory"."candidate_review"."finding_checks") = 'object'::text) AND (octet_length(("factory"."candidate_review"."finding_checks")::text) <= 32768))),
	CONSTRAINT "candidate_review_ordinal_check" CHECK ("factory"."candidate_review"."ordinal" > 0),
	CONSTRAINT "candidate_review_result_check" CHECK (("factory"."candidate_review"."result" IS NULL) OR ((jsonb_typeof("factory"."candidate_review"."result") = 'object'::text) AND (octet_length(("factory"."candidate_review"."result")::text) <= 32768))),
	CONSTRAINT "candidate_review_state_check" CHECK ("factory"."candidate_review"."state" = ANY (ARRAY['pending'::text, 'running'::text, 'passed'::text, 'changes-requested'::text, 'incomplete'::text]))
);

CREATE TABLE "factory"."change" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"requirement_approval_id" uuid NOT NULL,
	"branch_name" text NOT NULL,
	"base_sha" text NOT NULL,
	"state" "factory"."change_state" NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"failure" text,
	"runtime_attempt_id" uuid,
	"delivery_waiting_sha" text,
	"delivery_waiting_policy_id" uuid,
	CONSTRAINT "change_id_branch_name_base_sha_key" UNIQUE("id","branch_name","base_sha"),
	CONSTRAINT "change_id_project_id_base_sha_key" UNIQUE("id","project_id","base_sha"),
	CONSTRAINT "change_id_project_id_key" UNIQUE("id","project_id"),
	CONSTRAINT "change_id_ticket_id_key" UNIQUE("id","ticket_id"),
	CONSTRAINT "change_project_id_branch_name_key" UNIQUE("project_id","branch_name"),
	CONSTRAINT "change_requirement_approval_id_key" UNIQUE("requirement_approval_id"),
	CONSTRAINT "change_runtime_attempt_id_key" UNIQUE("runtime_attempt_id"),
	CONSTRAINT "change_base_sha_check" CHECK ("factory"."change"."base_sha" ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text),
	CONSTRAINT "change_branch_name_check" CHECK ("factory"."change"."branch_name" ~ '^factory/change-[0-9a-f]{12}$'::text),
	CONSTRAINT "change_check" CHECK (("factory"."change"."state" = 'cancelled'::change_state) = ("factory"."change"."cancelled_at" IS NOT NULL)),
	CONSTRAINT "change_version_check" CHECK ("factory"."change"."version" > 0)
);

CREATE TABLE "factory"."change_agent_session" (
	"change_id" uuid PRIMARY KEY NOT NULL,
	"runtime_attempt_id" uuid NOT NULL,
	"opencode_session_id" text,
	"state" "factory"."change_agent_state" NOT NULL,
	"active_inbox_id" text,
	"last_error" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active_turn_id" uuid,
	"stop_pending" boolean DEFAULT false NOT NULL,
	"stop_dispatched" boolean DEFAULT false NOT NULL,
	"stop_id" uuid,
	"stop_turn_id" uuid,
	"native_session_confirmed_at" timestamp with time zone,
	"implementation_session_id" text,
	"implementation_session_confirmed_at" timestamp with time zone,
	CONSTRAINT "change_agent_implementation_confirmation" CHECK (("factory"."change_agent_session"."implementation_session_confirmed_at" IS NULL) OR ("factory"."change_agent_session"."implementation_session_id" IS NOT NULL)),
	CONSTRAINT "change_agent_native_session_confirmation" CHECK (("factory"."change_agent_session"."native_session_confirmed_at" IS NULL) OR ("factory"."change_agent_session"."opencode_session_id" IS NOT NULL)),
	CONSTRAINT "change_agent_session_active_inbox_id_check" CHECK (length(COALESCE("factory"."change_agent_session"."active_inbox_id", ''::text)) <= 200),
	CONSTRAINT "change_agent_session_check" CHECK (("factory"."change_agent_session"."state" <> 'starting'::change_agent_state) OR ("factory"."change_agent_session"."opencode_session_id" IS NULL) OR (length("factory"."change_agent_session"."opencode_session_id") > 0)),
	CONSTRAINT "change_agent_session_opencode_session_id_check" CHECK (length(COALESCE("factory"."change_agent_session"."opencode_session_id", ''::text)) <= 200),
	CONSTRAINT "change_agent_stop_dispatch_state" CHECK ((NOT "factory"."change_agent_session"."stop_dispatched") OR "factory"."change_agent_session"."stop_pending"),
	CONSTRAINT "change_agent_stop_pending_state" CHECK ((NOT "factory"."change_agent_session"."stop_pending") OR ("factory"."change_agent_session"."state" = 'stopped'::change_agent_state))
);

CREATE TABLE "factory"."change_agent_turn_intent" (
	"turn_id" uuid PRIMARY KEY NOT NULL,
	"change_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"prompt_id" text NOT NULL,
	"prompt_text" text NOT NULL,
	"bootstrap" boolean NOT NULL,
	"session_title" text NOT NULL,
	"runtime_attempt_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"skill_manifest" jsonb,
	"skill_attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model_request_epoch" bigint DEFAULT 0 NOT NULL,
	"terminal_outcome" jsonb,
	CONSTRAINT "change_agent_turn_intent_prompt_id_key" UNIQUE("prompt_id"),
	CONSTRAINT "change_agent_turn_intent_model_epoch_check" CHECK ("factory"."change_agent_turn_intent"."model_request_epoch" >= 0),
	CONSTRAINT "change_agent_turn_intent_terminal_check" CHECK (("factory"."change_agent_turn_intent"."terminal_outcome" IS NULL) OR ((jsonb_typeof("factory"."change_agent_turn_intent"."terminal_outcome") = 'object'::text) AND (octet_length(("factory"."change_agent_turn_intent"."terminal_outcome")::text) <= 8192) AND ("factory"."change_agent_turn_intent"."terminal_outcome" ?& ARRAY['version'::text, 'turnID'::text, 'attemptID'::text, 'sessionID'::text, 'promptID'::text, 'promptDigest'::text, 'assistantID'::text, 'assistantDigest'::text, 'completed'::text, 'modelRequestEpoch'::text, 'shells'::text, 'outcome'::text]) AND (("factory"."change_agent_turn_intent"."terminal_outcome" - ARRAY['version'::text, 'turnID'::text, 'attemptID'::text, 'sessionID'::text, 'promptID'::text, 'promptDigest'::text, 'assistantID'::text, 'assistantDigest'::text, 'completed'::text, 'modelRequestEpoch'::text, 'shells'::text, 'outcome'::text]) = '{}'::jsonb) AND (("factory"."change_agent_turn_intent"."terminal_outcome" ->> 'version'::text) = '1'::text) AND (jsonb_typeof(("factory"."change_agent_turn_intent"."terminal_outcome" -> 'version'::text)) = 'number'::text) AND (jsonb_typeof(("factory"."change_agent_turn_intent"."terminal_outcome" -> 'turnID'::text)) = 'string'::text) AND (jsonb_typeof(("factory"."change_agent_turn_intent"."terminal_outcome" -> 'attemptID'::text)) = 'string'::text) AND (jsonb_typeof(("factory"."change_agent_turn_intent"."terminal_outcome" -> 'sessionID'::text)) = 'string'::text) AND (jsonb_typeof(("factory"."change_agent_turn_intent"."terminal_outcome" -> 'promptID'::text)) = 'string'::text) AND (jsonb_typeof(("factory"."change_agent_turn_intent"."terminal_outcome" -> 'promptDigest'::text)) = 'string'::text) AND (jsonb_typeof(("factory"."change_agent_turn_intent"."terminal_outcome" -> 'assistantID'::text)) = 'string'::text) AND (jsonb_typeof(("factory"."change_agent_turn_intent"."terminal_outcome" -> 'assistantDigest'::text)) = 'string'::text) AND (jsonb_typeof(("factory"."change_agent_turn_intent"."terminal_outcome" -> 'modelRequestEpoch'::text)) = 'string'::text) AND (("factory"."change_agent_turn_intent"."terminal_outcome" ->> 'turnID'::text) = ("factory"."change_agent_turn_intent"."turn_id")::text) AND ("factory"."change_agent_turn_intent"."runtime_attempt_id" IS NOT NULL) AND (("factory"."change_agent_turn_intent"."terminal_outcome" ->> 'attemptID'::text) = ("factory"."change_agent_turn_intent"."runtime_attempt_id")::text) AND (("factory"."change_agent_turn_intent"."terminal_outcome" ->> 'sessionID'::text) = "factory"."change_agent_turn_intent"."session_id") AND (("factory"."change_agent_turn_intent"."terminal_outcome" ->> 'promptID'::text) = "factory"."change_agent_turn_intent"."prompt_id") AND (("factory"."change_agent_turn_intent"."terminal_outcome" ->> 'modelRequestEpoch'::text) = ("factory"."change_agent_turn_intent"."model_request_epoch")::text) AND (("factory"."change_agent_turn_intent"."terminal_outcome" ->> 'promptDigest'::text) ~ '^[a-f0-9]{64}$'::text) AND (("factory"."change_agent_turn_intent"."terminal_outcome" ->> 'assistantDigest'::text) ~ '^[a-f0-9]{64}$'::text) AND (("factory"."change_agent_turn_intent"."terminal_outcome" ->> 'assistantID'::text) ~~ 'msg_%'::text) AND (length(("factory"."change_agent_turn_intent"."terminal_outcome" ->> 'assistantID'::text)) <= 200) AND (jsonb_typeof(("factory"."change_agent_turn_intent"."terminal_outcome" -> 'completed'::text)) = 'number'::text) AND (((("factory"."change_agent_turn_intent"."terminal_outcome" ->> 'completed'::text))::numeric >= (1)::numeric) AND ((("factory"."change_agent_turn_intent"."terminal_outcome" ->> 'completed'::text))::numeric <= ('9007199254740991'::bigint)::numeric)) AND (jsonb_typeof(("factory"."change_agent_turn_intent"."terminal_outcome" -> 'shells'::text)) = 'array'::text) AND (jsonb_typeof(("factory"."change_agent_turn_intent"."terminal_outcome" -> 'outcome'::text)) = 'object'::text) AND (jsonb_typeof((("factory"."change_agent_turn_intent"."terminal_outcome" -> 'outcome'::text) -> 'state'::text)) = 'string'::text) AND (("factory"."change_agent_turn_intent"."terminal_outcome" -> 'outcome'::text) ? 'state'::text) AND ((("factory"."change_agent_turn_intent"."terminal_outcome" -> 'outcome'::text) - ARRAY['state'::text, 'summary'::text, 'error'::text]) = '{}'::jsonb) AND ((((("factory"."change_agent_turn_intent"."terminal_outcome" -> 'outcome'::text) ->> 'state'::text) = 'succeeded'::text) AND (NOT (("factory"."change_agent_turn_intent"."terminal_outcome" -> 'outcome'::text) ? 'error'::text)) AND ((NOT (("factory"."change_agent_turn_intent"."terminal_outcome" -> 'outcome'::text) ? 'summary'::text)) OR ((jsonb_typeof((("factory"."change_agent_turn_intent"."terminal_outcome" -> 'outcome'::text) -> 'summary'::text)) = 'string'::text) AND (length((("factory"."change_agent_turn_intent"."terminal_outcome" -> 'outcome'::text) ->> 'summary'::text)) <= 2000)))) OR (((("factory"."change_agent_turn_intent"."terminal_outcome" -> 'outcome'::text) ->> 'state'::text) = 'failed'::text) AND (("factory"."change_agent_turn_intent"."terminal_outcome" -> 'outcome'::text) ? 'error'::text) AND (NOT (("factory"."change_agent_turn_intent"."terminal_outcome" -> 'outcome'::text) ? 'summary'::text)) AND (jsonb_typeof((("factory"."change_agent_turn_intent"."terminal_outcome" -> 'outcome'::text) -> 'error'::text)) = 'string'::text) AND (length((("factory"."change_agent_turn_intent"."terminal_outcome" -> 'outcome'::text) ->> 'error'::text)) <= 2000))))),
	CONSTRAINT "change_agent_turn_intent_prompt_id_check" CHECK (("factory"."change_agent_turn_intent"."prompt_id" ~~ 'msg_%'::text) AND (length("factory"."change_agent_turn_intent"."prompt_id") <= 200)),
	CONSTRAINT "change_agent_turn_intent_prompt_text_check" CHECK ((length(btrim("factory"."change_agent_turn_intent"."prompt_text")) > 0) AND (octet_length("factory"."change_agent_turn_intent"."prompt_text") <= 4000000)),
	CONSTRAINT "change_agent_turn_intent_session_id_check" CHECK (("factory"."change_agent_turn_intent"."session_id" ~~ 'ses%'::text) AND (length("factory"."change_agent_turn_intent"."session_id") <= 200)),
	CONSTRAINT "change_agent_turn_intent_session_title_check" CHECK ((length("factory"."change_agent_turn_intent"."session_title") >= 1) AND (length("factory"."change_agent_turn_intent"."session_title") <= 200))
);

CREATE TABLE "factory"."change_commit_operation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"change_id" uuid NOT NULL,
	"runtime_attempt_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"branch_name" text NOT NULL,
	"expected_parent_sha" text NOT NULL,
	"integration_base_sha" text,
	"is_merge" boolean DEFAULT false NOT NULL,
	"commit_sha" text,
	"observed_remote_sha" text,
	"commit_message" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" "factory"."change_commit_state" NOT NULL,
	"last_error" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"source" "factory"."change_commit_source" DEFAULT 'agent' NOT NULL,
	CONSTRAINT "change_commit_operation_change_id_sequence_key" UNIQUE("change_id","sequence"),
	CONSTRAINT "change_commit_operation_idempotency_key_key" UNIQUE("idempotency_key"),
	CONSTRAINT "change_commit_operation_expected_parent_sha_check" CHECK ("factory"."change_commit_operation"."expected_parent_sha" ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text),
	CONSTRAINT "change_commit_integration_base" CHECK (("factory"."change_commit_operation"."integration_base_sha" IS NULL) OR ("factory"."change_commit_operation"."integration_base_sha" ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text)),
	CONSTRAINT "change_commit_is_merge" CHECK ((NOT "factory"."change_commit_operation"."is_merge") OR (("factory"."change_commit_operation"."integration_base_sha" IS NOT NULL) AND ("factory"."change_commit_operation"."integration_base_sha" <> "factory"."change_commit_operation"."expected_parent_sha"))),
	CONSTRAINT "change_commit_operation_check" CHECK (("factory"."change_commit_operation"."state" = ANY (ARRAY['succeeded'::change_commit_state, 'failed'::change_commit_state])) = ("factory"."change_commit_operation"."completed_at" IS NOT NULL)),
	CONSTRAINT "change_commit_operation_check2" CHECK (("factory"."change_commit_operation"."state" <> 'succeeded'::change_commit_state) OR ("factory"."change_commit_operation"."observed_remote_sha" = "factory"."change_commit_operation"."commit_sha")),
	CONSTRAINT "change_commit_operation_commit_message_check" CHECK ((length(btrim("factory"."change_commit_operation"."commit_message")) >= 1) AND (length(btrim("factory"."change_commit_operation"."commit_message")) <= 240)),
	CONSTRAINT "change_commit_operation_commit_presence_check" CHECK (("factory"."change_commit_operation"."state" <> ALL (ARRAY['committed'::change_commit_state, 'push-intended'::change_commit_state, 'succeeded'::change_commit_state])) OR ("factory"."change_commit_operation"."commit_sha" IS NOT NULL)),
	CONSTRAINT "change_commit_operation_commit_sha_check" CHECK (("factory"."change_commit_operation"."commit_sha" IS NULL) OR ("factory"."change_commit_operation"."commit_sha" ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text)),
	CONSTRAINT "change_commit_operation_observed_remote_sha_check" CHECK (("factory"."change_commit_operation"."observed_remote_sha" IS NULL) OR ("factory"."change_commit_operation"."observed_remote_sha" ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text)),
	CONSTRAINT "change_commit_operation_sequence_check" CHECK ("factory"."change_commit_operation"."sequence" > 0),
	CONSTRAINT "change_commit_operation_source_check" CHECK ((("factory"."change_commit_operation"."source")::text = ANY (ARRAY['agent'::text, 'integration'::text, 'workspace'::text])) AND ("factory"."change_commit_operation"."runtime_attempt_id" IS NOT NULL))
);

CREATE TABLE "factory"."change_writer" (
	"change_id" uuid PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'unassigned' NOT NULL,
	"epoch" bigint DEFAULT 1 NOT NULL,
	"user_id" uuid,
	"turn_id" uuid,
	"fence_attempt_id" uuid,
	"fence_required" boolean DEFAULT false NOT NULL,
	"requested_by" uuid,
	"request_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"handoff_kind" text DEFAULT 'takeover' NOT NULL,
	CONSTRAINT "change_writer_check" CHECK (("factory"."change_writer"."state" = 'human'::text) = ("factory"."change_writer"."user_id" IS NOT NULL)),
	CONSTRAINT "change_writer_check1" CHECK (("factory"."change_writer"."state" = ANY (ARRAY['agent-preparing'::text, 'agent'::text])) = ("factory"."change_writer"."turn_id" IS NOT NULL)),
	CONSTRAINT "change_writer_check2" CHECK (("factory"."change_writer"."state" = 'handoff'::text) = (("factory"."change_writer"."requested_by" IS NOT NULL) AND ("factory"."change_writer"."request_id" IS NOT NULL))),
	CONSTRAINT "change_writer_epoch_check" CHECK ("factory"."change_writer"."epoch" > 0),
	CONSTRAINT "change_writer_handoff_kind_check" CHECK ("factory"."change_writer"."handoff_kind" = ANY (ARRAY['takeover'::text, 'release'::text])),
	CONSTRAINT "change_writer_state_check" CHECK ("factory"."change_writer"."state" = ANY (ARRAY['unassigned'::text, 'agent-preparing'::text, 'agent'::text, 'handoff'::text, 'human'::text]))
);

CREATE TABLE "factory"."conversation_context" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"mode" "factory"."conversation_mode" DEFAULT 'investigate' NOT NULL,
	"ordinal" integer NOT NULL,
	"title" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"change_id" uuid,
	"native_session_id" text,
	"previous_context_id" uuid,
	"original" boolean DEFAULT false NOT NULL,
	"archived_session" jsonb,
	"transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "conversation_context_conversation_id_ordinal_key" UNIQUE("conversation_id","ordinal"),
	CONSTRAINT "conversation_context_command_id_key" UNIQUE("command_id"),
	CONSTRAINT "conversation_context_check" CHECK (("factory"."conversation_context"."kind" = 'coding'::text) = ("factory"."conversation_context"."change_id" IS NOT NULL)),
	CONSTRAINT "conversation_context_check1" CHECK (("factory"."conversation_context"."kind" = 'coding'::text) = ("factory"."conversation_context"."mode" = 'build'::conversation_mode)),
	CONSTRAINT "conversation_context_check2" CHECK (("factory"."conversation_context"."kind" = 'coding'::text) OR (("factory"."conversation_context"."native_session_id" IS NULL) AND ("factory"."conversation_context"."archived_session" IS NULL) AND (NOT "factory"."conversation_context"."original"))),
	CONSTRAINT "conversation_context_kind_check" CHECK ("factory"."conversation_context"."kind" = ANY (ARRAY['research'::text, 'coding'::text])),
	CONSTRAINT "conversation_context_ordinal_check" CHECK ("factory"."conversation_context"."ordinal" > 0),
	CONSTRAINT "conversation_context_title_check" CHECK ((length("factory"."conversation_context"."title") >= 1) AND (length("factory"."conversation_context"."title") <= 200))
);

CREATE TABLE "factory"."conversation_entry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"ordinal" bigint NOT NULL,
	"kind" "factory"."conversation_entry_kind" NOT NULL,
	"actor" "factory"."conversation_actor" NOT NULL,
	"mode" "factory"."conversation_mode" NOT NULL,
	"body" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"in_reply_to_entry_id" uuid,
	"requirement_revision_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_entry_conversation_id_ordinal_key" UNIQUE("conversation_id","ordinal"),
	CONSTRAINT "conversation_entry_body_check" CHECK (length("factory"."conversation_entry"."body") <= 12000),
	CONSTRAINT "conversation_entry_ordinal_check" CHECK ("factory"."conversation_entry"."ordinal" > 0)
);

CREATE TABLE "factory"."delivery_approval" (
	"id" uuid PRIMARY KEY NOT NULL,
	"change_id" uuid NOT NULL,
	"verification_id" uuid NOT NULL,
	"commit_sha" text NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"candidate_review_id" uuid,
	"monitoring_incident_id" uuid,
	"monitoring_policy_id" uuid,
	"delivery_policy_id" uuid,
	CONSTRAINT "delivery_approval_exact_basis_key" UNIQUE NULLS NOT DISTINCT("verification_id","candidate_review_id","approved_by","monitoring_policy_id","delivery_policy_id"),
	CONSTRAINT "delivery_approval_commit_sha_check" CHECK ("factory"."delivery_approval"."commit_sha" ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text),
	CONSTRAINT "delivery_monitoring_basis" CHECK (("factory"."delivery_approval"."monitoring_incident_id" IS NULL) = ("factory"."delivery_approval"."monitoring_policy_id" IS NULL)),
	CONSTRAINT "delivery_one_delegation" CHECK (("factory"."delivery_approval"."delivery_policy_id" IS NULL) OR ("factory"."delivery_approval"."monitoring_policy_id" IS NULL))
);

CREATE TABLE "factory"."development_workspace" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "factory"."development_workspace_kind" NOT NULL,
	"owner_user_id" uuid,
	"ticket_id" uuid,
	"change_id" uuid,
	"source_branch" text NOT NULL,
	"source_revision" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"collaboration_enabled" boolean DEFAULT false NOT NULL,
	CONSTRAINT "development_workspace_id_change_id_key" UNIQUE("id","change_id"),
	CONSTRAINT "development_workspace_id_project_id_key" UNIQUE("id","project_id"),
	CONSTRAINT "development_workspace_check" CHECK ((("factory"."development_workspace"."kind" = 'personal'::development_workspace_kind) AND ("factory"."development_workspace"."owner_user_id" IS NOT NULL) AND ("factory"."development_workspace"."ticket_id" IS NULL) AND ("factory"."development_workspace"."change_id" IS NULL)) OR (("factory"."development_workspace"."kind" = 'ticket'::development_workspace_kind) AND ("factory"."development_workspace"."owner_user_id" IS NULL) AND ("factory"."development_workspace"."ticket_id" IS NOT NULL) AND ("factory"."development_workspace"."change_id" IS NOT NULL))),
	CONSTRAINT "development_workspace_source_branch_check" CHECK ((length("factory"."development_workspace"."source_branch") >= 1) AND (length("factory"."development_workspace"."source_branch") <= 200)),
	CONSTRAINT "development_workspace_source_revision_check" CHECK ("factory"."development_workspace"."source_revision" ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text)
);

CREATE TABLE "factory"."epic" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"parent_id" uuid,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "epic_id_project_id_key" UNIQUE("id","project_id"),
	CONSTRAINT "epic_check" CHECK ("factory"."epic"."parent_id" IS DISTINCT FROM "factory"."epic"."id"),
	CONSTRAINT "epic_description_check" CHECK (length("factory"."epic"."description") <= 10000),
	CONSTRAINT "epic_title_check" CHECK ((length(btrim("factory"."epic"."title")) >= 1) AND (length(btrim("factory"."epic"."title")) <= 200)),
	CONSTRAINT "epic_version_check" CHECK ("factory"."epic"."version" > 0)
);

CREATE TABLE "factory"."execution_policy" (
	"scope" text PRIMARY KEY NOT NULL,
	"version" bigint NOT NULL,
	"policy" jsonb NOT NULL,
	"timezone" text,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_policy_check" CHECK (("factory"."execution_policy"."scope" = 'factory'::text) OR ("factory"."execution_policy"."timezone" IS NULL)),
	CONSTRAINT "execution_policy_policy_check" CHECK (jsonb_typeof("factory"."execution_policy"."policy") = 'object'::text),
	CONSTRAINT "execution_policy_scope_check" CHECK (("factory"."execution_policy"."scope" = 'factory'::text) OR ("factory"."execution_policy"."scope" ~ '^[0-9a-f-]{36}$'::text)),
	CONSTRAINT "execution_policy_version_check" CHECK ("factory"."execution_policy"."version" >= 1)
);

CREATE TABLE "auth"."jwks" (
	"id" text PRIMARY KEY NOT NULL,
	"publicKey" text NOT NULL,
	"privateKey" text NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"expiresAt" timestamp with time zone,
	"alg" text,
	"crv" text
);

CREATE TABLE "factory"."knowledge_page" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"state" "factory"."knowledge_page_state" DEFAULT 'active' NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"current_revision_id" uuid,
	"current_body" text NOT NULL,
	"generated_body" text NOT NULL,
	"source_commit_sha" text NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parent_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"icon" text DEFAULT 'knowledge' NOT NULL,
	"metadata_version" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "knowledge_page_id_project_id_key" UNIQUE("id","project_id"),
	CONSTRAINT "knowledge_page_project_identity" UNIQUE("project_id","id"),
	CONSTRAINT "knowledge_page_project_id_slug_key" UNIQUE("project_id","slug"),
	CONSTRAINT "knowledge_page_generated_body_check" CHECK ((length("factory"."knowledge_page"."generated_body") >= 1) AND (length("factory"."knowledge_page"."generated_body") <= 120000)),
	CONSTRAINT "knowledge_page_citations_check" CHECK (jsonb_typeof("factory"."knowledge_page"."citations") = 'array'::text),
	CONSTRAINT "knowledge_page_current_body_check" CHECK ((length("factory"."knowledge_page"."current_body") >= 1) AND (length("factory"."knowledge_page"."current_body") <= 120000)),
	CONSTRAINT "knowledge_page_icon_check" CHECK ("factory"."knowledge_page"."icon" = ANY (ARRAY['knowledge'::text, 'home'::text, 'ticket'::text, 'ide'::text, 'preview'::text, 'settings'::text])),
	CONSTRAINT "knowledge_page_metadata_version_check" CHECK ("factory"."knowledge_page"."metadata_version" > 0),
	CONSTRAINT "knowledge_page_not_own_parent" CHECK ("factory"."knowledge_page"."parent_id" IS DISTINCT FROM "factory"."knowledge_page"."id"),
	CONSTRAINT "knowledge_page_slug_check" CHECK ("factory"."knowledge_page"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text),
	CONSTRAINT "knowledge_page_sort_order_check" CHECK ("factory"."knowledge_page"."sort_order" >= 0),
	CONSTRAINT "knowledge_page_source_commit_sha_check" CHECK ("factory"."knowledge_page"."source_commit_sha" ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text),
	CONSTRAINT "knowledge_page_title_check" CHECK ((length(btrim("factory"."knowledge_page"."title")) >= 1) AND (length(btrim("factory"."knowledge_page"."title")) <= 200)),
	CONSTRAINT "knowledge_page_version_check" CHECK ("factory"."knowledge_page"."version" > 0)
);

CREATE TABLE "factory"."knowledge_page_outline" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"parent_id" uuid,
	"sort_order" integer NOT NULL,
	"icon" text NOT NULL,
	"metadata_version" bigint NOT NULL,
	"state" "factory"."knowledge_page_state" NOT NULL,
	"version" bigint NOT NULL,
	"current_revision_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);

CREATE TABLE "factory"."knowledge_revision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"page_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"kind" "factory"."knowledge_revision_kind" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"generated_body" text NOT NULL,
	"source_commit_sha" text NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generation_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_revision_id_page_id_key" UNIQUE("id","page_id"),
	CONSTRAINT "knowledge_revision_page_id_ordinal_key" UNIQUE("page_id","ordinal"),
	CONSTRAINT "knowledge_revision_body_check" CHECK ((length("factory"."knowledge_revision"."body") >= 1) AND (length("factory"."knowledge_revision"."body") <= 120000)),
	CONSTRAINT "knowledge_revision_citations_check" CHECK (jsonb_typeof("factory"."knowledge_revision"."citations") = 'array'::text),
	CONSTRAINT "knowledge_revision_generated_body_check" CHECK ((length("factory"."knowledge_revision"."generated_body") >= 1) AND (length("factory"."knowledge_revision"."generated_body") <= 120000)),
	CONSTRAINT "knowledge_revision_ordinal_check" CHECK ("factory"."knowledge_revision"."ordinal" > 0),
	CONSTRAINT "knowledge_revision_source_commit_sha_check" CHECK ("factory"."knowledge_revision"."source_commit_sha" ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text),
	CONSTRAINT "knowledge_revision_title_check" CHECK ((length(btrim("factory"."knowledge_revision"."title")) >= 1) AND (length(btrim("factory"."knowledge_revision"."title")) <= 200))
);

CREATE TABLE "factory"."learning_case" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"owner_id" uuid,
	"reviewer_id" uuid NOT NULL,
	"developer_only" boolean NOT NULL,
	"activity" text NOT NULL,
	"outcome" text NOT NULL,
	"settled_at" timestamp with time zone NOT NULL,
	"snapshot" jsonb NOT NULL,
	"selected" boolean NOT NULL,
	"batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learning_case_outcome_check" CHECK ("factory"."learning_case"."outcome" = ANY (ARRAY['completed'::text, 'failed'::text, 'interrupted'::text, 'unknown'::text])),
	CONSTRAINT "learning_case_snapshot_check" CHECK (octet_length(("factory"."learning_case"."snapshot")::text) <= 65536)
);

CREATE TABLE "factory"."learning_proposal" (
	"id" uuid PRIMARY KEY NOT NULL,
	"review_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"content" jsonb NOT NULL,
	"state" text DEFAULT 'proposed' NOT NULL,
	"decision_id" uuid,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"ticket_id" uuid,
	"application" jsonb,
	CONSTRAINT "learning_proposal_review_id_ordinal_key" UNIQUE("review_id","ordinal"),
	CONSTRAINT "learning_proposal_decision_id_key" UNIQUE("decision_id"),
	CONSTRAINT "learning_proposal_content_check" CHECK (octet_length(("factory"."learning_proposal"."content")::text) <= 32000),
	CONSTRAINT "learning_proposal_ordinal_check" CHECK ("factory"."learning_proposal"."ordinal" >= 0),
	CONSTRAINT "learning_proposal_state_check" CHECK ("factory"."learning_proposal"."state" = ANY (ARRAY['proposed'::text, 'dismissed'::text, 'ticket-created'::text, 'applied'::text])),
	CONSTRAINT "learning_proposal_application_check" CHECK ("factory"."learning_proposal"."application" IS NULL OR jsonb_typeof("factory"."learning_proposal"."application") = 'object'::text)
);

CREATE TABLE "factory"."learning_review" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"owner_id" uuid,
	"developer_only" boolean NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"rubric" text NOT NULL,
	"model_id" text NOT NULL,
	"model_connection" jsonb,
	"judge_key" text NOT NULL,
	"state" text NOT NULL,
	"input" jsonb NOT NULL,
	"input_digest" text NOT NULL,
	"result" jsonb,
	"calibrated" boolean,
	"reason" text,
	"owner_token" uuid NOT NULL,
	"owner_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "learning_review_input_check" CHECK (octet_length(("factory"."learning_review"."input")::text) <= 262144),
	CONSTRAINT "learning_review_input_digest_check" CHECK ("factory"."learning_review"."input_digest" ~ '^[a-f0-9]{64}$'::text),
	CONSTRAINT "learning_review_kind_check" CHECK ("factory"."learning_review"."kind" = ANY (ARRAY['calibration'::text, 'work'::text])),
	CONSTRAINT "learning_review_result_check" CHECK (octet_length(("factory"."learning_review"."result")::text) <= 65536),
	CONSTRAINT "learning_review_state_check" CHECK ("factory"."learning_review"."state" = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text, 'uncertain'::text]))
);

CREATE TABLE "factory"."mcp_connection" (
	"id" uuid PRIMARY KEY NOT NULL,
	"revision_id" uuid NOT NULL,
	"state" text NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"secret_key" text,
	"credential_epoch" uuid NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"project_grants" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"authorized_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_connection_state_check" CHECK ("factory"."mcp_connection"."state" = ANY (ARRAY['disconnected'::text, 'authorizing'::text, 'review'::text, 'ready'::text, 'reconnect'::text, 'revoked'::text])),
	CONSTRAINT "mcp_connection_tools_check" CHECK ((jsonb_typeof("factory"."mcp_connection"."tools") = 'array'::text) AND (octet_length(("factory"."mcp_connection"."tools")::text) <= 1000000)),
	CONSTRAINT "mcp_connection_project_grants_check" CHECK (jsonb_typeof("factory"."mcp_connection"."project_grants") = 'object'::text)
);

CREATE TABLE "factory"."mcp_library" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"owner_id" uuid,
	"project_id" uuid,
	"cover_key" text,
	"cover_version" bigint,
	"cover_updated_by" uuid,
	CONSTRAINT "mcp_library_check" CHECK ((("factory"."mcp_library"."scope" = 'personal'::text) AND ("factory"."mcp_library"."owner_id" IS NOT NULL) AND ("factory"."mcp_library"."project_id" IS NULL)) OR (("factory"."mcp_library"."scope" = 'project'::text) AND ("factory"."mcp_library"."owner_id" IS NULL) AND ("factory"."mcp_library"."project_id" IS NOT NULL)) OR (("factory"."mcp_library"."scope" = 'system'::text) AND ("factory"."mcp_library"."owner_id" IS NULL) AND ("factory"."mcp_library"."project_id" IS NULL))),
	CONSTRAINT "mcp_library_scope_check" CHECK ("factory"."mcp_library"."scope" = ANY (ARRAY['personal'::text, 'project'::text, 'system'::text])),
	CONSTRAINT "mcp_library_cover_nulls_check" CHECK (("factory"."mcp_library"."cover_key" IS NULL) = ("factory"."mcp_library"."cover_version" IS NULL AND "factory"."mcp_library"."cover_updated_by" IS NULL)),
	CONSTRAINT "mcp_library_cover_key_check" CHECK ("factory"."mcp_library"."cover_key" IS NULL OR "factory"."mcp_library"."cover_key" ~ '^[a-z][a-z-]{1,63}$'::text),
	CONSTRAINT "mcp_library_cover_version_check" CHECK ("factory"."mcp_library"."cover_version" IS NULL OR "factory"."mcp_library"."cover_version" > 0)
);

CREATE TABLE "factory"."mcp_revision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"library_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"content" jsonb NOT NULL,
	"digest" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_revision_library_id_revision_key" UNIQUE("library_id","revision"),
	CONSTRAINT "mcp_revision_content_check" CHECK ((jsonb_typeof("factory"."mcp_revision"."content") = 'object'::text) AND (octet_length(("factory"."mcp_revision"."content")::text) < 16000)),
	CONSTRAINT "mcp_revision_digest_check" CHECK ("factory"."mcp_revision"."digest" ~ '^[a-f0-9]{64}$'::text),
	CONSTRAINT "mcp_revision_revision_check" CHECK ("factory"."mcp_revision"."revision" > 0)
);

CREATE TABLE "factory"."model_connection_version" (
	"connection_id" uuid NOT NULL,
	"version" bigint NOT NULL,
	"provider" text NOT NULL,
	"endpoint" text NOT NULL,
	"secret_key" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_connection_version_pkey" PRIMARY KEY("connection_id","version"),
	CONSTRAINT "model_connection_version_secret_key_key" UNIQUE("secret_key"),
	CONSTRAINT "model_connection_version_provider_check" CHECK ("factory"."model_connection_version"."provider" = ANY (ARRAY['openai'::text, 'anthropic'::text, 'deepseek'::text])),
	CONSTRAINT "model_connection_version_version_check" CHECK ("factory"."model_connection_version"."version" > 0)
);

CREATE TABLE "factory"."model_settings" (
	"scope_type" text NOT NULL,
	"scope_key" text NOT NULL,
	"project_id" uuid,
	"user_id" uuid,
	"version" bigint DEFAULT 1 NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"connection_id" uuid,
	"connection_version" bigint,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_settings_pkey" PRIMARY KEY("scope_type","scope_key"),
	CONSTRAINT "model_settings_scope_type_check" CHECK ("factory"."model_settings"."scope_type" = ANY (ARRAY['default'::text, 'project'::text, 'personal'::text, 'role_connection'::text])),
	CONSTRAINT "model_settings_version_check" CHECK ("factory"."model_settings"."version" > 0),
	CONSTRAINT "model_settings_settings_check" CHECK (jsonb_typeof("factory"."model_settings"."settings") = 'object'::text),
	CONSTRAINT "model_settings_connection_pair_check" CHECK (("factory"."model_settings"."connection_id" IS NULL) = ("factory"."model_settings"."connection_version" IS NULL)),
	CONSTRAINT "model_settings_role_connection_check" CHECK (("factory"."model_settings"."scope_type" <> 'role_connection'::text) OR (("factory"."model_settings"."scope_key" = ANY (ARRAY['planning'::text, 'build'::text])) AND ("factory"."model_settings"."connection_id" IS NOT NULL))),
	CONSTRAINT "model_settings_project_scope_check" CHECK (("factory"."model_settings"."scope_type" <> 'project'::text) OR (("factory"."model_settings"."project_id" IS NOT NULL) AND ("factory"."model_settings"."user_id" IS NULL))),
	CONSTRAINT "model_settings_personal_scope_check" CHECK (("factory"."model_settings"."scope_type" <> 'personal'::text) OR (("factory"."model_settings"."project_id" IS NOT NULL) AND ("factory"."model_settings"."user_id" IS NOT NULL))),
	CONSTRAINT "model_settings_default_scope_check" CHECK (("factory"."model_settings"."scope_type" <> 'default'::text) OR (("factory"."model_settings"."scope_key" = 'default'::text) AND ("factory"."model_settings"."project_id" IS NULL) AND ("factory"."model_settings"."user_id" IS NULL)))
);

CREATE TABLE "factory"."monitoring_hook" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" bigint NOT NULL,
	"enabled" boolean NOT NULL,
	"secret_digest" text NOT NULL,
	"policy_id" uuid NOT NULL,
	"received_window" timestamp with time zone DEFAULT now() NOT NULL,
	"received_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "monitoring_hook_name_check" CHECK ((length("factory"."monitoring_hook"."name") >= 1) AND (length("factory"."monitoring_hook"."name") <= 100)),
	CONSTRAINT "monitoring_hook_secret_digest_check" CHECK ("factory"."monitoring_hook"."secret_digest" ~ '^[a-f0-9]{64}$'::text),
	CONSTRAINT "monitoring_hook_version_check" CHECK ("factory"."monitoring_hook"."version" > 0)
);

CREATE TABLE "factory"."monitoring_incident" (
	"id" uuid PRIMARY KEY NOT NULL,
	"hook_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"hook_version" bigint NOT NULL,
	"fingerprint" text NOT NULL,
	"payload_digest" text NOT NULL,
	"title" text NOT NULL,
	"reference" text,
	"context" text NOT NULL,
	"occurrences" bigint DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"reason" text,
	"diagnosis" jsonb,
	"model_id" text,
	"model_connection" jsonb,
	"owner_token" uuid,
	"owner_expires_at" timestamp with time zone,
	"ticket_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"skill_assignment" jsonb,
	CONSTRAINT "monitoring_incident_hook_id_fingerprint_key" UNIQUE("hook_id","fingerprint"),
	CONSTRAINT "monitoring_incident_context_check" CHECK (octet_length("factory"."monitoring_incident"."context") <= 64000),
	CONSTRAINT "monitoring_incident_fingerprint_check" CHECK ("factory"."monitoring_incident"."fingerprint" ~ '^[a-f0-9]{64}$'::text),
	CONSTRAINT "monitoring_incident_occurrences_check" CHECK ("factory"."monitoring_incident"."occurrences" > 0),
	CONSTRAINT "monitoring_incident_payload_digest_check" CHECK ("factory"."monitoring_incident"."payload_digest" ~ '^[a-f0-9]{64}$'::text),
	CONSTRAINT "monitoring_incident_state_check" CHECK ("factory"."monitoring_incident"."state" = ANY (ARRAY['queued'::text, 'diagnosing'::text, 'insufficient-context'::text, 'not-application-defect'::text, 'prepared'::text, 'implementing'::text, 'delivered'::text, 'blocked'::text, 'uncertain'::text]))
);

CREATE TABLE "factory"."monitoring_policy" (
	"id" uuid PRIMARY KEY NOT NULL,
	"hook_id" uuid NOT NULL,
	"delegated_by" uuid NOT NULL,
	"delegation" text NOT NULL,
	"instructions" text,
	"source_ids" uuid[] DEFAULT '{}' NOT NULL,
	"source_assignments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "monitoring_policy_delegation_check" CHECK ("factory"."monitoring_policy"."delegation" = ANY (ARRAY['prepare-ticket'::text, 'application-fix-and-delivery'::text])),
	CONSTRAINT "monitoring_policy_instructions_check" CHECK ((length("factory"."monitoring_policy"."instructions") >= 1) AND (length("factory"."monitoring_policy"."instructions") <= 6000))
);

CREATE TABLE "auth"."oauthAccessToken" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text,
	"clientId" text NOT NULL,
	"sessionId" uuid,
	"userId" uuid,
	"referenceId" text,
	"authorizationCodeId" text,
	"resources" text[],
	"requestedUserInfoClaims" text[],
	"refreshId" text,
	"expiresAt" timestamp with time zone,
	"createdAt" timestamp with time zone,
	"revoked" timestamp with time zone,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL,
	CONSTRAINT "oauthAccessToken_token_key" UNIQUE("token")
);

CREATE TABLE "auth"."oauthClient" (
	"id" text PRIMARY KEY NOT NULL,
	"clientId" text NOT NULL,
	"clientSecret" text,
	"clientDiscoveryId" text,
	"disabled" boolean DEFAULT false,
	"skipConsent" boolean,
	"enableEndSession" boolean,
	"subjectType" text,
	"scopes" text[],
	"clientCredentialsScopes" text[] DEFAULT '{}',
	"userId" uuid,
	"createdAt" timestamp with time zone,
	"updatedAt" timestamp with time zone,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" text[],
	"tos" text,
	"policy" text,
	"softwareId" text,
	"softwareVersion" text,
	"softwareStatement" text,
	"redirectUris" text[] NOT NULL,
	"postLogoutRedirectUris" text[],
	"backchannelLogoutUri" text,
	"backchannelLogoutSessionRequired" boolean,
	"tokenEndpointAuthMethod" text,
	"applicationType" text,
	"jwks" text,
	"jwksUri" text,
	"grantTypes" text[],
	"responseTypes" text[],
	"requirePKCE" boolean,
	"dpopBoundAccessTokens" boolean DEFAULT false,
	"referenceId" text,
	"metadata" jsonb,
	CONSTRAINT "oauthClient_clientId_key" UNIQUE("clientId")
);

CREATE TABLE "auth"."oauthClientAssertion" (
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL
);

CREATE TABLE "auth"."oauthClientResource" (
	"id" text PRIMARY KEY NOT NULL,
	"clientId" text NOT NULL,
	"resourceId" text NOT NULL,
	"metadata" jsonb,
	"createdAt" timestamp with time zone
);

CREATE TABLE "auth"."oauthConsent" (
	"id" text PRIMARY KEY NOT NULL,
	"clientId" text NOT NULL,
	"userId" uuid,
	"referenceId" text,
	"resources" text[],
	"requestedUserInfoClaims" text[],
	"scopes" text[] NOT NULL,
	"createdAt" timestamp with time zone,
	"updatedAt" timestamp with time zone
);

CREATE TABLE "auth"."oauthRefreshToken" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"clientId" text NOT NULL,
	"sessionId" uuid,
	"userId" uuid NOT NULL,
	"referenceId" text,
	"authorizationCodeId" text,
	"resources" text[],
	"requestedUserInfoClaims" text[],
	"expiresAt" timestamp with time zone,
	"createdAt" timestamp with time zone,
	"revoked" timestamp with time zone,
	"rotatedAt" timestamp with time zone,
	"rotationReplayResponse" text,
	"rotationReplayExpiresAt" timestamp with time zone,
	"authTime" timestamp with time zone,
	"confirmation" jsonb,
	"scopes" text[] NOT NULL,
	CONSTRAINT "oauthRefreshToken_token_key" UNIQUE("token")
);

CREATE TABLE "auth"."oauthResource" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"accessTokenTtl" integer,
	"refreshTokenTtl" integer,
	"signingAlgorithm" text,
	"signingKeyId" text,
	"allowedScopes" text[],
	"customClaims" jsonb,
	"dpopBoundAccessTokensRequired" boolean DEFAULT false,
	"disabled" boolean DEFAULT false,
	"createdAt" timestamp with time zone,
	"updatedAt" timestamp with time zone,
	"policyVersion" integer DEFAULT 1,
	"metadata" jsonb,
	CONSTRAINT "oauthResource_identifier_key" UNIQUE("identifier")
);

CREATE TABLE "factory"."operation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"idempotency_key" text,
	"active_key" text,
	"state" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"created_by" uuid,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "operation_idempotency_key_key" UNIQUE("idempotency_key"),
	CONSTRAINT "operation_active_key_key" UNIQUE("active_key"),
	CONSTRAINT "operation_payload_check" CHECK (jsonb_typeof("factory"."operation"."payload") = 'object'::text)
);

CREATE TABLE "factory"."project" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"repository_url" text NOT NULL,
	"default_branch" text NOT NULL,
	"actor_template_path" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"desktop_background_key" text DEFAULT 'river-landscape' NOT NULL,
	CONSTRAINT "project_slug_key" UNIQUE("slug"),
	CONSTRAINT "project_default_branch_check" CHECK ((length("factory"."project"."default_branch") >= 1) AND (length("factory"."project"."default_branch") <= 200)),
	CONSTRAINT "project_desktop_background_key_check" CHECK ("factory"."project"."desktop_background_key" = ANY (ARRAY['river-landscape'::text, 'the-harvesters'::text, 'mountainous-landscape'::text, 'gulf-of-marseille'::text, 'scene-on-the-ice'::text, 'moonlit-landscape'::text])),
	CONSTRAINT "project_actor_template_path_check" CHECK (("factory"."project"."actor_template_path" <> ''::text) AND ("factory"."project"."actor_template_path" !~ '(^/|(^|/)\.\.(/|$))'::text)),
	CONSTRAINT "project_name_check" CHECK ((length("factory"."project"."name") >= 1) AND (length("factory"."project"."name") <= 200)),
	CONSTRAINT "project_slug_check" CHECK ("factory"."project"."slug" ~ '^[a-z][a-z0-9-]{1,62}$'::text)
);

CREATE TABLE "factory"."project_membership" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"manage_project" boolean DEFAULT false NOT NULL,
	CONSTRAINT "project_membership_pkey" PRIMARY KEY("project_id","user_id"),
	CONSTRAINT "project_membership_role_check" CHECK ("factory"."project_membership"."role" = ANY (ARRAY['product-contributor'::text, 'developer'::text]))
);

CREATE TABLE "factory"."project_release" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"version" text NOT NULL,
	"commit_sha" text NOT NULL,
	"workflow" text,
	"contract" jsonb,
	"notes" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"run_id" bigint,
	"run_url" text,
	"release_url" text,
	"artifacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failure" text,
	CONSTRAINT "project_release_project_id_version_key" UNIQUE("project_id","version"),
	CONSTRAINT "project_release_command_id_key" UNIQUE("command_id"),
	CONSTRAINT "project_release_artifacts_check" CHECK (jsonb_typeof("factory"."project_release"."artifacts") = 'array'::text),
	CONSTRAINT "project_release_commit_sha_check" CHECK ("factory"."project_release"."commit_sha" ~ '^[a-f0-9]{40}$'::text),
	CONSTRAINT "project_release_contract_check" CHECK (("factory"."project_release"."contract" IS NULL) OR (jsonb_typeof("factory"."project_release"."contract") = 'object'::text)),
	CONSTRAINT "project_release_state_check" CHECK ("factory"."project_release"."state" = ANY (ARRAY['pending'::text, 'dispatching'::text, 'running'::text, 'checking'::text, 'publishing'::text, 'published'::text, 'failed'::text, 'uncertain'::text])),
	CONSTRAINT "project_release_version_check" CHECK ("factory"."project_release"."version" ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'::text)
);

CREATE TABLE "factory"."read_version" (
	"project_id" uuid NOT NULL,
	"audience" text NOT NULL,
	"scope" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"revision" uuid DEFAULT gen_random_uuid() NOT NULL,
	CONSTRAINT "read_version_pkey" PRIMARY KEY("project_id","audience","scope","resource_id"),
	CONSTRAINT "read_version_audience_check" CHECK (("factory"."read_version"."audience" = ANY (ARRAY['shared'::text, 'developer'::text])) OR ("factory"."read_version"."audience" ~ '^[0-9a-f-]{36}$'::text)),
	CONSTRAINT "read_version_scope_check" CHECK ("factory"."read_version"."scope" = ANY (ARRAY['lifecycle'::text, 'ticket'::text, 'conversation'::text, 'review'::text, 'inbox'::text, 'knowledge'::text, 'inputs'::text, 'sources'::text, 'releases'::text]))
);

CREATE TABLE "factory"."requirement_approval" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ticket_id" uuid NOT NULL,
	"requirement_revision_id" uuid NOT NULL,
	"technical_design_revision_id" uuid,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"monitoring_incident_id" uuid,
	"monitoring_policy_id" uuid,
	CONSTRAINT "requirement_approval_id_ticket_id_key" UNIQUE("id","ticket_id"),
	CONSTRAINT "requirement_approval_ticket_id_key" UNIQUE("ticket_id"),
	CONSTRAINT "requirement_approval_requirement_revision_id_key" UNIQUE("requirement_revision_id"),
	CONSTRAINT "requirement_monitoring_basis" CHECK (("factory"."requirement_approval"."monitoring_incident_id" IS NULL) = ("factory"."requirement_approval"."monitoring_policy_id" IS NULL))
);

CREATE TABLE "factory"."requirement_revision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ticket_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"canonical_content" text NOT NULL,
	"content_digest" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requirement_revision_id_ticket_id_key" UNIQUE("id","ticket_id"),
	CONSTRAINT "requirement_revision_ticket_id_ordinal_key" UNIQUE("ticket_id","ordinal"),
	CONSTRAINT "requirement_revision_canonical_content_check" CHECK (length("factory"."requirement_revision"."canonical_content") > 0),
	CONSTRAINT "requirement_revision_check" CHECK ("factory"."requirement_revision"."content_digest" = encode(digest(convert_to("factory"."requirement_revision"."canonical_content", 'UTF8'::name), 'sha256'::text), 'hex'::text)),
	CONSTRAINT "requirement_revision_content_digest_check" CHECK ("factory"."requirement_revision"."content_digest" ~ '^[0-9a-f]{64}$'::text),
	CONSTRAINT "requirement_revision_ordinal_check" CHECK ("factory"."requirement_revision"."ordinal" > 0)
);

CREATE TABLE "factory"."review_feedback" (
	"id" uuid PRIMARY KEY NOT NULL,
	"change_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"commit_sha" text NOT NULL,
	"annotation" jsonb,
	"media_id" uuid,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_feedback_annotation_media" CHECK (("factory"."review_feedback"."media_id" IS NULL) OR ("factory"."review_feedback"."annotation" IS NOT NULL)),
	CONSTRAINT "review_feedback_check" CHECK (("factory"."review_feedback"."kind" <> 'comment'::text) OR ("factory"."review_feedback"."state" = 'open'::text)),
	CONSTRAINT "review_feedback_commit_sha_check" CHECK ("factory"."review_feedback"."commit_sha" ~ '^[a-f0-9]{40}$'::text),
	CONSTRAINT "review_feedback_kind_check" CHECK ("factory"."review_feedback"."kind" = ANY (ARRAY['comment'::text, 'thread'::text])),
	CONSTRAINT "review_feedback_state_check" CHECK ("factory"."review_feedback"."state" = ANY (ARRAY['open'::text, 'implemented'::text, 'resolved'::text]))
);

CREATE TABLE "factory"."review_media" (
	"id" uuid PRIMARY KEY NOT NULL,
	"change_id" uuid NOT NULL,
	"review_id" uuid,
	"browser_session_id" uuid,
	"created_by" uuid,
	"kind" text NOT NULL,
	"commit_sha" text NOT NULL,
	"runtime_attempt_id" uuid,
	"source_context" jsonb,
	"state" text NOT NULL,
	"byte_length" integer,
	"sha256" text,
	"duration_ms" integer,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"completed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "review_media_browser_session_id_kind_key" UNIQUE("browser_session_id","kind"),
	CONSTRAINT "review_media_byte_length_check" CHECK (("factory"."review_media"."byte_length" >= 1) AND ("factory"."review_media"."byte_length" <= 100663296)),
	CONSTRAINT "review_media_check" CHECK (("factory"."review_media"."state" <> 'complete'::text) OR (("factory"."review_media"."byte_length" IS NOT NULL) AND ("factory"."review_media"."sha256" IS NOT NULL))),
	CONSTRAINT "review_media_check1" CHECK (("factory"."review_media"."kind" <> 'recording'::text) OR ("factory"."review_media"."review_id" IS NOT NULL)),
	CONSTRAINT "review_media_commit_sha_check" CHECK ("factory"."review_media"."commit_sha" ~ '^[a-f0-9]{40}$'::text),
	CONSTRAINT "review_media_duration_ms_check" CHECK ("factory"."review_media"."duration_ms" >= 0),
	CONSTRAINT "review_media_kind_check" CHECK ("factory"."review_media"."kind" = ANY (ARRAY['recording'::text, 'still'::text])),
	CONSTRAINT "review_media_sha256_check" CHECK ("factory"."review_media"."sha256" ~ '^[a-f0-9]{64}$'::text),
	CONSTRAINT "review_media_state_check" CHECK ("factory"."review_media"."state" = ANY (ARRAY['intended'::text, 'recording'::text, 'complete'::text, 'unavailable'::text, 'deleted'::text]))
);

CREATE TABLE "factory"."runtime_attempt" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"change_id" uuid,
	"workspace_id" uuid,
	"generation" bigint NOT NULL,
	"revision" text NOT NULL,
	"state" "factory"."runtime_attempt_state" NOT NULL,
	"parent_connector_token_hash" text NOT NULL,
	"create_intended_at" timestamp with time zone NOT NULL,
	"stop_intended_at" timestamp with time zone,
	"failure" text,
	"declared_apps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"isolated_kind" "factory"."isolated_runtime_kind",
	"verification_id" uuid,
	"ready_at" timestamp with time zone,
	"app_ready_at" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"atespace" text,
	"actor_name" text,
	"binding_intent" jsonb,
	"actor_uid" uuid,
	"create_attempted_at" timestamp with time zone,
	"create_rejected" boolean DEFAULT false NOT NULL,
	"delete_intended_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"observation" jsonb,
	"checkpoint" jsonb,
	CONSTRAINT "runtime_attempt_id_change_id_key" UNIQUE("id","change_id"),
	CONSTRAINT "runtime_attempt_id_project_id_key" UNIQUE("id","project_id"),
	CONSTRAINT "runtime_attempt_id_workspace_id_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "runtime_attempt_verification_identity_unique" UNIQUE("id","verification_id"),
	CONSTRAINT "runtime_attempt_atespace_key" UNIQUE("atespace"),
	CONSTRAINT "runtime_attempt_actor_uid_key" UNIQUE("actor_uid"),
	CONSTRAINT "runtime_attempt_app_ready_shape" CHECK ((jsonb_typeof("factory"."runtime_attempt"."app_ready_at") = 'object'::text) AND (octet_length(("factory"."runtime_attempt"."app_ready_at")::text) <= 4096)),
	CONSTRAINT "runtime_attempt_binding_actor_check" CHECK (("factory"."runtime_attempt"."actor_uid" IS NULL) OR ("factory"."runtime_attempt"."create_attempted_at" IS NOT NULL)),
	CONSTRAINT "runtime_attempt_binding_delete_check" CHECK (("factory"."runtime_attempt"."deleted_at" IS NULL) OR ("factory"."runtime_attempt"."delete_intended_at" IS NOT NULL)),
	CONSTRAINT "runtime_attempt_binding_intent_check" CHECK (("factory"."runtime_attempt"."binding_intent" IS NULL) OR (jsonb_typeof("factory"."runtime_attempt"."binding_intent") = 'object'::text)),
	CONSTRAINT "runtime_attempt_binding_tuple_check" CHECK ((("factory"."runtime_attempt"."atespace" IS NULL) = ("factory"."runtime_attempt"."actor_name" IS NULL)) AND (("factory"."runtime_attempt"."atespace" IS NULL) = ("factory"."runtime_attempt"."binding_intent" IS NULL))),
	CONSTRAINT "runtime_attempt_declared_apps_check" CHECK (jsonb_typeof("factory"."runtime_attempt"."declared_apps") = 'array'::text),
	CONSTRAINT "runtime_attempt_generation_check" CHECK ("factory"."runtime_attempt"."generation" > 0),
	CONSTRAINT "runtime_attempt_native_owner" CHECK ((
        ("factory"."runtime_attempt"."workspace_id" IS NOT NULL AND "factory"."runtime_attempt"."isolated_kind" IS NULL AND "factory"."runtime_attempt"."verification_id" IS NULL)
        OR ("factory"."runtime_attempt"."workspace_id" IS NULL AND "factory"."runtime_attempt"."change_id" IS NULL AND (
          ("factory"."runtime_attempt"."isolated_kind" = 'verification'::isolated_runtime_kind AND "factory"."runtime_attempt"."verification_id" IS NOT NULL)
          OR ("factory"."runtime_attempt"."isolated_kind" = ANY (ARRAY['staging'::isolated_runtime_kind, 'publication'::isolated_runtime_kind]) AND "factory"."runtime_attempt"."verification_id" IS NULL)
        ))
      ) IS TRUE)
);

CREATE TABLE "factory"."schema_migration" (
	"version" integer PRIMARY KEY NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_digest" text NOT NULL,
	CONSTRAINT "schema_migration_version_check" CHECK ("factory"."schema_migration"."version" >= 1),
	CONSTRAINT "schema_migration_source_digest_check" CHECK ("factory"."schema_migration"."source_digest" ~ '^[a-f0-9]{64}$'::text)
);

CREATE TABLE "auth"."scimConnectionBinding" (
	"id" text PRIMARY KEY NOT NULL,
	"connectionId" text NOT NULL,
	"connectionKey" text NOT NULL,
	"provisioningDomainId" text NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"decommissionedAt" timestamp with time zone,
	"decommissionStatus" text DEFAULT 'active' NOT NULL,
	"decommissionCursorUserId" text,
	"decommissionReconciledUserCount" integer DEFAULT 0 NOT NULL,
	"decommissionBatchCount" integer DEFAULT 0 NOT NULL,
	"decommissionRevision" integer DEFAULT 0 NOT NULL,
	"decommissionCompletedAt" timestamp with time zone,
	"decommissionLeaseId" text,
	"decommissionLeaseExpiresAt" timestamp with time zone,
	CONSTRAINT "scimConnectionBinding_connectionKey_key" UNIQUE("connectionKey")
);

CREATE TABLE "auth"."scimGroup" (
	"id" text PRIMARY KEY NOT NULL,
	"connectionId" text NOT NULL,
	"provisioningDomainId" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"displayName" text NOT NULL,
	"displayNameKey" text NOT NULL,
	"externalId" text,
	"externalIdKey" text,
	"orderKey" text NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL,
	CONSTRAINT "scimGroup_displayNameKey_key" UNIQUE("displayNameKey"),
	CONSTRAINT "scimGroup_externalIdKey_key" UNIQUE("externalIdKey"),
	CONSTRAINT "scimGroup_orderKey_key" UNIQUE("orderKey")
);

CREATE TABLE "auth"."scimGroupMember" (
	"id" text PRIMARY KEY NOT NULL,
	"connectionId" text NOT NULL,
	"groupId" text NOT NULL,
	"scimUserId" text NOT NULL,
	"membershipKey" text NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	CONSTRAINT "scimGroupMember_membershipKey_key" UNIQUE("membershipKey")
);

CREATE TABLE "auth"."scimIdentityTombstone" (
	"id" text PRIMARY KEY NOT NULL,
	"connectionId" text NOT NULL,
	"provisioningDomainId" text NOT NULL,
	"externalId" text NOT NULL,
	"externalIdKey" text NOT NULL,
	"userId" uuid NOT NULL,
	"profile" text NOT NULL,
	"deletedAt" timestamp with time zone NOT NULL,
	CONSTRAINT "scimIdentityTombstone_externalIdKey_key" UNIQUE("externalIdKey")
);

CREATE TABLE "auth"."scimProjectionGrant" (
	"id" text PRIMARY KEY NOT NULL,
	"connectionId" text NOT NULL,
	"provisioningDomainId" text NOT NULL,
	"scimUserId" text NOT NULL,
	"userId" uuid NOT NULL,
	"sourceKind" text NOT NULL,
	"sourceId" text NOT NULL,
	"sourceValue" text,
	"role" text NOT NULL,
	"grantKey" text NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL,
	CONSTRAINT "scimProjectionGrant_grantKey_key" UNIQUE("grantKey")
);

CREATE TABLE "auth"."scimSubject" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" uuid NOT NULL,
	"profileSourceId" text,
	"revision" integer NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL,
	CONSTRAINT "scimSubject_userId_key" UNIQUE("userId")
);

CREATE TABLE "auth"."scimUser" (
	"id" text PRIMARY KEY NOT NULL,
	"connectionId" text NOT NULL,
	"provisioningDomainId" text NOT NULL,
	"userId" uuid NOT NULL,
	"connectionUserKey" text NOT NULL,
	"userName" text NOT NULL,
	"userNameKey" text NOT NULL,
	"primaryEmail" text NOT NULL,
	"workEmailValueIndex" text NOT NULL,
	"emailValueIndex" text NOT NULL,
	"displayName" text NOT NULL,
	"formattedName" text NOT NULL,
	"givenName" text,
	"familyName" text,
	"serializedEmails" text NOT NULL,
	"serializedAttributes" text,
	"externalId" text,
	"externalIdKey" text,
	"active" boolean NOT NULL,
	"orderKey" text NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL,
	CONSTRAINT "scimUser_connectionUserKey_key" UNIQUE("connectionUserKey"),
	CONSTRAINT "scimUser_userNameKey_key" UNIQUE("userNameKey"),
	CONSTRAINT "scimUser_externalIdKey_key" UNIQUE("externalIdKey"),
	CONSTRAINT "scimUser_orderKey_key" UNIQUE("orderKey")
);

CREATE TABLE "factory"."skill_library" (
	"id" uuid PRIMARY KEY NOT NULL,
	"storage_key" text NOT NULL,
	"scope" text NOT NULL,
	"owner_id" uuid,
	"project_id" uuid,
	"cover_key" text,
	"cover_version" bigint,
	"cover_updated_by" uuid,
	CONSTRAINT "skill_library_storage_key_key" UNIQUE("storage_key"),
	CONSTRAINT "skill_library_check" CHECK ((("factory"."skill_library"."scope" = 'personal'::text) AND ("factory"."skill_library"."owner_id" IS NOT NULL) AND ("factory"."skill_library"."project_id" IS NULL)) OR (("factory"."skill_library"."scope" = 'project'::text) AND ("factory"."skill_library"."owner_id" IS NULL) AND ("factory"."skill_library"."project_id" IS NOT NULL)) OR (("factory"."skill_library"."scope" = 'system'::text) AND ("factory"."skill_library"."owner_id" IS NULL) AND ("factory"."skill_library"."project_id" IS NULL))),
	CONSTRAINT "skill_library_scope_check" CHECK ("factory"."skill_library"."scope" = ANY (ARRAY['system'::text, 'project'::text, 'personal'::text])),
	CONSTRAINT "skill_library_cover_nulls_check" CHECK (("factory"."skill_library"."cover_key" IS NULL) = ("factory"."skill_library"."cover_version" IS NULL AND "factory"."skill_library"."cover_updated_by" IS NULL)),
	CONSTRAINT "skill_library_cover_key_check" CHECK ("factory"."skill_library"."cover_key" IS NULL OR "factory"."skill_library"."cover_key" ~ '^[a-z][a-z-]{1,63}$'::text),
	CONSTRAINT "skill_library_cover_version_check" CHECK ("factory"."skill_library"."cover_version" IS NULL OR "factory"."skill_library"."cover_version" > 0)
);

CREATE TABLE "factory"."skill_revision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"skill_key" text NOT NULL,
	"revision" bigint NOT NULL,
	"content" jsonb NOT NULL,
	"content_digest" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"library_id" uuid,
	"copied_from" uuid,
	"published" boolean DEFAULT false NOT NULL,
	"published_updated_by" uuid,
	"published_updated_at" timestamp with time zone,
	CONSTRAINT "skill_revision_skill_key_revision_key" UNIQUE("skill_key","revision"),
	CONSTRAINT "skill_revision_skill_key_check" CHECK ("factory"."skill_revision"."skill_key" ~ '^[a-z][a-z0-9-]{1,63}$'::text),
	CONSTRAINT "skill_revision_content_check" CHECK ((jsonb_typeof("factory"."skill_revision"."content") = 'object'::text) AND (octet_length(("factory"."skill_revision"."content")::text) <= 2100000)),
	CONSTRAINT "skill_revision_content_digest_check" CHECK ("factory"."skill_revision"."content_digest" ~ '^[a-f0-9]{64}$'::text),
	CONSTRAINT "skill_revision_revision_check" CHECK ("factory"."skill_revision"."revision" > 0)
);

CREATE TABLE "auth"."ssoProvider" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"oidcConfig" text,
	"samlConfig" text,
	"userId" uuid,
	"providerId" text NOT NULL,
	"organizationId" text,
	"domain" text NOT NULL,
	CONSTRAINT "ssoProvider_providerId_key" UNIQUE("providerId")
);

CREATE TABLE "factory"."substrate_provision" (
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"generation" bigint DEFAULT 1 NOT NULL,
	"project_id" uuid,
	"runtime_attempt_id" uuid,
	"intent" jsonb NOT NULL,
	"resources" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "substrate_provision_pkey" PRIMARY KEY("owner_id","kind","generation"),
	CONSTRAINT "substrate_provision_runtime_attempt_id_key" UNIQUE("runtime_attempt_id"),
	CONSTRAINT "substrate_provision_kind_check" CHECK ("factory"."substrate_provision"."kind" = ANY (ARRAY['workspace'::text, 'verification'::text, 'staging'::text, 'publication'::text])),
	CONSTRAINT "substrate_provision_generation_check" CHECK (("factory"."substrate_provision"."generation" > 0) AND ("factory"."substrate_provision"."generation" <= '9007199254740991'::bigint)),
	CONSTRAINT "substrate_provision_intent_check" CHECK (jsonb_typeof("factory"."substrate_provision"."intent") = 'object'::text),
	CONSTRAINT "substrate_provision_resources_check" CHECK (jsonb_typeof("factory"."substrate_provision"."resources") = 'object'::text
        AND (("factory"."substrate_provision"."resources" - ARRAY['atespace','policy','template']) = '{}'::jsonb)
        AND (("factory"."substrate_provision"."resources" -> 'atespace') IS NULL OR (jsonb_typeof("factory"."substrate_provision"."resources" -> 'atespace') = 'object'::text
          AND (("factory"."substrate_provision"."resources" -> 'atespace' -> 'value') IS NULL OR ("factory"."substrate_provision"."resources" -> 'atespace' -> 'value') = 'null'::jsonb
            OR (jsonb_typeof("factory"."substrate_provision"."resources" -> 'atespace' -> 'value') = 'object'::text AND jsonb_typeof("factory"."substrate_provision"."resources" -> 'atespace' -> 'attemptedAt') = 'string'::text))))
        AND (("factory"."substrate_provision"."resources" -> 'policy') IS NULL OR (jsonb_typeof("factory"."substrate_provision"."resources" -> 'policy') = 'object'::text
          AND (("factory"."substrate_provision"."resources" -> 'policy' -> 'value') IS NULL OR ("factory"."substrate_provision"."resources" -> 'policy' -> 'value') = 'null'::jsonb
            OR (jsonb_typeof("factory"."substrate_provision"."resources" -> 'policy' -> 'value') = 'object'::text AND jsonb_typeof("factory"."substrate_provision"."resources" -> 'policy' -> 'attemptedAt') = 'string'::text))))
        AND (("factory"."substrate_provision"."resources" -> 'template') IS NULL OR (jsonb_typeof("factory"."substrate_provision"."resources" -> 'template') = 'object'::text
          AND (("factory"."substrate_provision"."resources" -> 'template' -> 'value') IS NULL OR ("factory"."substrate_provision"."resources" -> 'template' -> 'value') = 'null'::jsonb
            OR (jsonb_typeof("factory"."substrate_provision"."resources" -> 'template' -> 'value') = 'object'::text AND jsonb_typeof("factory"."substrate_provision"."resources" -> 'template' -> 'attemptedAt') = 'string'::text))))),
	CONSTRAINT "substrate_provision_attempt_check" CHECK (("factory"."substrate_provision"."kind" = 'workspace'::text) = ("factory"."substrate_provision"."runtime_attempt_id" IS NULL)),
	CONSTRAINT "substrate_provision_project_check" CHECK (("factory"."substrate_provision"."kind" = ANY (ARRAY['staging'::text, 'publication'::text])) = ("factory"."substrate_provision"."project_id" IS NOT NULL)),
	CONSTRAINT "substrate_provision_publication_generation_check" CHECK (("factory"."substrate_provision"."kind" <> 'publication'::text) OR ("factory"."substrate_provision"."generation" = 1)),
	CONSTRAINT "substrate_provision_promotion_check" CHECK ((("factory"."substrate_provision"."intent" ->> 'promotionID'::text) IS NULL) OR (("factory"."substrate_provision"."kind" = 'staging'::text) AND ("factory"."substrate_provision"."generation" = 1))),
	CONSTRAINT "substrate_provision_declaration_check" CHECK ((("factory"."substrate_provision"."kind" <> 'staging'::text) OR (jsonb_typeof(("factory"."substrate_provision"."intent" -> 'declaration'::text)) = 'object'::text))
        AND (("factory"."substrate_provision"."kind" <> 'publication'::text) OR ("factory"."substrate_provision"."intent" -> 'declaration'::text) IS NULL OR ("factory"."substrate_provision"."intent" -> 'declaration'::text) = 'null'::jsonb))
);

CREATE TABLE "factory"."substrate_source" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"actor_uid" uuid,
	"owner" text DEFAULT 'actor' NOT NULL,
	"writer_epoch" bigint DEFAULT 1 NOT NULL,
	"writable" boolean DEFAULT true NOT NULL,
	"generation" bigint DEFAULT 0 NOT NULL,
	"checkpoint_id" uuid,
	"checkpoint" jsonb,
	"service_base" uuid,
	"seed" jsonb,
	"seed_confirmed_at" timestamp with time zone,
	CONSTRAINT "substrate_source_check" CHECK (("factory"."substrate_source"."generation" = 0) = ("factory"."substrate_source"."checkpoint" IS NULL)),
	CONSTRAINT "substrate_source_check1" CHECK ("factory"."substrate_source"."writable" = ("factory"."substrate_source"."checkpoint_id" IS NULL)),
	CONSTRAINT "substrate_source_check2" CHECK (("factory"."substrate_source"."owner" <> 'service'::text) OR ("factory"."substrate_source"."service_base" IS NOT NULL)),
	CONSTRAINT "substrate_source_actor_check" CHECK (("factory"."substrate_source"."actor_uid" IS NOT NULL) OR ("factory"."substrate_source"."owner" = 'service'::text AND "factory"."substrate_source"."seed" IS NOT NULL)),
	CONSTRAINT "substrate_source_seed_check" CHECK ("factory"."substrate_source"."seed" IS NULL OR (
        jsonb_typeof("factory"."substrate_source"."seed") = 'object'
        AND "factory"."substrate_source"."seed" - ARRAY['version','id','workspaceID','projectID','repositoryURL','revision','branch'] = '{}'::jsonb
        AND "factory"."substrate_source"."seed"->'version' = '1'::jsonb
        AND jsonb_typeof("factory"."substrate_source"."seed"->'id') = 'string'
        AND "factory"."substrate_source"."seed"->>'id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
        AND jsonb_typeof("factory"."substrate_source"."seed"->'workspaceID') = 'string'
        AND "factory"."substrate_source"."seed"->>'workspaceID' = "factory"."substrate_source"."workspace_id"::text
        AND jsonb_typeof("factory"."substrate_source"."seed"->'projectID') = 'string'
        AND "factory"."substrate_source"."seed"->>'projectID' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
        AND jsonb_typeof("factory"."substrate_source"."seed"->'repositoryURL') = 'string'
        AND jsonb_typeof("factory"."substrate_source"."seed"->'revision') = 'string'
        AND "factory"."substrate_source"."seed"->>'revision' ~ '^[a-f0-9]{40}([a-f0-9]{24})?$'
        AND jsonb_typeof("factory"."substrate_source"."seed"->'branch') = 'string'
      ) IS TRUE),
	CONSTRAINT "substrate_source_seed_confirmation_check" CHECK ("factory"."substrate_source"."seed_confirmed_at" IS NULL OR "factory"."substrate_source"."seed" IS NOT NULL),
	CONSTRAINT "substrate_source_generation_check" CHECK ("factory"."substrate_source"."generation" >= 0),
	CONSTRAINT "substrate_source_owner_check" CHECK ("factory"."substrate_source"."owner" = ANY (ARRAY['actor'::text, 'service'::text])),
	CONSTRAINT "substrate_source_writer_epoch_check" CHECK ("factory"."substrate_source"."writer_epoch" > 0)
);

CREATE TABLE "factory"."technical_design_revision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ticket_id" uuid NOT NULL,
	"requirement_revision_id" uuid NOT NULL,
	"previous_revision_id" uuid,
	"ordinal" integer NOT NULL,
	"source_commit" text NOT NULL,
	"canonical_content" text NOT NULL,
	"content_digest" text NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"diagram_renders" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"renderer_version" text NOT NULL,
	"created_by" uuid NOT NULL,
	"author_kind" text NOT NULL,
	"turn_id" uuid,
	"planning_turn_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "technical_design_revision_id_ticket_id_requirement_revision_key" UNIQUE("id","ticket_id","requirement_revision_id"),
	CONSTRAINT "technical_design_revision_ticket_id_ordinal_key" UNIQUE("ticket_id","ordinal"),
	CONSTRAINT "technical_design_revision_turn_id_key" UNIQUE("turn_id"),
	CONSTRAINT "technical_design_revision_author_kind_check" CHECK ("factory"."technical_design_revision"."author_kind" = ANY (ARRAY['human'::text, 'ai'::text])),
	CONSTRAINT "technical_design_revision_canonical_content_check" CHECK ((length("factory"."technical_design_revision"."canonical_content") >= 1) AND (length("factory"."technical_design_revision"."canonical_content") <= 100000)),
	CONSTRAINT "technical_design_revision_check" CHECK ("factory"."technical_design_revision"."content_digest" = encode(digest(convert_to("factory"."technical_design_revision"."canonical_content", 'UTF8'::name), 'sha256'::text), 'hex'::text)),
	CONSTRAINT "technical_design_revision_citations_check" CHECK (jsonb_typeof("factory"."technical_design_revision"."citations") = 'array'::text),
	CONSTRAINT "technical_design_revision_diagram_renders_check" CHECK (jsonb_typeof("factory"."technical_design_revision"."diagram_renders") = 'array'::text),
	CONSTRAINT "technical_design_revision_ordinal_check" CHECK ("factory"."technical_design_revision"."ordinal" > 0),
	CONSTRAINT "technical_design_revision_source_commit_check" CHECK ("factory"."technical_design_revision"."source_commit" ~ '^[a-f0-9]{40}$'::text)
);

CREATE TABLE "factory"."ticket" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"state" "factory"."ticket_state" DEFAULT 'inbox' NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"epic_id" uuid,
	"trashed_at" timestamp with time zone,
	"trashed_by" uuid,
	"trash_stop_pending" boolean DEFAULT false NOT NULL,
	"trash_error" text,
	"converted_to_epic_id" uuid,
	CONSTRAINT "ticket_id_project_id_key" UNIQUE("id","project_id"),
	CONSTRAINT "ticket_description_check" CHECK (length("factory"."ticket"."description") <= 10000),
	CONSTRAINT "ticket_title_check" CHECK ((length(btrim("factory"."ticket"."title")) >= 1) AND (length(btrim("factory"."ticket"."title")) <= 200)),
	CONSTRAINT "ticket_version_check" CHECK ("factory"."ticket"."version" > 0)
);

CREATE TABLE "factory"."ticket_conversation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"ticket_id" uuid,
	"mode" "factory"."conversation_mode" DEFAULT 'investigate' NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active_coding_context_id" uuid,
	CONSTRAINT "ticket_conversation_version_check" CHECK ("factory"."ticket_conversation"."version" > 0)
);

CREATE TABLE "factory"."ticket_dependency" (
	"project_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"prerequisite_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_dependency_pkey" PRIMARY KEY("project_id","ticket_id","prerequisite_id"),
	CONSTRAINT "ticket_dependency_check" CHECK ("factory"."ticket_dependency"."ticket_id" <> "factory"."ticket_dependency"."prerequisite_id")
);

CREATE TABLE "factory"."ticket_document_revision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ticket_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"canonical_content" text NOT NULL,
	"content_digest" text NOT NULL,
	"requirement_revision_id" uuid,
	"input_digest" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"author_kind" text DEFAULT 'human' NOT NULL,
	"proposal_entry_id" uuid,
	CONSTRAINT "ticket_document_revision_ticket_id_ordinal_key" UNIQUE("ticket_id","ordinal"),
	CONSTRAINT "ticket_document_revision_proposal_entry_id_key" UNIQUE("proposal_entry_id"),
	CONSTRAINT "ticket_document_revision_author_kind_check" CHECK ("factory"."ticket_document_revision"."author_kind" = ANY (ARRAY['human'::text, 'ai'::text])),
	CONSTRAINT "ticket_document_revision_check" CHECK ("factory"."ticket_document_revision"."content_digest" = encode(digest(convert_to("factory"."ticket_document_revision"."canonical_content", 'UTF8'::name), 'sha256'::text), 'hex'::text)),
	CONSTRAINT "ticket_document_revision_content_digest_check" CHECK ("factory"."ticket_document_revision"."content_digest" ~ '^[0-9a-f]{64}$'::text),
	CONSTRAINT "ticket_document_revision_input_digest_check" CHECK ("factory"."ticket_document_revision"."input_digest" ~ '^[0-9a-f]{64}$'::text),
	CONSTRAINT "ticket_document_revision_ordinal_check" CHECK ("factory"."ticket_document_revision"."ordinal" > 0),
	CONSTRAINT "ticket_document_revision_title_check" CHECK (length("factory"."ticket_document_revision"."title") > 0)
);

CREATE TABLE "factory"."usage_entry" (
	"operation_id" text NOT NULL,
	"event_id" text NOT NULL,
	"source" text NOT NULL,
	"outcome" text NOT NULL,
	"counters" jsonb NOT NULL,
	"nano_usd" bigint,
	"known_nano_usd" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "usage_entry_pkey" PRIMARY KEY("operation_id","event_id"),
	CONSTRAINT "usage_entry_event_id_check" CHECK ((length("factory"."usage_entry"."event_id") >= 1) AND (length("factory"."usage_entry"."event_id") <= 400)),
	CONSTRAINT "usage_entry_known_nano_usd_check" CHECK ("factory"."usage_entry"."known_nano_usd" >= 0),
	CONSTRAINT "usage_entry_nano_usd_check" CHECK ("factory"."usage_entry"."nano_usd" >= 0),
	CONSTRAINT "usage_entry_outcome_check" CHECK ("factory"."usage_entry"."outcome" = ANY (ARRAY['completed'::text, 'failed'::text, 'interrupted'::text, 'unknown'::text])),
	CONSTRAINT "usage_entry_source_check" CHECK ("factory"."usage_entry"."source" = ANY (ARRAY['step'::text, 'title'::text, 'compaction'::text, 'unobserved'::text]))
);

CREATE TABLE "factory"."usage_operation" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" uuid,
	"user_id" uuid,
	"purpose" text NOT NULL,
	"engine" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"rate" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"outcome" text,
	CONSTRAINT "usage_operation_check" CHECK (("factory"."usage_operation"."settled_at" IS NULL) = ("factory"."usage_operation"."outcome" IS NULL)),
	CONSTRAINT "usage_operation_engine_check" CHECK ("factory"."usage_operation"."engine" = ANY (ARRAY['opencode'::text, 'mastra'::text])),
	CONSTRAINT "usage_operation_id_check" CHECK ((length("factory"."usage_operation"."id") >= 1) AND (length("factory"."usage_operation"."id") <= 400)),
	CONSTRAINT "usage_operation_outcome_check" CHECK ("factory"."usage_operation"."outcome" = ANY (ARRAY['completed'::text, 'failed'::text, 'interrupted'::text, 'unknown'::text])),
	CONSTRAINT "usage_operation_purpose_check" CHECK ("factory"."usage_operation"."purpose" = ANY (ARRAY['coding'::text, 'research'::text, 'requirements'::text, 'wiki'::text, 'setup'::text, 'probe'::text, 'learning'::text]))
);

CREATE TABLE "factory"."verification" (
	"id" uuid PRIMARY KEY NOT NULL,
	"change_id" uuid NOT NULL,
	"commit_sha" text NOT NULL,
	"pull_request_number" bigint NOT NULL,
	"workflow_id" text DEFAULT 'factory-verification.yml' NOT NULL,
	"action_run_id" bigint,
	"action_run_url" text,
	"runtime_attempt_id" uuid,
	"runner_id" bigint,
	"runner_uuid" uuid,
	"runner_token" text,
	"state" "factory"."verification_state" DEFAULT 'pending' NOT NULL,
	"summary" text,
	"diagnosis" jsonb,
	"repair_prompted_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"runner_job_handle" text,
	CONSTRAINT "verification_id_change_id_commit_sha_key" UNIQUE("id","change_id","commit_sha"),
	CONSTRAINT "verification_change_id_commit_sha_key" UNIQUE("change_id","commit_sha"),
	CONSTRAINT "verification_runtime_attempt_id_key" UNIQUE("runtime_attempt_id"),
	CONSTRAINT "verification_check" CHECK (("factory"."verification"."state" = ANY (ARRAY['succeeded'::verification_state, 'failed'::verification_state, 'cancelled'::verification_state])) = ("factory"."verification"."completed_at" IS NOT NULL)),
	CONSTRAINT "verification_check1" CHECK (("factory"."verification"."state" <> ALL (ARRAY['runner-starting'::verification_state, 'running'::verification_state, 'succeeded'::verification_state, 'failed'::verification_state])) OR ("factory"."verification"."action_run_id" IS NOT NULL)),
	CONSTRAINT "verification_check2" CHECK (("factory"."verification"."runtime_attempt_id" IS NULL) OR ("factory"."verification"."runner_token" IS NOT NULL)),
	CONSTRAINT "verification_check3" CHECK (("factory"."verification"."runner_job_handle" IS NULL) OR (("factory"."verification"."action_run_id" IS NOT NULL) AND ("factory"."verification"."runner_job_handle" ~ '^[A-Za-z0-9_-]{1,200}$'::text))),
	CONSTRAINT "verification_commit_sha_check" CHECK ("factory"."verification"."commit_sha" ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text),
	CONSTRAINT "verification_diagnosis_check" CHECK (("factory"."verification"."diagnosis" IS NULL) OR ((jsonb_typeof("factory"."verification"."diagnosis") = 'object'::text) AND (octet_length(("factory"."verification"."diagnosis")::text) <= 24000))),
	CONSTRAINT "verification_summary_check" CHECK (("factory"."verification"."summary" IS NULL) OR (length("factory"."verification"."summary") <= 2000))
);

CREATE TABLE "factory"."workspace_share" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"granted_by" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "workspace_share_pkey" PRIMARY KEY("workspace_id","user_id"),
	CONSTRAINT "workspace_share_permission_check" CHECK ("factory"."workspace_share"."permission" = ANY (ARRAY['observe'::text, 'collaborate'::text])),
	CONSTRAINT "workspace_share_version_check" CHECK ("factory"."workspace_share"."version" > 0)
);

CREATE TABLE "factory"."workspace_shared_document" (
	"workspace_id" uuid NOT NULL,
	"path" text NOT NULL,
	"y_state" "bytea" NOT NULL,
	"disk_version" text NOT NULL,
	"sync_state" text DEFAULT 'clean' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_shared_document_pkey" PRIMARY KEY("workspace_id","path"),
	CONSTRAINT "workspace_shared_document_sync_state_check" CHECK ("factory"."workspace_shared_document"."sync_state" = ANY (ARRAY['clean'::text, 'dirty'::text, 'conflict'::text])),
	CONSTRAINT "workspace_shared_document_y_state_check" CHECK (octet_length("factory"."workspace_shared_document"."y_state") <= 8388608)
);

ALTER TABLE "factory"."account_access" ADD CONSTRAINT "account_access_disabled_by_fkey" FOREIGN KEY ("disabled_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."account_access" ADD CONSTRAINT "account_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."administrator" ADD CONSTRAINT "administrator_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."agent_turn" ADD CONSTRAINT "agent_turn_change_id_fkey" FOREIGN KEY ("change_id") REFERENCES "factory"."change"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."agent_turn" ADD CONSTRAINT "agent_turn_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "factory"."ticket_conversation"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."agent_turn" ADD CONSTRAINT "agent_turn_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."agent_turn" ADD CONSTRAINT "agent_turn_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "factory"."project"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."agent_turn" ADD CONSTRAINT "agent_turn_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "factory"."ticket"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."attachment" ADD CONSTRAINT "attachment_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."attachment" ADD CONSTRAINT "attachment_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "factory"."project"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."attachment_reference" ADD CONSTRAINT "attachment_reference_attachment_id_fkey" FOREIGN KEY ("attachment_id") REFERENCES "factory"."attachment"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."audit_event" ADD CONSTRAINT "audit_event_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "auth"."account" ADD CONSTRAINT "account_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "auth"."session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."build_browser_session" ADD CONSTRAINT "build_browser_session_change_id_fkey" FOREIGN KEY ("change_id") REFERENCES "factory"."change"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."build_browser_session" ADD CONSTRAINT "build_browser_session_runtime_attempt_id_change_id_fkey" FOREIGN KEY ("runtime_attempt_id","change_id") REFERENCES "factory"."runtime_attempt"("id","change_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."build_browser_session" ADD CONSTRAINT "build_browser_session_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "factory"."agent_turn"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."candidate_review" ADD CONSTRAINT "candidate_review_change_id_fkey" FOREIGN KEY ("change_id") REFERENCES "factory"."change"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."candidate_review" ADD CONSTRAINT "candidate_review_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."candidate_review" ADD CONSTRAINT "candidate_review_finding_source_fkey" FOREIGN KEY ("finding_source_id","change_id","verification_id","commit_sha") REFERENCES "factory"."candidate_review"("id","change_id","verification_id","commit_sha") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."candidate_review" ADD CONSTRAINT "candidate_review_focus_fkey" FOREIGN KEY ("focus_review_id") REFERENCES "factory"."candidate_review"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."candidate_review" ADD CONSTRAINT "candidate_review_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "factory"."candidate_review"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."candidate_review" ADD CONSTRAINT "candidate_review_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "factory"."agent_turn"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."candidate_review" ADD CONSTRAINT "candidate_review_verification_id_change_id_commit_sha_fkey" FOREIGN KEY ("verification_id","change_id","commit_sha") REFERENCES "factory"."verification"("id","change_id","commit_sha") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."change" ADD CONSTRAINT "change_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."change" ADD CONSTRAINT "change_delivery_waiting_policy_fk" FOREIGN KEY ("delivery_waiting_policy_id") REFERENCES "factory"."operation"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."change" ADD CONSTRAINT "change_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "factory"."project"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."change" ADD CONSTRAINT "change_requirement_approval_id_ticket_id_fkey" FOREIGN KEY ("requirement_approval_id","ticket_id") REFERENCES "factory"."requirement_approval"("id","ticket_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."change" ADD CONSTRAINT "change_runtime_attempt_fk" FOREIGN KEY ("runtime_attempt_id","id") REFERENCES "factory"."runtime_attempt"("id","change_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."change" ADD CONSTRAINT "change_ticket_id_project_id_fkey" FOREIGN KEY ("ticket_id","project_id") REFERENCES "factory"."ticket"("id","project_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."change_agent_session" ADD CONSTRAINT "change_agent_session_active_turn_id_fkey" FOREIGN KEY ("active_turn_id") REFERENCES "factory"."agent_turn"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."change_agent_session" ADD CONSTRAINT "change_agent_session_change_id_fkey" FOREIGN KEY ("change_id") REFERENCES "factory"."change"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."change_agent_session" ADD CONSTRAINT "change_agent_session_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."change_agent_session" ADD CONSTRAINT "change_agent_session_runtime_change_fk" FOREIGN KEY ("runtime_attempt_id","change_id") REFERENCES "factory"."runtime_attempt"("id","change_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."change_agent_turn_intent" ADD CONSTRAINT "change_agent_turn_intent_change_id_fkey" FOREIGN KEY ("change_id") REFERENCES "factory"."change"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."change_agent_turn_intent" ADD CONSTRAINT "change_agent_turn_intent_runtime_attempt_id_change_id_fkey" FOREIGN KEY ("runtime_attempt_id","change_id") REFERENCES "factory"."runtime_attempt"("id","change_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."change_agent_turn_intent" ADD CONSTRAINT "change_agent_turn_intent_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "factory"."agent_turn"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."change_commit_operation" ADD CONSTRAINT "change_commit_operation_change_id_fkey" FOREIGN KEY ("change_id") REFERENCES "factory"."change"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."change_commit_operation" ADD CONSTRAINT "change_commit_operation_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."change_commit_operation" ADD CONSTRAINT "change_commit_operation_runtime_change_fk" FOREIGN KEY ("runtime_attempt_id","change_id") REFERENCES "factory"."runtime_attempt"("id","change_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."change_writer" ADD CONSTRAINT "change_writer_change_id_fkey" FOREIGN KEY ("change_id") REFERENCES "factory"."change"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."change_writer" ADD CONSTRAINT "change_writer_fence_attempt_id_fkey" FOREIGN KEY ("fence_attempt_id") REFERENCES "factory"."runtime_attempt"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."change_writer" ADD CONSTRAINT "change_writer_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."change_writer" ADD CONSTRAINT "change_writer_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."conversation_context" ADD CONSTRAINT "conversation_context_change_id_fkey" FOREIGN KEY ("change_id") REFERENCES "factory"."change"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."conversation_context" ADD CONSTRAINT "conversation_context_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "factory"."ticket_conversation"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."conversation_context" ADD CONSTRAINT "conversation_context_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."conversation_context" ADD CONSTRAINT "conversation_context_previous_context_id_fkey" FOREIGN KEY ("previous_context_id") REFERENCES "factory"."conversation_context"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."conversation_entry" ADD CONSTRAINT "conversation_entry_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "factory"."ticket_conversation"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."conversation_entry" ADD CONSTRAINT "conversation_entry_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."conversation_entry" ADD CONSTRAINT "conversation_entry_in_reply_to_entry_id_fkey" FOREIGN KEY ("in_reply_to_entry_id") REFERENCES "factory"."conversation_entry"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "factory"."conversation_entry" ADD CONSTRAINT "conversation_entry_requirement_revision_id_fkey" FOREIGN KEY ("requirement_revision_id") REFERENCES "factory"."requirement_revision"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "factory"."delivery_approval" ADD CONSTRAINT "delivery_approval_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."delivery_approval" ADD CONSTRAINT "delivery_approval_candidate_review_identity" FOREIGN KEY ("candidate_review_id","change_id","verification_id","commit_sha") REFERENCES "factory"."candidate_review"("id","change_id","verification_id","commit_sha") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."delivery_approval" ADD CONSTRAINT "delivery_approval_change_id_fkey" FOREIGN KEY ("change_id") REFERENCES "factory"."change"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."delivery_approval" ADD CONSTRAINT "delivery_approval_monitoring_incident_id_fkey" FOREIGN KEY ("monitoring_incident_id") REFERENCES "factory"."monitoring_incident"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."delivery_approval" ADD CONSTRAINT "delivery_approval_monitoring_policy_id_fkey" FOREIGN KEY ("monitoring_policy_id") REFERENCES "factory"."monitoring_policy"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."delivery_approval" ADD CONSTRAINT "delivery_approval_verification_id_change_id_commit_sha_fkey" FOREIGN KEY ("verification_id","change_id","commit_sha") REFERENCES "factory"."verification"("id","change_id","commit_sha") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."delivery_approval" ADD CONSTRAINT "delivery_policy_basis_fk" FOREIGN KEY ("delivery_policy_id") REFERENCES "factory"."operation"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."development_workspace" ADD CONSTRAINT "development_workspace_change_id_project_id_fkey" FOREIGN KEY ("change_id","project_id") REFERENCES "factory"."change"("id","project_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."development_workspace" ADD CONSTRAINT "development_workspace_change_id_ticket_id_fkey" FOREIGN KEY ("change_id","ticket_id") REFERENCES "factory"."change"("id","ticket_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."development_workspace" ADD CONSTRAINT "development_workspace_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."development_workspace" ADD CONSTRAINT "development_workspace_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."development_workspace" ADD CONSTRAINT "development_workspace_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "factory"."project"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."development_workspace" ADD CONSTRAINT "development_workspace_ticket_id_project_id_fkey" FOREIGN KEY ("ticket_id","project_id") REFERENCES "factory"."ticket"("id","project_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."epic" ADD CONSTRAINT "epic_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."epic" ADD CONSTRAINT "epic_parent_id_project_id_fkey" FOREIGN KEY ("parent_id","project_id") REFERENCES "factory"."epic"("id","project_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."epic" ADD CONSTRAINT "epic_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "factory"."project"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."execution_policy" ADD CONSTRAINT "execution_policy_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."knowledge_page" ADD CONSTRAINT "knowledge_page_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."knowledge_page" ADD CONSTRAINT "knowledge_page_current_revision_fk" FOREIGN KEY ("current_revision_id","id") REFERENCES "factory"."knowledge_revision"("id","page_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."knowledge_page" ADD CONSTRAINT "knowledge_page_parent_project" FOREIGN KEY ("project_id","parent_id") REFERENCES "factory"."knowledge_page"("project_id","id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."knowledge_page" ADD CONSTRAINT "knowledge_page_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "factory"."project"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."knowledge_page_outline" ADD CONSTRAINT "knowledge_page_outline_id_fkey" FOREIGN KEY ("id") REFERENCES "factory"."knowledge_page"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."knowledge_page_outline" ADD CONSTRAINT "knowledge_page_outline_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "factory"."project"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."knowledge_revision" ADD CONSTRAINT "knowledge_revision_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."knowledge_revision" ADD CONSTRAINT "knowledge_revision_generation_id_fkey" FOREIGN KEY ("generation_id") REFERENCES "factory"."operation"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."knowledge_revision" ADD CONSTRAINT "knowledge_revision_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "factory"."knowledge_page"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."learning_case" ADD CONSTRAINT "learning_case_batch_fk" FOREIGN KEY ("batch_id") REFERENCES "factory"."learning_review"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."learning_case" ADD CONSTRAINT "learning_case_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."learning_case" ADD CONSTRAINT "learning_case_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "factory"."project"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."learning_case" ADD CONSTRAINT "learning_case_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."learning_proposal" ADD CONSTRAINT "learning_proposal_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."learning_proposal" ADD CONSTRAINT "learning_proposal_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "factory"."learning_review"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."learning_proposal" ADD CONSTRAINT "learning_proposal_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "factory"."ticket"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."learning_review" ADD CONSTRAINT "learning_review_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."learning_review" ADD CONSTRAINT "learning_review_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "factory"."project"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."learning_review" ADD CONSTRAINT "learning_review_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."mcp_connection" ADD CONSTRAINT "mcp_connection_authorized_by_fkey" FOREIGN KEY ("authorized_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."mcp_connection" ADD CONSTRAINT "mcp_connection_id_fkey" FOREIGN KEY ("id") REFERENCES "factory"."mcp_library"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."mcp_connection" ADD CONSTRAINT "mcp_connection_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "factory"."mcp_revision"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."mcp_library" ADD CONSTRAINT "mcp_library_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."mcp_library" ADD CONSTRAINT "mcp_library_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "factory"."project"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."mcp_library" ADD CONSTRAINT "mcp_library_cover_updated_by_fkey" FOREIGN KEY ("cover_updated_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."mcp_revision" ADD CONSTRAINT "mcp_revision_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."mcp_revision" ADD CONSTRAINT "mcp_revision_library_id_fkey" FOREIGN KEY ("library_id") REFERENCES "factory"."mcp_library"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."model_connection_version" ADD CONSTRAINT "model_connection_version_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."model_settings" ADD CONSTRAINT "model_settings_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "factory"."project"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."model_settings" ADD CONSTRAINT "model_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."model_settings" ADD CONSTRAINT "model_settings_connection_id_connection_version_fkey" FOREIGN KEY ("connection_id","connection_version") REFERENCES "factory"."model_connection_version"("connection_id","version") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."model_settings" ADD CONSTRAINT "model_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."monitoring_hook" ADD CONSTRAINT "monitoring_current_policy" FOREIGN KEY ("policy_id") REFERENCES "factory"."monitoring_policy"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."monitoring_hook" ADD CONSTRAINT "monitoring_hook_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "factory"."project"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."monitoring_incident" ADD CONSTRAINT "monitoring_incident_hook_id_fkey" FOREIGN KEY ("hook_id") REFERENCES "factory"."monitoring_hook"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."monitoring_incident" ADD CONSTRAINT "monitoring_incident_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "factory"."monitoring_policy"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."monitoring_incident" ADD CONSTRAINT "monitoring_incident_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "factory"."project"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."monitoring_incident" ADD CONSTRAINT "monitoring_incident_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "factory"."ticket"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."monitoring_policy" ADD CONSTRAINT "monitoring_policy_delegated_by_fkey" FOREIGN KEY ("delegated_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."monitoring_policy" ADD CONSTRAINT "monitoring_policy_hook_id_fkey" FOREIGN KEY ("hook_id") REFERENCES "factory"."monitoring_hook"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "auth"."oauthAccessToken" ADD CONSTRAINT "oauthAccessToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "auth"."oauthClient"("clientId") ON DELETE no action ON UPDATE no action;
ALTER TABLE "auth"."oauthAccessToken" ADD CONSTRAINT "oauthAccessToken_refreshId_fkey" FOREIGN KEY ("refreshId") REFERENCES "auth"."oauthRefreshToken"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "auth"."oauthAccessToken" ADD CONSTRAINT "oauthAccessToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "auth"."session"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "auth"."oauthAccessToken" ADD CONSTRAINT "oauthAccessToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "auth"."oauthClient" ADD CONSTRAINT "oauthClient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "auth"."oauthClientResource" ADD CONSTRAINT "oauthClientResource_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "auth"."oauthClient"("clientId") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "auth"."oauthClientResource" ADD CONSTRAINT "oauthClientResource_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "auth"."oauthResource"("identifier") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "auth"."oauthConsent" ADD CONSTRAINT "oauthConsent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "auth"."oauthClient"("clientId") ON DELETE no action ON UPDATE no action;
ALTER TABLE "auth"."oauthConsent" ADD CONSTRAINT "oauthConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "auth"."oauthRefreshToken" ADD CONSTRAINT "oauthRefreshToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "auth"."oauthClient"("clientId") ON DELETE no action ON UPDATE no action;
ALTER TABLE "auth"."oauthRefreshToken" ADD CONSTRAINT "oauthRefreshToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "auth"."session"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "auth"."oauthRefreshToken" ADD CONSTRAINT "oauthRefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."operation" ADD CONSTRAINT "operation_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."project" ADD CONSTRAINT "project_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."project_membership" ADD CONSTRAINT "project_membership_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "factory"."project"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."project_membership" ADD CONSTRAINT "project_membership_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."project_membership" ADD CONSTRAINT "project_membership_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."project_release" ADD CONSTRAINT "project_release_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."project_release" ADD CONSTRAINT "project_release_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "factory"."project"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."read_version" ADD CONSTRAINT "read_version_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "factory"."project"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."requirement_approval" ADD CONSTRAINT "requirement_approval_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."requirement_approval" ADD CONSTRAINT "requirement_approval_monitoring_incident_id_fkey" FOREIGN KEY ("monitoring_incident_id") REFERENCES "factory"."monitoring_incident"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."requirement_approval" ADD CONSTRAINT "requirement_approval_monitoring_policy_id_fkey" FOREIGN KEY ("monitoring_policy_id") REFERENCES "factory"."monitoring_policy"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."requirement_approval" ADD CONSTRAINT "requirement_approval_requirement_revision_id_ticket_id_fkey" FOREIGN KEY ("requirement_revision_id","ticket_id") REFERENCES "factory"."requirement_revision"("id","ticket_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."requirement_approval" ADD CONSTRAINT "requirement_approval_technical_design_fk" FOREIGN KEY ("technical_design_revision_id","ticket_id","requirement_revision_id") REFERENCES "factory"."technical_design_revision"("id","ticket_id","requirement_revision_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."requirement_approval" ADD CONSTRAINT "requirement_approval_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "factory"."ticket"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."requirement_revision" ADD CONSTRAINT "requirement_revision_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."requirement_revision" ADD CONSTRAINT "requirement_revision_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "factory"."ticket"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."review_feedback" ADD CONSTRAINT "review_feedback_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."review_feedback" ADD CONSTRAINT "review_feedback_change_id_fkey" FOREIGN KEY ("change_id") REFERENCES "factory"."change"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."review_feedback" ADD CONSTRAINT "review_feedback_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "factory"."review_media"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."review_feedback" ADD CONSTRAINT "review_feedback_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."review_media" ADD CONSTRAINT "review_media_browser_session_id_fkey" FOREIGN KEY ("browser_session_id") REFERENCES "factory"."build_browser_session"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."review_media" ADD CONSTRAINT "review_media_change_id_fkey" FOREIGN KEY ("change_id") REFERENCES "factory"."change"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."review_media" ADD CONSTRAINT "review_media_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."review_media" ADD CONSTRAINT "review_media_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "factory"."candidate_review"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."review_media" ADD CONSTRAINT "review_media_runtime_attempt_id_fkey" FOREIGN KEY ("runtime_attempt_id") REFERENCES "factory"."runtime_attempt"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."runtime_attempt" ADD CONSTRAINT "runtime_attempt_change_project_fk" FOREIGN KEY ("change_id","project_id") REFERENCES "factory"."change"("id","project_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."runtime_attempt" ADD CONSTRAINT "runtime_attempt_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."runtime_attempt" ADD CONSTRAINT "runtime_attempt_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "factory"."project"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."runtime_attempt" ADD CONSTRAINT "runtime_attempt_verification_id_fkey" FOREIGN KEY ("verification_id") REFERENCES "factory"."verification"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."runtime_attempt" ADD CONSTRAINT "runtime_attempt_workspace_change_fk" FOREIGN KEY ("workspace_id","change_id") REFERENCES "factory"."development_workspace"("id","change_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."runtime_attempt" ADD CONSTRAINT "runtime_attempt_workspace_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "factory"."development_workspace"("id","project_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "auth"."scimGroupMember" ADD CONSTRAINT "scimGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "auth"."scimGroup"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "auth"."scimGroupMember" ADD CONSTRAINT "scimGroupMember_scimUserId_fkey" FOREIGN KEY ("scimUserId") REFERENCES "auth"."scimUser"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "auth"."scimIdentityTombstone" ADD CONSTRAINT "scimIdentityTombstone_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "auth"."scimProjectionGrant" ADD CONSTRAINT "scimProjectionGrant_scimUserId_fkey" FOREIGN KEY ("scimUserId") REFERENCES "auth"."scimUser"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "auth"."scimProjectionGrant" ADD CONSTRAINT "scimProjectionGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "auth"."scimSubject" ADD CONSTRAINT "scimSubject_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "auth"."scimUser" ADD CONSTRAINT "scimUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."skill_library" ADD CONSTRAINT "skill_library_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."skill_library" ADD CONSTRAINT "skill_library_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "factory"."project"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."skill_library" ADD CONSTRAINT "skill_library_cover_updated_by_fkey" FOREIGN KEY ("cover_updated_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."skill_revision" ADD CONSTRAINT "skill_revision_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."skill_revision" ADD CONSTRAINT "skill_revision_library_id_fkey" FOREIGN KEY ("library_id") REFERENCES "factory"."skill_library"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."skill_revision" ADD CONSTRAINT "skill_revision_copied_from_fkey" FOREIGN KEY ("copied_from") REFERENCES "factory"."skill_revision"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."skill_revision" ADD CONSTRAINT "skill_revision_published_updated_by_fkey" FOREIGN KEY ("published_updated_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "auth"."ssoProvider" ADD CONSTRAINT "ssoProvider_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."substrate_provision" ADD CONSTRAINT "substrate_provision_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "factory"."project"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."substrate_source" ADD CONSTRAINT "substrate_source_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "factory"."development_workspace"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."technical_design_revision" ADD CONSTRAINT "technical_design_revision_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."technical_design_revision" ADD CONSTRAINT "technical_design_revision_planning_turn_id_fkey" FOREIGN KEY ("planning_turn_id") REFERENCES "factory"."agent_turn"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."technical_design_revision" ADD CONSTRAINT "technical_design_revision_previous_revision_id_fkey" FOREIGN KEY ("previous_revision_id") REFERENCES "factory"."technical_design_revision"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."technical_design_revision" ADD CONSTRAINT "technical_design_revision_requirement_revision_id_ticket_i_fkey" FOREIGN KEY ("requirement_revision_id","ticket_id") REFERENCES "factory"."requirement_revision"("id","ticket_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."technical_design_revision" ADD CONSTRAINT "technical_design_revision_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "factory"."ticket"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."technical_design_revision" ADD CONSTRAINT "technical_design_revision_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "factory"."agent_turn"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."ticket" ADD CONSTRAINT "ticket_converted_to_epic_id_fkey" FOREIGN KEY ("converted_to_epic_id") REFERENCES "factory"."epic"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."ticket" ADD CONSTRAINT "ticket_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."ticket" ADD CONSTRAINT "ticket_epic_id_project_id_fkey" FOREIGN KEY ("epic_id","project_id") REFERENCES "factory"."epic"("id","project_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."ticket" ADD CONSTRAINT "ticket_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "factory"."project"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."ticket" ADD CONSTRAINT "ticket_trashed_by_fkey" FOREIGN KEY ("trashed_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."ticket_conversation" ADD CONSTRAINT "ticket_conversation_active_coding_context_id_fkey" FOREIGN KEY ("active_coding_context_id") REFERENCES "factory"."conversation_context"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."ticket_conversation" ADD CONSTRAINT "ticket_conversation_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."ticket_conversation" ADD CONSTRAINT "ticket_conversation_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "factory"."project"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."ticket_conversation" ADD CONSTRAINT "ticket_conversation_ticket_id_project_id_fkey" FOREIGN KEY ("ticket_id","project_id") REFERENCES "factory"."ticket"("id","project_id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "factory"."ticket_dependency" ADD CONSTRAINT "ticket_dependency_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."ticket_dependency" ADD CONSTRAINT "ticket_dependency_prerequisite_id_project_id_fkey" FOREIGN KEY ("prerequisite_id","project_id") REFERENCES "factory"."ticket"("id","project_id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."ticket_dependency" ADD CONSTRAINT "ticket_dependency_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "factory"."project"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."ticket_dependency" ADD CONSTRAINT "ticket_dependency_ticket_id_project_id_fkey" FOREIGN KEY ("ticket_id","project_id") REFERENCES "factory"."ticket"("id","project_id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."ticket_document_revision" ADD CONSTRAINT "ticket_document_revision_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."ticket_document_revision" ADD CONSTRAINT "ticket_document_revision_proposal_entry_id_fkey" FOREIGN KEY ("proposal_entry_id") REFERENCES "factory"."conversation_entry"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."ticket_document_revision" ADD CONSTRAINT "ticket_document_revision_requirement_revision_id_ticket_id_fkey" FOREIGN KEY ("requirement_revision_id","ticket_id") REFERENCES "factory"."requirement_revision"("id","ticket_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."ticket_document_revision" ADD CONSTRAINT "ticket_document_revision_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "factory"."ticket"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."usage_entry" ADD CONSTRAINT "usage_entry_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "factory"."usage_operation"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."usage_operation" ADD CONSTRAINT "usage_operation_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "factory"."project"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "factory"."usage_operation" ADD CONSTRAINT "usage_operation_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."verification" ADD CONSTRAINT "verification_change_id_fkey" FOREIGN KEY ("change_id") REFERENCES "factory"."change"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."verification" ADD CONSTRAINT "verification_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."verification" ADD CONSTRAINT "verification_runtime_fk" FOREIGN KEY ("runtime_attempt_id","id") REFERENCES "factory"."runtime_attempt"("id","verification_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."workspace_share" ADD CONSTRAINT "workspace_share_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."workspace_share" ADD CONSTRAINT "workspace_share_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."workspace_share" ADD CONSTRAINT "workspace_share_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "factory"."development_workspace"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "factory"."workspace_shared_document" ADD CONSTRAINT "workspace_shared_document_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "factory"."development_workspace"("id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "agent_turn_active_boundary_uidx" ON "factory"."agent_turn" USING btree ("project_id",(
CASE
    WHEN "change_id" IS NULL AND ("input" ->> 'contextId'::text) IS NOT NULL THEN 'context:'::text || ("input" ->> 'contextId'::text)
    ELSE COALESCE("ticket_id"::text, 'draft:'::text || "created_by"::text)
END) text_ops) WHERE ("factory"."agent_turn"."state" = ANY (ARRAY['pending'::agent_turn_state, 'dispatching'::agent_turn_state, 'running'::agent_turn_state]));
CREATE INDEX "agent_turn_recovery_idx" ON "factory"."agent_turn" USING btree ("state","owner_expires_at") WHERE ("factory"."agent_turn"."state" = ANY (ARRAY['pending'::agent_turn_state, 'dispatching'::agent_turn_state, 'running'::agent_turn_state, 'uncertain'::agent_turn_state]));
CREATE UNIQUE INDEX "agent_turn_unresolved_change_boundary_uidx" ON "factory"."agent_turn" USING btree ("project_id","ticket_id") WHERE (("factory"."agent_turn"."change_id" IS NOT NULL) AND ("factory"."agent_turn"."state" = ANY (ARRAY['pending'::agent_turn_state, 'dispatching'::agent_turn_state, 'running'::agent_turn_state, 'uncertain'::agent_turn_state])));
CREATE INDEX "attachment_project_storage" ON "factory"."attachment" USING btree ("project_id","state");
CREATE INDEX "attachment_reference_target" ON "factory"."attachment_reference" USING btree ("kind","reference_id");
CREATE INDEX "audit_event_scope_idx" ON "factory"."audit_event" USING btree ("kind","scope_type","scope_id","created_at" DESC NULLS FIRST);
CREATE INDEX "audit_event_actor_idx" ON "factory"."audit_event" USING btree ("actor_id","created_at" DESC NULLS FIRST);
CREATE INDEX "auth_account_user_idx" ON "auth"."account" USING btree ("user_id");
CREATE INDEX "auth_session_user_idx" ON "auth"."session" USING btree ("user_id");
CREATE INDEX "auth_verification_identifier_idx" ON "auth"."verification" USING btree ("identifier");
CREATE UNIQUE INDEX "build_browser_one_unclosed_session" ON "factory"."build_browser_session" USING btree ("turn_id","owner_id") WHERE ("factory"."build_browser_session"."state" <> 'closed'::text);
CREATE INDEX "build_browser_session_cleanup_idx" ON "factory"."build_browser_session" USING btree ("runtime_attempt_id") WHERE ("factory"."build_browser_session"."state" <> 'closed'::text);
CREATE INDEX "candidate_review_change_idx" ON "factory"."candidate_review" USING btree ("change_id");
CREATE UNIQUE INDEX "candidate_review_finding_source_idx" ON "factory"."candidate_review" USING btree ("finding_source_id") WHERE (("factory"."candidate_review"."finding_source_id" IS NOT NULL) AND ("factory"."candidate_review"."supersedes_id" IS NULL));
CREATE UNIQUE INDEX "change_one_active_per_ticket" ON "factory"."change" USING btree ("ticket_id") WHERE ("factory"."change"."state" = ANY (ARRAY['branch-pending'::change_state, 'starting'::change_state, 'active'::change_state, 'cancelling'::change_state]));
CREATE UNIQUE INDEX "change_agent_opencode_session_uidx" ON "factory"."change_agent_session" USING btree ("opencode_session_id") WHERE ("factory"."change_agent_session"."opencode_session_id" IS NOT NULL);
CREATE UNIQUE INDEX "change_commit_one_active_uidx" ON "factory"."change_commit_operation" USING btree ("change_id") WHERE ("factory"."change_commit_operation"."state" <> ALL (ARRAY['succeeded'::change_commit_state, 'failed'::change_commit_state]));
CREATE UNIQUE INDEX "conversation_context_original" ON "factory"."conversation_context" USING btree ("conversation_id") WHERE "factory"."conversation_context"."original";
CREATE UNIQUE INDEX "conversation_entry_question_answer_uidx" ON "factory"."conversation_entry" USING btree ("in_reply_to_entry_id") WHERE (("factory"."conversation_entry"."kind" = 'answer'::conversation_entry_kind) AND ("factory"."conversation_entry"."in_reply_to_entry_id" IS NOT NULL));
CREATE UNIQUE INDEX "conversation_entry_requirement_uidx" ON "factory"."conversation_entry" USING btree ("requirement_revision_id") WHERE ("factory"."conversation_entry"."requirement_revision_id" IS NOT NULL);
CREATE UNIQUE INDEX "development_workspace_one_per_ticket" ON "factory"."development_workspace" USING btree ("ticket_id") WHERE ("factory"."development_workspace"."kind" = 'ticket'::development_workspace_kind);
CREATE UNIQUE INDEX "development_workspace_one_personal_per_user_project" ON "factory"."development_workspace" USING btree ("project_id","owner_user_id") WHERE ("factory"."development_workspace"."kind" = 'personal'::development_workspace_kind);
CREATE INDEX "epic_project_parent_idx" ON "factory"."epic" USING btree ("project_id","parent_id");
CREATE INDEX "epic_research_idx" ON "factory"."epic" USING gin (research_vector(title, description) tsvector_ops);
CREATE INDEX "epic_title_trgm_idx" ON "factory"."epic" USING gin (lower(title) gin_trgm_ops);
CREATE INDEX "knowledge_page_parent_order" ON "factory"."knowledge_page" USING btree ("project_id","parent_id","sort_order","id");
CREATE INDEX "knowledge_page_search_idx" ON "factory"."knowledge_page" USING gin (to_tsvector('simple'::regconfig, (title || ' '::text) || current_body) tsvector_ops);
CREATE INDEX "knowledge_research_idx" ON "factory"."knowledge_page" USING gin (research_vector(title, current_body) tsvector_ops);
CREATE INDEX "knowledge_title_trgm_idx" ON "factory"."knowledge_page" USING gin (lower(title) gin_trgm_ops);
CREATE INDEX "knowledge_page_outline_project" ON "factory"."knowledge_page_outline" USING btree ("project_id","state");
CREATE INDEX "learning_case_observed" ON "factory"."learning_case" USING btree ("project_id","owner_id","developer_only","settled_at") WHERE "factory"."learning_case"."selected";
CREATE INDEX "learning_case_pending" ON "factory"."learning_case" USING btree ("project_id","owner_id","developer_only","settled_at") WHERE ("factory"."learning_case"."selected" AND ("factory"."learning_case"."batch_id" IS NULL));
CREATE INDEX "learning_review_judge" ON "factory"."learning_review" USING btree ("judge_key","kind","state");
CREATE INDEX "monitoring_pending" ON "factory"."monitoring_incident" USING btree ("project_id","received_at","id") WHERE ("factory"."monitoring_incident"."state" = ANY (ARRAY['queued'::text, 'diagnosing'::text, 'implementing'::text]));
CREATE UNIQUE INDEX "monitoring_ticket" ON "factory"."monitoring_incident" USING btree ("ticket_id") WHERE ("factory"."monitoring_incident"."ticket_id" IS NOT NULL);
CREATE INDEX "oauthAccessToken_authorizationCodeId_idx" ON "auth"."oauthAccessToken" USING btree ("authorizationCodeId");
CREATE INDEX "oauthAccessToken_clientId_idx" ON "auth"."oauthAccessToken" USING btree ("clientId");
CREATE INDEX "oauthAccessToken_refreshId_idx" ON "auth"."oauthAccessToken" USING btree ("refreshId");
CREATE INDEX "oauthAccessToken_sessionId_idx" ON "auth"."oauthAccessToken" USING btree ("sessionId");
CREATE INDEX "oauthAccessToken_userId_idx" ON "auth"."oauthAccessToken" USING btree ("userId");
CREATE INDEX "oauthClient_userId_idx" ON "auth"."oauthClient" USING btree ("userId");
CREATE INDEX "oauthClientResource_clientId_idx" ON "auth"."oauthClientResource" USING btree ("clientId");
CREATE UNIQUE INDEX "oauthClientResource_clientId_resourceId_idx" ON "auth"."oauthClientResource" USING btree ("clientId","resourceId");
CREATE INDEX "oauthClientResource_resourceId_idx" ON "auth"."oauthClientResource" USING btree ("resourceId");
CREATE INDEX "oauthConsent_clientId_idx" ON "auth"."oauthConsent" USING btree ("clientId");
CREATE INDEX "oauthConsent_userId_idx" ON "auth"."oauthConsent" USING btree ("userId");
CREATE INDEX "oauthRefreshToken_authorizationCodeId_idx" ON "auth"."oauthRefreshToken" USING btree ("authorizationCodeId");
CREATE INDEX "oauthRefreshToken_clientId_idx" ON "auth"."oauthRefreshToken" USING btree ("clientId");
CREATE INDEX "oauthRefreshToken_sessionId_idx" ON "auth"."oauthRefreshToken" USING btree ("sessionId");
CREATE INDEX "oauthRefreshToken_userId_idx" ON "auth"."oauthRefreshToken" USING btree ("userId");
CREATE INDEX "operation_scope_idx" ON "factory"."operation" USING btree ("kind","scope_type","scope_id","created_at" DESC NULLS FIRST);
CREATE INDEX "operation_active_lease_idx" ON "factory"."operation" USING btree ("kind","state","lease_expires_at") WHERE "factory"."operation"."completed_at" IS NULL;
CREATE INDEX "project_membership_user_idx" ON "factory"."project_membership" USING btree ("user_id","project_id");
CREATE UNIQUE INDEX "project_release_one_active" ON "factory"."project_release" USING btree ("project_id") WHERE (("factory"."project_release"."state" = ANY (ARRAY['pending'::text, 'dispatching'::text, 'running'::text, 'checking'::text, 'publishing'::text, 'uncertain'::text])) AND ("factory"."project_release"."ended_at" IS NULL));
CREATE INDEX "read_version_scope" ON "factory"."read_version" USING btree ("scope","project_id");
CREATE INDEX "requirement_research_idx" ON "factory"."requirement_revision" USING gin (research_vector(''::text, canonical_content) tsvector_ops);
CREATE INDEX "review_feedback_delivery" ON "factory"."review_feedback" USING btree ("change_id") WHERE (("factory"."review_feedback"."kind" = 'thread'::text) AND ("factory"."review_feedback"."state" <> 'resolved'::text));
CREATE INDEX "review_media_retention" ON "factory"."review_media" USING btree ("change_id","kind","state");
CREATE INDEX "runtime_attempt_active_isolated_idx" ON "factory"."runtime_attempt" USING btree ("project_id","isolated_kind","state") WHERE (("factory"."runtime_attempt"."isolated_kind" IS NOT NULL) AND ("factory"."runtime_attempt"."state" = ANY (ARRAY['create-intended'::runtime_attempt_state, 'starting'::runtime_attempt_state, 'ready'::runtime_attempt_state, 'stop-intended'::runtime_attempt_state, 'stopping'::runtime_attempt_state, 'cleanup-failed'::runtime_attempt_state])));
CREATE UNIQUE INDEX "runtime_attempt_change_generation_uidx" ON "factory"."runtime_attempt" USING btree ("change_id","generation") WHERE ("factory"."runtime_attempt"."change_id" IS NOT NULL);
CREATE UNIQUE INDEX "runtime_attempt_one_active_per_change" ON "factory"."runtime_attempt" USING btree ("change_id") WHERE (("factory"."runtime_attempt"."change_id" IS NOT NULL) AND ("factory"."runtime_attempt"."state" <> ALL (ARRAY['stopped'::runtime_attempt_state, 'failed'::runtime_attempt_state])));
CREATE UNIQUE INDEX "runtime_attempt_one_active_per_workspace" ON "factory"."runtime_attempt" USING btree ("workspace_id") WHERE (("factory"."runtime_attempt"."workspace_id" IS NOT NULL) AND ("factory"."runtime_attempt"."state" <> ALL (ARRAY['stopped'::runtime_attempt_state, 'failed'::runtime_attempt_state])));
CREATE UNIQUE INDEX "runtime_attempt_workspace_generation_uidx" ON "factory"."runtime_attempt" USING btree ("workspace_id","generation") WHERE ("factory"."runtime_attempt"."workspace_id" IS NOT NULL);
CREATE INDEX "scimConnectionBinding_connectionId_idx" ON "auth"."scimConnectionBinding" USING btree ("connectionId");
CREATE INDEX "scimGroup_connectionId_idx" ON "auth"."scimGroup" USING btree ("connectionId");
CREATE INDEX "scimGroup_provisioningDomainId_idx" ON "auth"."scimGroup" USING btree ("provisioningDomainId");
CREATE INDEX "scimGroupMember_connectionId_idx" ON "auth"."scimGroupMember" USING btree ("connectionId");
CREATE INDEX "scimGroupMember_groupId_idx" ON "auth"."scimGroupMember" USING btree ("groupId");
CREATE INDEX "scimGroupMember_scimUserId_idx" ON "auth"."scimGroupMember" USING btree ("scimUserId");
CREATE INDEX "scimIdentityTombstone_connectionId_idx" ON "auth"."scimIdentityTombstone" USING btree ("connectionId");
CREATE INDEX "scimIdentityTombstone_provisioningDomainId_idx" ON "auth"."scimIdentityTombstone" USING btree ("provisioningDomainId");
CREATE INDEX "scimIdentityTombstone_userId_idx" ON "auth"."scimIdentityTombstone" USING btree ("userId");
CREATE INDEX "scimProjectionGrant_connectionId_idx" ON "auth"."scimProjectionGrant" USING btree ("connectionId");
CREATE INDEX "scimProjectionGrant_provisioningDomainId_idx" ON "auth"."scimProjectionGrant" USING btree ("provisioningDomainId");
CREATE INDEX "scimProjectionGrant_scimUserId_idx" ON "auth"."scimProjectionGrant" USING btree ("scimUserId");
CREATE INDEX "scimProjectionGrant_userId_idx" ON "auth"."scimProjectionGrant" USING btree ("userId");
CREATE INDEX "scimSubject_profileSourceId_idx" ON "auth"."scimSubject" USING btree ("profileSourceId");
CREATE INDEX "scimUser_connectionId_idx" ON "auth"."scimUser" USING btree ("connectionId");
CREATE INDEX "scimUser_provisioningDomainId_idx" ON "auth"."scimUser" USING btree ("provisioningDomainId");
CREATE INDEX "scimUser_userId_idx" ON "auth"."scimUser" USING btree ("userId");
CREATE INDEX "ticket_epic_idx" ON "factory"."ticket" USING btree ("project_id","epic_id");
CREATE INDEX "ticket_project_updated_idx" ON "factory"."ticket" USING btree ("project_id","updated_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);
CREATE INDEX "ticket_research_idx" ON "factory"."ticket" USING gin (research_vector(title, description) tsvector_ops);
CREATE INDEX "ticket_title_trgm_idx" ON "factory"."ticket" USING gin (lower(title) gin_trgm_ops);
CREATE UNIQUE INDEX "ticket_conversation_project_draft_uidx" ON "factory"."ticket_conversation" USING btree ("project_id","created_by") WHERE ("factory"."ticket_conversation"."ticket_id" IS NULL);
CREATE UNIQUE INDEX "ticket_conversation_ticket_uidx" ON "factory"."ticket_conversation" USING btree ("ticket_id") WHERE ("factory"."ticket_conversation"."ticket_id" IS NOT NULL);
CREATE INDEX "ticket_dependency_prerequisite_idx" ON "factory"."ticket_dependency" USING btree ("project_id","prerequisite_id");
CREATE INDEX "ticket_document_research_idx" ON "factory"."ticket_document_revision" USING gin (research_vector(title, canonical_content) tsvector_ops);
CREATE INDEX "usage_entry_time_idx" ON "factory"."usage_entry" USING btree ("occurred_at");
CREATE INDEX "usage_operation_scope_time_idx" ON "factory"."usage_operation" USING btree ("project_id","created_at");
CREATE UNIQUE INDEX "verification_one_active_per_change" ON "factory"."verification" USING btree ("change_id") WHERE ("factory"."verification"."state" = ANY (ARRAY['pending'::verification_state, 'runner-starting'::verification_state, 'running'::verification_state]));
-- Native 40-deferred-foreign-keys.sql.
-- Run after Drizzle creates these named FKs. Change attributes without duplicating definitions.

ALTER TABLE ONLY factory.knowledge_page
    ALTER CONSTRAINT knowledge_page_parent_project DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY factory.monitoring_hook
    ALTER CONSTRAINT monitoring_current_policy DEFERRABLE INITIALLY DEFERRED;

-- Native 50-common-triggers.sql.
-- Common triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER agent_untrashed_ticket BEFORE INSERT ON factory.agent_turn FOR EACH ROW EXECUTE FUNCTION factory.require_untrashed_ticket();

CREATE TRIGGER audit_event_immutable BEFORE UPDATE OR DELETE ON factory.audit_event FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER guard_operation BEFORE INSERT OR DELETE OR UPDATE ON factory.operation FOR EACH ROW EXECUTE FUNCTION factory.guard_operation();

CREATE TRIGGER installation_admission BEFORE INSERT ON factory.agent_turn FOR EACH ROW EXECUTE FUNCTION factory.require_installation_admission();

CREATE TRIGGER runtime_untrashed_ticket BEFORE INSERT ON factory.runtime_attempt FOR EACH ROW EXECUTE FUNCTION factory.require_untrashed_ticket();

-- Native 51-access-triggers.sql.
-- Access triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER check_session_access BEFORE INSERT OR UPDATE ON auth.session FOR EACH ROW EXECUTE FUNCTION factory.check_session_access();

CREATE TRIGGER initialize_account_access AFTER INSERT ON auth."user" FOR EACH ROW EXECUTE FUNCTION factory.initialize_account_access();

CREATE TRIGGER enqueue_account_revocation AFTER UPDATE ON factory.account_access FOR EACH ROW EXECUTE FUNCTION factory.enqueue_access_revocation();

CREATE TRIGGER enqueue_membership_revocation AFTER INSERT OR DELETE OR UPDATE ON factory.project_membership FOR EACH ROW EXECUTE FUNCTION factory.enqueue_access_revocation();

CREATE TRIGGER enqueue_project_access AFTER INSERT ON factory.project FOR EACH ROW EXECUTE FUNCTION factory.enqueue_access_revocation();

-- Native 52-attachments-triggers.sql.
-- Attachments triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER attachment_identity BEFORE UPDATE ON factory.attachment FOR EACH ROW EXECUTE FUNCTION factory.protect_attachment_identity();

CREATE TRIGGER attachment_reference_immutable BEFORE DELETE OR UPDATE ON factory.attachment_reference FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER conversation_attachments AFTER INSERT ON factory.conversation_entry FOR EACH ROW EXECUTE FUNCTION factory.bind_authored_attachments();

CREATE TRIGGER feedback_attachments AFTER INSERT ON factory.audit_event FOR EACH ROW WHEN (NEW.kind = 'review.feedback_message') EXECUTE FUNCTION factory.bind_authored_attachments();

CREATE TRIGGER knowledge_attachments AFTER INSERT ON factory.knowledge_revision FOR EACH ROW EXECUTE FUNCTION factory.bind_authored_attachments();

CREATE TRIGGER requirement_attachments AFTER INSERT ON factory.requirement_revision FOR EACH ROW EXECUTE FUNCTION factory.bind_authored_attachments();

CREATE TRIGGER ticket_attachments AFTER INSERT ON factory.ticket FOR EACH ROW EXECUTE FUNCTION factory.bind_authored_attachments();

CREATE TRIGGER ticket_document_attachments AFTER INSERT ON factory.ticket_document_revision FOR EACH ROW EXECUTE FUNCTION factory.bind_authored_attachments();

-- Native 53-planning-triggers.sql.
-- Planning triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER epic_hierarchy_guard BEFORE INSERT OR UPDATE OF id, project_id, parent_id ON factory.epic FOR EACH ROW EXECUTE FUNCTION factory.guard_tree_hierarchy('Epic', 'Epic hierarchy');

CREATE TRIGGER knowledge_hierarchy_guard BEFORE INSERT OR UPDATE OF id, project_id, parent_id ON factory.knowledge_page FOR EACH ROW EXECUTE FUNCTION factory.guard_tree_hierarchy('Wiki page', 'Wiki pages');

CREATE TRIGGER knowledge_revision_immutable BEFORE DELETE OR UPDATE ON factory.knowledge_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER requirement_approval_immutable BEFORE DELETE OR UPDATE ON factory.requirement_approval FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER requirement_revision_immutable BEFORE DELETE OR UPDATE ON factory.requirement_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER technical_design_revision_immutable BEFORE DELETE OR UPDATE ON factory.technical_design_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER ticket_dependency_guard BEFORE INSERT OR UPDATE ON factory.ticket_dependency FOR EACH ROW EXECUTE FUNCTION factory.guard_ticket_dependency();

CREATE TRIGGER ticket_document_revision_immutable BEFORE DELETE OR UPDATE ON factory.ticket_document_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

-- Native 54-conversation-triggers.sql.
-- Conversation triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER conversation_context_identity BEFORE UPDATE ON factory.conversation_context FOR EACH ROW EXECUTE FUNCTION factory.guard_immutable_columns('Conversation identity and archived history are immutable', 'lock-on:archived_session', 'archived_session', 'transcript');

CREATE TRIGGER conversation_entry_no_update BEFORE DELETE OR UPDATE ON factory.conversation_entry FOR EACH ROW EXECUTE FUNCTION factory.prevent_conversation_entry_mutation();

-- Native 55-coding-triggers.sql.
-- Coding triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER agent_turn_guard BEFORE INSERT OR UPDATE ON factory.agent_turn FOR EACH ROW EXECUTE FUNCTION factory.guard_agent_turn();

CREATE TRIGGER build_browser_session_guard BEFORE INSERT OR UPDATE ON factory.build_browser_session FOR EACH ROW EXECUTE FUNCTION factory.guard_build_browser_session();

CREATE TRIGGER change_agent_turn_intent_guard BEFORE INSERT OR UPDATE ON factory.change_agent_turn_intent FOR EACH ROW EXECUTE FUNCTION factory.guard_change_agent_turn_intent();

CREATE TRIGGER change_identity_immutable BEFORE UPDATE ON factory.change FOR EACH ROW EXECUTE FUNCTION factory.guard_immutable_columns('Change identity and source intent are immutable', 'update-only', 'state', 'version', 'cancel_requested_at', 'cancelled_at', 'failure', 'runtime_attempt_id', 'delivery_waiting_sha', 'delivery_waiting_policy_id');

CREATE TRIGGER change_prerequisites_guard BEFORE INSERT ON factory.change FOR EACH ROW EXECUTE FUNCTION factory.guard_change_prerequisites();

CREATE TRIGGER initialize_change_writer AFTER INSERT ON factory.change FOR EACH ROW EXECUTE FUNCTION factory.initialize_change_writer();

CREATE TRIGGER integration_intent BEFORE UPDATE ON factory.change_commit_operation FOR EACH ROW EXECUTE FUNCTION factory.guard_immutable_columns('Commit intent and integrated source are immutable', 'update-only', 'commit_sha', 'observed_remote_sha', 'state', 'last_error', 'updated_at', 'completed_at');

CREATE TRIGGER ticket_execution_revision BEFORE INSERT ON factory.runtime_attempt FOR EACH ROW EXECUTE FUNCTION factory.require_ticket_execution_revision();

-- Native 56-inputs-triggers.sql.
-- Inputs triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER agent_turn_skill_cascade_delete AFTER DELETE ON factory.agent_turn FOR EACH ROW EXECUTE FUNCTION factory.cascade_deleted_agent_turn_skills();

CREATE TRIGGER mcp_library_identity_immutable BEFORE DELETE OR UPDATE ON factory.mcp_library FOR EACH ROW EXECUTE FUNCTION factory.guard_immutable_columns('mcp_library identity is immutable', 'no-delete', 'cover_key', 'cover_version', 'cover_updated_by');

CREATE TRIGGER mcp_revision_immutable BEFORE DELETE OR UPDATE ON factory.mcp_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER model_connection_version_immutable BEFORE INSERT OR DELETE OR UPDATE ON factory.model_connection_version FOR EACH ROW EXECUTE FUNCTION factory.protect_model_connection_version();

CREATE TRIGGER skill_library_identity_immutable BEFORE DELETE OR UPDATE ON factory.skill_library FOR EACH ROW EXECUTE FUNCTION factory.guard_immutable_columns('skill_library identity is immutable', 'no-delete', 'cover_key', 'cover_version', 'cover_updated_by');

CREATE TRIGGER skill_revision_immutable BEFORE DELETE OR UPDATE ON factory.skill_revision FOR EACH ROW EXECUTE FUNCTION factory.guard_immutable_columns('skill_revision content is immutable', 'no-delete', 'published', 'published_updated_by', 'published_updated_at');

-- Native 57-learning-triggers.sql.
-- Learning triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER learning_case_guard BEFORE UPDATE ON factory.learning_case FOR EACH ROW EXECUTE FUNCTION factory.guard_learning_record();

CREATE TRIGGER learning_proposal_guard BEFORE UPDATE ON factory.learning_proposal FOR EACH ROW EXECUTE FUNCTION factory.guard_learning_record();

CREATE TRIGGER learning_review_guard BEFORE UPDATE ON factory.learning_review FOR EACH ROW EXECUTE FUNCTION factory.guard_learning_record();

-- Native 58-usage-triggers.sql.
-- Usage triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER guard_usage_entry BEFORE UPDATE ON factory.usage_entry FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER guard_usage_operation BEFORE UPDATE ON factory.usage_operation FOR EACH ROW EXECUTE FUNCTION factory.guard_usage_operation();

-- Native 59-runtime-triggers.sql.
-- Runtime triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER runtime_attempt_identity_immutable BEFORE INSERT OR DELETE OR UPDATE ON factory.runtime_attempt FOR EACH ROW EXECUTE FUNCTION factory.protect_runtime_attempt_identity();

CREATE TRIGGER substrate_source_identity BEFORE INSERT OR DELETE OR UPDATE ON factory.substrate_source FOR EACH ROW EXECUTE FUNCTION factory.protect_substrate_source();

CREATE TRIGGER substrate_provision_identity BEFORE INSERT OR DELETE OR UPDATE ON factory.substrate_provision FOR EACH ROW EXECUTE FUNCTION factory.protect_substrate_provision();

-- Native 60-delivery-triggers.sql.
-- Delivery triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER candidate_review_guard BEFORE UPDATE ON factory.candidate_review FOR EACH ROW EXECUTE FUNCTION factory.guard_candidate_review();

CREATE TRIGGER delivery_approval_immutable BEFORE DELETE OR UPDATE ON factory.delivery_approval FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER monitoring_policy_immutable BEFORE DELETE OR UPDATE ON factory.monitoring_policy FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER project_release_identity BEFORE UPDATE ON factory.project_release FOR EACH ROW EXECUTE FUNCTION factory.protect_project_release_identity();

-- Native 61-verification-triggers.sql.
-- Verification triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER verification_job_binding BEFORE UPDATE ON factory.verification FOR EACH ROW EXECUTE FUNCTION factory.protect_verification_job_binding();

-- Native 62-projections-triggers.sql.
-- Projections triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER knowledge_page_outline AFTER INSERT OR DELETE OR UPDATE ON factory.knowledge_page FOR EACH ROW EXECUTE FUNCTION factory.project_knowledge_page_outline();

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.account_access DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.administrator DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.agent_turn DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT ON factory.audit_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((NEW.kind = 'tickets.responsibility_event' AND NEW.scope_type = 'ticket') OR (NEW.kind = 'access.change_editing_decision' AND NEW.scope_type = 'change') OR (NEW.kind = 'review.feedback_message' AND NEW.scope_type = 'review_feedback')) EXECUTE FUNCTION factory.invalidate_factory_reads();

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.candidate_review DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.change DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.change_agent_session DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.change_writer DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.conversation_context DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.conversation_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.delivery_approval DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.knowledge_page DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.monitoring_hook DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.monitoring_incident DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.operation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.project DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.project_membership DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.requirement_approval DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.requirement_revision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.review_feedback DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.review_media DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.runtime_attempt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.technical_design_revision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.ticket DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.ticket_conversation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.ticket_document_revision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.verification DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();

CREATE CONSTRAINT TRIGGER settings_read_version AFTER INSERT OR DELETE OR UPDATE ON factory.mcp_connection DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_settings_reads();

CREATE CONSTRAINT TRIGGER settings_read_version AFTER INSERT OR DELETE OR UPDATE ON factory.mcp_library DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_settings_reads();

CREATE CONSTRAINT TRIGGER settings_read_version AFTER INSERT OR DELETE OR UPDATE ON factory.mcp_revision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_settings_reads();

CREATE CONSTRAINT TRIGGER settings_read_version AFTER INSERT OR DELETE OR UPDATE ON factory.monitoring_hook DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_settings_reads();

CREATE CONSTRAINT TRIGGER settings_read_version AFTER INSERT OR DELETE OR UPDATE ON factory.monitoring_incident DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_settings_reads();

CREATE CONSTRAINT TRIGGER settings_read_version AFTER INSERT OR DELETE OR UPDATE ON factory.operation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_settings_reads();

CREATE CONSTRAINT TRIGGER settings_read_version AFTER INSERT OR DELETE OR UPDATE ON factory.project_membership DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_settings_reads();

CREATE CONSTRAINT TRIGGER settings_read_version AFTER INSERT OR DELETE OR UPDATE ON factory.project_release DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_settings_reads();

-- Native 70-delivery-view.sql.
-- Run after all Drizzle tables. Retain the current-promotion projection and invoker security.

CREATE VIEW factory.current_promotion WITH (security_invoker='true') AS
 SELECT DISTINCT ON (scope_id) id,
    scope_id::uuid AS change_id,
    (payload->>'projectId')::uuid AS project_id,
    payload->>'commitSha' AS commit_sha,
    NULLIF(payload->>'previousRuntimeAttemptId', '')::uuid AS previous_runtime_attempt_id,
    NULLIF(payload->>'replacementRuntimeAttemptId', '')::uuid AS replacement_runtime_attempt_id,
    state,
    error AS last_error,
    created_at AS requested_at,
    updated_at,
    completed_at,
    (payload->>'ordinal')::integer AS ordinal,
    NULLIF(payload->>'supersedesId', '')::uuid AS supersedes_id,
    NULLIF(payload->>'retryCommandId', '')::uuid AS retry_command_id
   FROM factory.operation
  WHERE kind = 'delivery.promotion' AND scope_type = 'change'
  ORDER BY scope_id, (payload->>'ordinal')::integer DESC;

-- Native 71-zero-publication.sql.
-- Run after all Drizzle tables. Only these eight relations belong to Zero replication.

CREATE PUBLICATION factory_zero_publication WITH (publish = 'insert, update, delete, truncate');

ALTER PUBLICATION factory_zero_publication ADD TABLE ONLY factory.epic;

ALTER PUBLICATION factory_zero_publication ADD TABLE ONLY factory.knowledge_page;

ALTER PUBLICATION factory_zero_publication ADD TABLE ONLY factory.knowledge_page_outline;

ALTER PUBLICATION factory_zero_publication ADD TABLE ONLY factory.project;

ALTER PUBLICATION factory_zero_publication ADD TABLE ONLY factory.project_membership;

ALTER PUBLICATION factory_zero_publication ADD TABLE ONLY factory.read_version;

ALTER PUBLICATION factory_zero_publication ADD TABLE ONLY factory.ticket;

ALTER PUBLICATION factory_zero_publication ADD TABLE ONLY factory.ticket_dependency;

-- Native 80-installation-seeds.sql.
-- Seed the two installation singletons after tables and native guards.
-- schema_migration registration belongs to the composer and its final source digest.

INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload)
VALUES(gen_random_uuid(),'installation.maintenance','installation','00000000-0000-0000-0000-000000000000','installation.maintenance:singleton',NULL,'disabled','{"singleton":true,"enabled":false,"requestedAt":null}'::jsonb);

INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,state,payload)
VALUES(gen_random_uuid(),'attachment.storage','installation','00000000-0000-0000-0000-000000000000','attachment.storage:singleton','ready','{}'::jsonb);

-- Baseline registration.
INSERT INTO factory.schema_migration(version,source_digest) VALUES(1,'11b6090c2fd96a55537d4bf1ef8d81a27859f6ade214a365ade3255a5ce1efc4');
COMMIT;
