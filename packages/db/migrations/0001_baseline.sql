BEGIN;

SET LOCAL check_function_bodies = false;

SELECT pg_catalog.set_config('search_path', '', false);

CREATE SCHEMA auth;

CREATE SCHEMA factory;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA factory;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA factory;

CREATE TYPE factory.agent_turn_state AS ENUM (
    'pending',
    'dispatching',
    'running',
    'completed',
    'failed',
    'stopped',
    'uncertain'
);

CREATE TYPE factory.branch_operation_state AS ENUM (
    'pending',
    'executing',
    'ambiguous',
    'succeeded',
    'failed',
    'cancelled'
);

CREATE TYPE factory.change_agent_state AS ENUM (
    'starting',
    'working',
    'waiting',
    'stopped',
    'failed',
    'committed'
);

CREATE TYPE factory.change_commit_source AS ENUM (
    'agent',
    'repository-document'
);

CREATE TYPE factory.change_commit_state AS ENUM (
    'commit-intended',
    'committed',
    'push-intended',
    'succeeded',
    'failed'
);

CREATE TYPE factory.change_state AS ENUM (
    'branch-pending',
    'starting',
    'active',
    'cancelling',
    'cancelled',
    'failed',
    'delivering',
    'delivered'
);

CREATE TYPE factory.conversation_actor AS ENUM (
    'user',
    'project-agent',
    'change-agent',
    'system'
);

CREATE TYPE factory.conversation_entry_kind AS ENUM (
    'user-message',
    'agent-message',
    'question',
    'answer',
    'requirement',
    'mode-change'
);

CREATE TYPE factory.conversation_mode AS ENUM (
    'investigate',
    'plan',
    'build'
);

CREATE TYPE factory.development_workspace_kind AS ENUM (
    'personal',
    'ticket'
);

CREATE TYPE factory.isolated_runtime_kind AS ENUM (
    'staging',
    'verification',
    'prebuild',
    'publication'
);

CREATE TYPE factory.knowledge_generation_state AS ENUM (
    'pending',
    'running',
    'succeeded',
    'failed'
);

CREATE TYPE factory.knowledge_page_state AS ENUM (
    'active',
    'archived'
);

CREATE TYPE factory.knowledge_revision_kind AS ENUM (
    'generated',
    'human',
    'proposed'
);

CREATE TYPE factory.merge_operation_state AS ENUM (
    'pending',
    'executing',
    'ambiguous',
    'succeeded',
    'failed'
);

CREATE TYPE factory.promotion_operation_state AS ENUM (
    'pending',
    'starting',
    'switching',
    'succeeded',
    'failed'
);

CREATE TYPE factory.pull_request_operation_state AS ENUM (
    'pending',
    'executing',
    'ambiguous',
    'succeeded',
    'failed'
);

CREATE TYPE factory.runtime_attempt_state AS ENUM (
    'create-intended',
    'starting',
    'ready',
    'stop-intended',
    'stopping',
    'stopped',
    'cleanup-failed',
    'failed',
    'pausing',
    'paused',
    'resuming'
);

CREATE TYPE factory.ticket_state AS ENUM (
    'inbox',
    'backlog',
    'ready',
    'in-progress',
    'cancelled',
    'done'
);

CREATE TYPE factory.verification_state AS ENUM (
    'pending',
    'runner-starting',
    'running',
    'succeeded',
    'failed',
    'cancelled'
);

CREATE FUNCTION factory.assign_project_background() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.desktop_background_key IS NULL THEN
    -- Both registration paths and concurrent creates share one allocation boundary.
    PERFORM pg_advisory_xact_lock(hashtextextended('factory-project-background-allocation',0));
    SELECT catalogue.key INTO NEW.desktop_background_key
    FROM unnest(ARRAY[
      'river-landscape','the-harvesters','mountainous-landscape',
      'gulf-of-marseille','scene-on-the-ice','moonlit-landscape'
    ]) AS catalogue(key)
    LEFT JOIN factory.project project ON project.desktop_background_key=catalogue.key
      AND (
        EXISTS(SELECT 1 FROM factory.administrator WHERE user_id=NEW.created_by)
        OR EXISTS(SELECT 1 FROM factory.project_membership
          WHERE project_id=project.id AND user_id=NEW.created_by)
      )
    GROUP BY catalogue.key
    ORDER BY count(project.id), random()
    LIMIT 1;
  END IF;
  RETURN NEW;
END $$;

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
      JOIN factory.change c ON c.id=f.change_id WHERE f.id=NEW.feedback_id;
    actor := NEW.author_id; reference_kind := 'feedback'; target := NEW.id; content := NEW.body;
  END IF;
  PERFORM factory.bind_attachment_references(project,actor,reference_kind,target,content,shared);
  IF TG_TABLE_NAME='ticket' THEN
    DELETE FROM factory.attachment_draft WHERE id=NEW.id AND owner_id=NEW.created_by AND project_id=NEW.project_id;
  END IF;
  RETURN NEW;
END $$;

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
DECLARE target uuid;
BEGIN
  IF TG_TABLE_NAME = 'account_access' THEN
    IF NEW.disabled_at IS NOT DISTINCT FROM OLD.disabled_at AND
       NEW.directory_disabled_at IS NOT DISTINCT FROM OLD.directory_disabled_at THEN
      RETURN NEW;
    END IF;
    target := NEW.user_id;
    IF NEW.disabled_at IS NOT NULL OR NEW.directory_disabled_at IS NOT NULL THEN
      DELETE FROM auth.session WHERE user_id=target;
    END IF;
  ELSE
    IF TG_OP = 'UPDATE' AND NEW.role = OLD.role AND NEW.manage_project = OLD.manage_project THEN
      RETURN NEW;
    END IF;
    target := COALESCE(NEW.user_id, OLD.user_id);
  END IF;
  INSERT INTO factory.access_revocation(user_id) VALUES(target)
    ON CONFLICT(user_id) DO UPDATE SET version=access_revocation.version+1,updated_at=now();
  PERFORM pg_notify('factory_access_revoked', target::text);
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE FUNCTION factory.enqueue_project_access() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO factory.access_revocation(user_id)
    SELECT user_id FROM factory.administrator
    UNION SELECT user_id FROM factory.project_membership WHERE project_id=NEW.id
    ON CONFLICT(user_id) DO UPDATE SET version=access_revocation.version+1,updated_at=now();
  PERFORM pg_notify('factory_access_revoked', NEW.id::text);
  RETURN NEW;
END $$;

CREATE FUNCTION factory.guard_active_coding_context() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.active_coding_context_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM factory.conversation_context context JOIN factory.change change ON change.id=context.change_id
    WHERE context.id=NEW.active_coding_context_id AND context.conversation_id=NEW.id
      AND context.kind='coding' AND NOT context.original AND change.ticket_id=NEW.ticket_id
      AND change.project_id=NEW.project_id
  ) THEN RAISE EXCEPTION 'Active Coding context must belong to this Ticket conversation'; END IF;
  RETURN NEW;
END $$;

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

CREATE FUNCTION factory.guard_build_browser_ordinal() RETURNS trigger
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
  ELSIF NEW.reopen_allowed THEN
    RAISE EXCEPTION 'Browser recovery requires a confirmed Connector failure';
  ELSIF NEW.ordinal > 1 AND NOT EXISTS (
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
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.guard_build_browser_session() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
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
  ELSE
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

CREATE FUNCTION factory.guard_candidate_review() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.id,NEW.verification_id,NEW.change_id,NEW.commit_sha,NEW.base_sha,NEW.created_at,NEW.repair_command_id,NEW.ordinal,NEW.created_by,NEW.supersedes_id)
    IS DISTINCT FROM ROW(OLD.id,OLD.verification_id,OLD.change_id,OLD.commit_sha,OLD.base_sha,OLD.created_at,OLD.repair_command_id,OLD.ordinal,OLD.created_by,OLD.supersedes_id)
    OR (OLD.turn_id IS NOT NULL AND NEW.turn_id IS DISTINCT FROM OLD.turn_id)
    OR (OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result)
    OR (OLD.state IN ('passed','changes-requested','incomplete') AND
      ROW(NEW.state,NEW.evidence,NEW.completed_at) IS DISTINCT FROM ROW(OLD.state,OLD.evidence,OLD.completed_at))
  THEN RAISE EXCEPTION 'Candidate review intent and confirmed outcome are immutable'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION factory.guard_change_agent_turn_intent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM factory.agent_turn WHERE id = NEW.turn_id
      AND change_id = NEW.change_id AND authority->>'mode' = 'build') THEN
      RAISE EXCEPTION 'Change Agent intent scope mismatch';
    END IF;
  ELSE
    IF ROW(NEW.turn_id, NEW.change_id, NEW.session_id, NEW.prompt_id, NEW.prompt_text,
      NEW.bootstrap, NEW.session_title, NEW.created_at) IS DISTINCT FROM
      ROW(OLD.turn_id, OLD.change_id, OLD.session_id, OLD.prompt_id, OLD.prompt_text,
      OLD.bootstrap, OLD.session_title, OLD.created_at)
      OR (OLD.runtime_attempt_id IS NOT NULL AND NEW.runtime_attempt_id IS DISTINCT FROM OLD.runtime_attempt_id) THEN
      RAISE EXCEPTION 'Change Agent dispatch intent is immutable';
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

CREATE FUNCTION factory.guard_conversation_context() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (NEW.id,NEW.conversation_id,NEW.command_id,NEW.kind,NEW.mode,NEW.ordinal,NEW.title,
    NEW.created_by,NEW.created_at,NEW.change_id,NEW.native_session_id,NEW.previous_context_id,NEW.original)
    IS DISTINCT FROM (OLD.id,OLD.conversation_id,OLD.command_id,OLD.kind,OLD.mode,OLD.ordinal,OLD.title,
    OLD.created_by,OLD.created_at,OLD.change_id,OLD.native_session_id,OLD.previous_context_id,OLD.original)
    OR OLD.archived_session IS NOT NULL THEN
    RAISE EXCEPTION 'Conversation identity and archived history are immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION factory.guard_epic_hierarchy() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.project_id <> OLD.project_id) THEN
    RAISE EXCEPTION 'Epic identity and Project are immutable' USING ERRCODE = '23514';
  END IF;
  PERFORM id FROM factory.project WHERE id = NEW.project_id FOR UPDATE;
  IF EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_id FROM factory.epic WHERE id = NEW.parent_id AND project_id = NEW.project_id
      UNION
      SELECT parent.id, parent.parent_id FROM factory.epic parent
      JOIN ancestors child ON parent.id = child.parent_id WHERE parent.project_id = NEW.project_id
    )
    -- During a multi-row INSERT the closing Epic might not exist yet.
    SELECT 1 FROM ancestors WHERE id = NEW.id OR parent_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'Epic hierarchy cannot contain a cycle' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.guard_knowledge_hierarchy() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id) THEN
    RAISE EXCEPTION 'Wiki page identity and Project are immutable' USING ERRCODE='23514';
  END IF;
  PERFORM id FROM factory.project WHERE id=NEW.project_id FOR UPDATE;
  IF EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT id,parent_id FROM factory.knowledge_page WHERE id=NEW.parent_id AND project_id=NEW.project_id
      UNION
      SELECT parent.id,parent.parent_id FROM factory.knowledge_page parent
      JOIN ancestors child ON parent.id=child.parent_id WHERE parent.project_id=NEW.project_id
    ) SELECT 1 FROM ancestors WHERE id=NEW.id OR parent_id=NEW.id
  ) THEN
    RAISE EXCEPTION 'Wiki pages cannot contain a cycle' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.guard_loaded_skill() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM factory.agent_turn WHERE id = OLD.turn_id) THEN
    RETURN OLD;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Loaded Skill identities are immutable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM factory.agent_turn WHERE id = NEW.turn_id
    AND state IN ('dispatching', 'running') AND authority->'skillRevisionIds' ? NEW.revision_id::text) THEN
    RAISE EXCEPTION 'Loaded Skill revision was not admitted';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.guard_native_skill_intent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.skill_loading, NEW.skill_manifest, NEW.skill_attachments) IS DISTINCT FROM ROW(OLD.skill_loading, OLD.skill_manifest, OLD.skill_attachments) THEN
    RAISE EXCEPTION 'Admitted skill package is immutable';
  END IF;
  IF (NEW.skill_loading = 'native') != (NEW.skill_manifest IS NOT NULL) THEN RAISE EXCEPTION 'Native skill package is required'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.guard_project_repository_intent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (NEW.command_id,NEW.setup_id,NEW.user_id,NEW.project_id,NEW.name,NEW.slug,NEW.kind,
      NEW.source_url,NEW.credential_key,NEW.fingerprint,NEW.created_at)
    IS DISTINCT FROM (OLD.command_id,OLD.setup_id,OLD.user_id,OLD.project_id,OLD.name,OLD.slug,OLD.kind,
      OLD.source_url,OLD.credential_key,OLD.fingerprint,OLD.created_at)
    OR (OLD.state='committed' AND (NEW.state,NEW.default_branch,NEW.completed_at)
      IS DISTINCT FROM (OLD.state,OLD.default_branch,OLD.completed_at))
    OR (OLD.credential_removed_at IS NOT NULL AND NEW.credential_removed_at IS DISTINCT FROM OLD.credential_removed_at)
  THEN RAISE EXCEPTION 'Project repository intent is immutable'; END IF;
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

CREATE FUNCTION factory.guard_setup_inspection() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (NEW.id,NEW.project_id,NEW.source_commit,NEW.model_id,NEW.connection_id,NEW.connection_version,NEW.created_by,NEW.created_at,NEW.parent_id,NEW.answers)
    IS DISTINCT FROM (OLD.id,OLD.project_id,OLD.source_commit,OLD.model_id,OLD.connection_id,OLD.connection_version,OLD.created_by,OLD.created_at,OLD.parent_id,OLD.answers)
    OR (OLD.output IS NOT NULL AND NEW.output IS DISTINCT FROM OLD.output)
    OR (OLD.state IN ('confirmed','complete') AND NEW.state<>OLD.state)
  THEN RAISE EXCEPTION 'Setup inspection intent and published proposal are immutable'; END IF;
  RETURN NEW;
END $$;

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

CREATE FUNCTION factory.guard_usage_entry() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN RAISE EXCEPTION 'Usage observations are immutable'; END;
$$;

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

CREATE FUNCTION factory.initialize_account_access() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO factory.account_access(user_id) VALUES (NEW.id);
  RETURN NEW;
END $$;

CREATE FUNCTION factory.initialize_change_writer() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO factory.change_writer(change_id) VALUES(NEW.id);
  RETURN NEW;
END;
$$;

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

CREATE FUNCTION factory.protect_branch_operation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.change_id <> OLD.change_id
    OR NEW.repository_owner <> OLD.repository_owner
    OR NEW.repository_name <> OLD.repository_name
    OR NEW.branch_name <> OLD.branch_name
    OR NEW.start_sha <> OLD.start_sha
    OR NEW.idempotency_key <> OLD.idempotency_key
    OR (OLD.state IN ('succeeded', 'failed', 'cancelled') AND NEW IS DISTINCT FROM OLD)
  THEN
    RAISE EXCEPTION 'Branch create intent or terminal result is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.protect_change_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.project_id <> OLD.project_id
    OR NEW.ticket_id <> OLD.ticket_id
    OR NEW.requirement_approval_id <> OLD.requirement_approval_id
    OR NEW.branch_name <> OLD.branch_name
    OR NEW.base_sha <> OLD.base_sha
    OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'Change identity and source intent are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.protect_developer_ide_intent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.service_epoch < OLD.service_epoch THEN
    RAISE EXCEPTION 'Developer IDE identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.service_epoch = OLD.service_epoch AND (
    NEW.resource_id IS DISTINCT FROM OLD.resource_id OR
    NEW.image IS DISTINCT FROM OLD.image OR
    (OLD.namespace_uid IS NOT NULL AND NEW.namespace_uid IS DISTINCT FROM OLD.namespace_uid) OR
    (OLD.pod_uid IS NOT NULL AND NEW.pod_uid IS DISTINCT FROM OLD.pod_uid)
  ) THEN RAISE EXCEPTION 'Developer IDE intent outcome is immutable' USING ERRCODE = '23514'; END IF;
  IF NEW.service_epoch <> OLD.service_epoch AND (
    NEW.service_epoch <> OLD.service_epoch + 1 OR OLD.state <> 'stopped' OR NEW.state <> 'create-intended' OR
    NEW.pod_uid IS NOT NULL OR
    CASE WHEN NEW.resource_id = OLD.resource_id
      THEN NEW.namespace_uid IS DISTINCT FROM OLD.namespace_uid
      ELSE OLD.resource_id <> OLD.user_id OR NEW.resource_id = NEW.user_id OR NEW.namespace_uid IS NOT NULL
    END
  ) THEN RAISE EXCEPTION 'Stop the Developer IDE before issuing a new epoch' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.protect_development_workspace_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.project_id <> OLD.project_id
    OR NEW.kind <> OLD.kind
    OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.ticket_id IS DISTINCT FROM OLD.ticket_id
    OR NEW.change_id IS DISTINCT FROM OLD.change_id
    OR NEW.source_branch <> OLD.source_branch
    OR NEW.source_revision <> OLD.source_revision
    OR NEW.kubernetes_namespace <> OLD.kubernetes_namespace
    OR NEW.volume_name <> OLD.volume_name
    OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'Development Workspace identity and source are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.protect_execution_slot() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR NEW.role <> OLD.role OR NEW.runtime_host_image <> OLD.runtime_host_image
      OR NEW.kubernetes_namespace <> OLD.kubernetes_namespace OR NEW.created_at <> OLD.created_at
      OR NEW.expires_at <> OLD.expires_at
      OR (OLD.namespace_uid IS NOT NULL AND NEW.namespace_uid IS DISTINCT FROM OLD.namespace_uid)
      OR (OLD.pod_uid IS NOT NULL AND NEW.pod_uid IS DISTINCT FROM OLD.pod_uid)
      OR (OLD.claim_uid IS NOT NULL AND NEW.claim_uid IS DISTINCT FROM OLD.claim_uid)
      OR (OLD.assigned_attempt_id IS NOT NULL AND
        (NEW.assigned_attempt_id IS DISTINCT FROM OLD.assigned_attempt_id OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at)) THEN
      RAISE EXCEPTION 'Execution slot identity and assignment are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.state <> OLD.state AND NOT (
      (OLD.state = 'creating' AND NEW.state IN ('ready','retiring')) OR
      (OLD.state = 'ready' AND NEW.state IN ('assigned','retiring')) OR
      (OLD.state = 'retiring' AND NEW.state = 'deleted') OR
      (OLD.state = 'assigned' AND NEW.state = 'deleted')
    ) THEN
      RAISE EXCEPTION 'Execution slots cannot return to the reserve' USING ERRCODE = '23514';
    END IF;
    IF NEW.assigned_attempt_id IS DISTINCT FROM OLD.assigned_attempt_id AND
      (OLD.state <> 'ready' OR NEW.state <> 'assigned') THEN
      RAISE EXCEPTION 'Only a ready execution slot may be assigned once' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.state <> 'creating' OR NEW.assigned_attempt_id IS NOT NULL OR NEW.namespace_uid IS NOT NULL OR NEW.pod_uid IS NOT NULL THEN
    RAISE EXCEPTION 'Execution slots require clean create intent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.protect_factorybox_operation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.id,NEW.runtime_attempt_id,NEW.action,NEW.snapshot_id,NEW.intended_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.runtime_attempt_id,OLD.action,OLD.snapshot_id,OLD.intended_at)
    OR (OLD.attempted_at IS NOT NULL AND NEW.attempted_at IS DISTINCT FROM OLD.attempted_at)
    OR (OLD.completed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Factorybox lifecycle intent and completed observation are immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION factory.protect_factorybox_runtime() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM factory.runtime_attempt WHERE id=NEW.runtime_attempt_id
      AND state='starting' AND stop_intended_at IS NULL) THEN
      RAISE EXCEPTION 'Factorybox preparation requires its active Runtime Attempt';
    END IF;
  ELSIF NEW.runtime_attempt_id<>OLD.runtime_attempt_id OR NEW.request IS DISTINCT FROM OLD.request
    OR NEW.created_at<>OLD.created_at OR (OLD.identity IS NOT NULL AND NEW.identity IS DISTINCT FROM OLD.identity) THEN
    RAISE EXCEPTION 'Factorybox request and admitted identity are immutable';
  END IF;
  IF TG_OP='UPDATE' AND OLD.inputs_released_at IS NOT NULL AND NEW.inputs_released_at IS DISTINCT FROM OLD.inputs_released_at THEN
    RAISE EXCEPTION 'Factorybox input release observation is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION factory.protect_factorybox_slot() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.factorybox_profile IS DISTINCT FROM OLD.factorybox_profile
    OR (OLD.factorybox_identity IS NOT NULL AND NEW.factorybox_identity IS DISTINCT FROM OLD.factorybox_identity)
    OR (OLD.factorybox_preparation IS NOT NULL AND NEW.factorybox_preparation IS DISTINCT FROM OLD.factorybox_preparation)
    OR (OLD.factorybox_start_attempted AND NOT NEW.factorybox_start_attempted)
    OR (OLD.factorybox_pause_attempted AND NOT NEW.factorybox_pause_attempted)
    OR (OLD.factorybox_resume_attempted AND NOT NEW.factorybox_resume_attempted) THEN
    RAISE EXCEPTION 'Factorybox execution slot artifacts and admitted identity are immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION factory.protect_model_connection_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Model connection versions are immutable' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM factory.model_connection_write WHERE connection_id=NEW.connection_id
    AND base_version=NEW.version-1 AND provider=NEW.provider AND endpoint=NEW.endpoint
    AND secret_key=NEW.secret_key AND created_by=NEW.created_by AND state='write-intended') THEN
    RAISE EXCEPTION 'Model connection requires its exact write intent' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.protect_model_connection_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR OLD.state <> 'write-intended' OR NEW.state <> 'committed'
    OR (to_jsonb(NEW) - 'state' - 'committed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'committed_at')
    OR NEW.committed_at IS NULL THEN
    RAISE EXCEPTION 'Model connection write identity and outcome are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.protect_model_role_probe() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR OLD.state <> 'probing' OR NEW.state NOT IN ('finished','uncertain')
    OR (to_jsonb(NEW) - 'state' - 'result' - 'finished_at') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'result' - 'finished_at')
    OR NEW.finished_at IS NULL THEN
    RAISE EXCEPTION 'Model probe intent and result are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.protect_project_image_preparation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.environment<>OLD.environment OR NEW.revision<>OLD.revision OR NEW.environment_version<>OLD.environment_version OR NEW.created_at<>OLD.created_at
    OR (OLD.runtime_attempt_id IS NOT NULL AND NEW.runtime_attempt_id IS DISTINCT FROM OLD.runtime_attempt_id)
    OR (OLD.state IN ('succeeded','unsupported','failed') AND (NEW.state<>OLD.state OR NEW.identity IS DISTINCT FROM OLD.identity OR NEW.image IS DISTINCT FROM OLD.image)) THEN
    RAISE EXCEPTION 'Project image preparation intent and confirmed outcome are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.runtime_attempt_id IS NOT NULL AND OLD.runtime_attempt_id IS NULL AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt WHERE id=NEW.runtime_attempt_id AND project_id=NEW.project_id AND revision=NEW.revision AND isolated_kind='prebuild' AND state='create-intended' AND stop_intended_at IS NULL) THEN
    RAISE EXCEPTION 'Image preparation must reference matching producer intent' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

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

CREATE FUNCTION factory.protect_runtime_artifact_intent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE intended_role text;
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Runtime artifact intent is immutable' USING ERRCODE='23514'; END IF;
  SELECT CASE WHEN isolated_kind IN ('verification','publication') THEN 'verification'
    WHEN isolated_kind='staging' THEN 'staging'
    WHEN change_id IS NOT NULL AND workspace_id IS NOT NULL THEN 'build' ELSE 'development' END
    INTO intended_role FROM factory.runtime_attempt
    WHERE id=NEW.runtime_attempt_id AND state='create-intended' AND stop_intended_at IS NULL;
  IF intended_role IS NULL OR intended_role<>NEW.role THEN
    RAISE EXCEPTION 'Runtime artifacts require matching active create intent' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;

CREATE FUNCTION factory.protect_runtime_attempt_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.project_id <> OLD.project_id
    OR NEW.change_id IS DISTINCT FROM OLD.change_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.generation <> OLD.generation
    OR NEW.revision <> OLD.revision
    OR NEW.kubernetes_namespace <> OLD.kubernetes_namespace
    OR NEW.kubernetes_pod_name <> OLD.kubernetes_pod_name
    OR NEW.parent_connector_token_hash <> OLD.parent_connector_token_hash
    OR NEW.child_connector_token_hash <> OLD.child_connector_token_hash
    OR NEW.create_intended_at <> OLD.create_intended_at
    OR NEW.created_by <> OLD.created_by
    OR (OLD.declared_apps <> '[]'::jsonb AND NEW.declared_apps IS DISTINCT FROM OLD.declared_apps)
  THEN
    RAISE EXCEPTION 'Runtime Attempt identity and create intent are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.protect_runtime_environment_intent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE project uuid; expected_environment text; current_version bigint; current_key text; publication boolean;
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Runtime environment intent is immutable' USING ERRCODE='23514'; END IF;
  SELECT project_id,isolated_kind='publication',CASE WHEN isolated_kind='staging' THEN 'main-preview' ELSE 'development' END
    INTO project,publication,expected_environment FROM factory.runtime_attempt
    WHERE id=NEW.runtime_attempt_id AND state='create-intended' AND stop_intended_at IS NULL;
  IF publication THEN
    IF NEW.environment<>'development' OR NEW.version<>0 OR NEW.secret_key IS NOT NULL THEN
      RAISE EXCEPTION 'Publication cannot inherit Project environments' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT COALESCE((SELECT environment FROM factory.project_image_preparation WHERE runtime_attempt_id=NEW.runtime_attempt_id),expected_environment) INTO expected_environment;
  IF project IS NULL OR expected_environment<>NEW.environment THEN
    RAISE EXCEPTION 'Runtime environment requires matching active create intent' USING ERRCODE='23514';
  END IF;
  SELECT version,secret_key INTO current_version,current_key FROM factory.project_environment
    WHERE project_id=project AND environment=expected_environment;
  IF NEW.version<>COALESCE(current_version,0) OR NEW.secret_key IS DISTINCT FROM current_key THEN
    RAISE EXCEPTION 'Runtime environment must reference current protected values' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;

CREATE FUNCTION factory.protect_workspace_source_intent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.access_epoch < OLD.access_epoch THEN
    RAISE EXCEPTION 'Workspace source identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.access_epoch = OLD.access_epoch AND (
    NEW.files_image IS DISTINCT FROM OLD.files_image OR
    NEW.capability_hash IS DISTINCT FROM OLD.capability_hash OR
    (OLD.namespace_uid IS NOT NULL AND NEW.namespace_uid IS DISTINCT FROM OLD.namespace_uid) OR
    (OLD.claim_uid IS NOT NULL AND NEW.claim_uid IS DISTINCT FROM OLD.claim_uid) OR
    (OLD.pod_uid IS NOT NULL AND NEW.pod_uid IS DISTINCT FROM OLD.pod_uid) OR
    (OLD.storage_node IS NOT NULL AND NEW.storage_node IS DISTINCT FROM OLD.storage_node)
  ) THEN RAISE EXCEPTION 'Source intent outcome is immutable' USING ERRCODE = '23514'; END IF;
  IF NEW.access_epoch <> OLD.access_epoch AND (
    NEW.access_epoch <> OLD.access_epoch + 1 OR OLD.state <> 'stopped' OR NEW.state <> 'create-intended' OR
    NEW.namespace_uid IS DISTINCT FROM OLD.namespace_uid OR NEW.claim_uid IS DISTINCT FROM OLD.claim_uid OR
    NEW.storage_node IS DISTINCT FROM OLD.storage_node OR NEW.pod_uid IS NOT NULL
  ) THEN RAISE EXCEPTION 'Stop source access before issuing a new epoch' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
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
  SELECT enabled INTO paused FROM factory.installation_maintenance
    WHERE singleton FOR SHARE;
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
      JOIN factory.merge_operation merge ON merge.change_id = change.id
        AND merge.state = 'succeeded' AND merge.observed_default_sha = merge.commit_sha
      JOIN factory.delivery_approval approval ON approval.id = merge.delivery_approval_id
        AND approval.change_id = change.id AND approval.commit_sha = merge.commit_sha
      JOIN factory.verification verification ON verification.id = approval.verification_id
        AND verification.change_id = change.id AND verification.commit_sha = merge.commit_sha
        AND verification.state = 'succeeded'
      JOIN factory.promotion_operation promotion ON promotion.change_id = change.id
        AND promotion.project_id = edge.project_id AND promotion.commit_sha = merge.commit_sha
        AND promotion.state = 'succeeded'
      WHERE change.ticket_id = prerequisite.id AND change.project_id = edge.project_id
        AND change.state = 'delivered'
    ) AS delivered
  FROM factory.ticket_dependency edge
  JOIN factory.ticket prerequisite ON prerequisite.id = edge.prerequisite_id AND prerequisite.project_id = edge.project_id
  WHERE edge.project_id = project AND edge.ticket_id = dependent
  ORDER BY prerequisite.title, prerequisite.id
$$;

CREATE FUNCTION factory.validate_execution_slot_assignment() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.assigned_attempt_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM factory.runtime_attempt attempt
    JOIN factory.runtime_artifact_intent artifact ON artifact.runtime_attempt_id=attempt.id
    WHERE attempt.id=NEW.assigned_attempt_id AND attempt.isolated_kind::text=NEW.role
      AND attempt.workspace_id IS NULL AND attempt.kubernetes_namespace=NEW.kubernetes_namespace
      AND attempt.kubernetes_pod_name='slot' AND artifact.runtime_host_image=NEW.runtime_host_image
  ) THEN
    RAISE EXCEPTION 'Execution slot assignment requires matching immutable runtime intent' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION factory.validate_ticket_conversation_project() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.ticket_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM factory.ticket
    WHERE id = NEW.ticket_id AND project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'Ticket Conversation project mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE auth.account (
    id uuid NOT NULL,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    user_id uuid NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamp with time zone,
    refresh_token_expires_at timestamp with time zone,
    scope text,
    password text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE auth.jwks (
    id text NOT NULL,
    "publicKey" text NOT NULL,
    "privateKey" text NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "expiresAt" timestamp with time zone,
    alg text,
    crv text
);

CREATE TABLE auth."oauthAccessToken" (
    id text NOT NULL,
    token text,
    "clientId" text NOT NULL,
    "sessionId" uuid,
    "userId" uuid,
    "referenceId" text,
    "authorizationCodeId" text,
    resources text[],
    "requestedUserInfoClaims" text[],
    "refreshId" text,
    "expiresAt" timestamp with time zone,
    "createdAt" timestamp with time zone,
    revoked timestamp with time zone,
    confirmation jsonb,
    scopes text[] NOT NULL
);

CREATE TABLE auth."oauthClient" (
    id text NOT NULL,
    "clientId" text NOT NULL,
    "clientSecret" text,
    "clientDiscoveryId" text,
    disabled boolean DEFAULT false,
    "skipConsent" boolean,
    "enableEndSession" boolean,
    "subjectType" text,
    scopes text[],
    "clientCredentialsScopes" text[] DEFAULT '{}'::text[],
    "userId" uuid,
    "createdAt" timestamp with time zone,
    "updatedAt" timestamp with time zone,
    name text,
    uri text,
    icon text,
    contacts text[],
    tos text,
    policy text,
    "softwareId" text,
    "softwareVersion" text,
    "softwareStatement" text,
    "redirectUris" text[] NOT NULL,
    "postLogoutRedirectUris" text[],
    "backchannelLogoutUri" text,
    "backchannelLogoutSessionRequired" boolean,
    "tokenEndpointAuthMethod" text,
    "applicationType" text,
    jwks text,
    "jwksUri" text,
    "grantTypes" text[],
    "responseTypes" text[],
    "requirePKCE" boolean,
    "dpopBoundAccessTokens" boolean DEFAULT false,
    "referenceId" text,
    metadata jsonb
);

CREATE TABLE auth."oauthClientAssertion" (
    id text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL
);

CREATE TABLE auth."oauthClientResource" (
    id text NOT NULL,
    "clientId" text NOT NULL,
    "resourceId" text NOT NULL,
    metadata jsonb,
    "createdAt" timestamp with time zone
);

CREATE TABLE auth."oauthConsent" (
    id text NOT NULL,
    "clientId" text NOT NULL,
    "userId" uuid,
    "referenceId" text,
    resources text[],
    "requestedUserInfoClaims" text[],
    scopes text[] NOT NULL,
    "createdAt" timestamp with time zone,
    "updatedAt" timestamp with time zone
);

CREATE TABLE auth."oauthRefreshToken" (
    id text NOT NULL,
    token text NOT NULL,
    "clientId" text NOT NULL,
    "sessionId" uuid,
    "userId" uuid NOT NULL,
    "referenceId" text,
    "authorizationCodeId" text,
    resources text[],
    "requestedUserInfoClaims" text[],
    "expiresAt" timestamp with time zone,
    "createdAt" timestamp with time zone,
    revoked timestamp with time zone,
    "rotatedAt" timestamp with time zone,
    "rotationReplayResponse" text,
    "rotationReplayExpiresAt" timestamp with time zone,
    "authTime" timestamp with time zone,
    confirmation jsonb,
    scopes text[] NOT NULL
);

CREATE TABLE auth."oauthResource" (
    id text NOT NULL,
    identifier text NOT NULL,
    name text NOT NULL,
    "accessTokenTtl" integer,
    "refreshTokenTtl" integer,
    "signingAlgorithm" text,
    "signingKeyId" text,
    "allowedScopes" text[],
    "customClaims" jsonb,
    "dpopBoundAccessTokensRequired" boolean DEFAULT false,
    disabled boolean DEFAULT false,
    "createdAt" timestamp with time zone,
    "updatedAt" timestamp with time zone,
    "policyVersion" integer DEFAULT 1,
    metadata jsonb
);

CREATE TABLE auth."scimConnectionBinding" (
    id text NOT NULL,
    "connectionId" text NOT NULL,
    "connectionKey" text NOT NULL,
    "provisioningDomainId" text NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "decommissionedAt" timestamp with time zone,
    "decommissionStatus" text DEFAULT 'active'::text NOT NULL,
    "decommissionCursorUserId" text,
    "decommissionReconciledUserCount" integer DEFAULT 0 NOT NULL,
    "decommissionBatchCount" integer DEFAULT 0 NOT NULL,
    "decommissionRevision" integer DEFAULT 0 NOT NULL,
    "decommissionCompletedAt" timestamp with time zone,
    "decommissionLeaseId" text,
    "decommissionLeaseExpiresAt" timestamp with time zone
);

CREATE TABLE auth."scimGroup" (
    id text NOT NULL,
    "connectionId" text NOT NULL,
    "provisioningDomainId" text NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    "displayName" text NOT NULL,
    "displayNameKey" text NOT NULL,
    "externalId" text,
    "externalIdKey" text,
    "orderKey" text NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);

CREATE TABLE auth."scimGroupMember" (
    id text NOT NULL,
    "connectionId" text NOT NULL,
    "groupId" text NOT NULL,
    "scimUserId" text NOT NULL,
    "membershipKey" text NOT NULL,
    "createdAt" timestamp with time zone NOT NULL
);

CREATE TABLE auth."scimIdentityTombstone" (
    id text NOT NULL,
    "connectionId" text NOT NULL,
    "provisioningDomainId" text NOT NULL,
    "externalId" text NOT NULL,
    "externalIdKey" text NOT NULL,
    "userId" uuid NOT NULL,
    profile text NOT NULL,
    "deletedAt" timestamp with time zone NOT NULL
);

CREATE TABLE auth."scimProjectionGrant" (
    id text NOT NULL,
    "connectionId" text NOT NULL,
    "provisioningDomainId" text NOT NULL,
    "scimUserId" text NOT NULL,
    "userId" uuid NOT NULL,
    "sourceKind" text NOT NULL,
    "sourceId" text NOT NULL,
    "sourceValue" text,
    role text NOT NULL,
    "grantKey" text NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);

CREATE TABLE auth."scimSubject" (
    id text NOT NULL,
    "userId" uuid NOT NULL,
    "profileSourceId" text,
    revision integer NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);

CREATE TABLE auth."scimUser" (
    id text NOT NULL,
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
    active boolean NOT NULL,
    "orderKey" text NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);

CREATE TABLE auth.session (
    id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    ip_address text,
    user_agent text,
    user_id uuid NOT NULL,
    authenticated_at timestamp with time zone DEFAULT now() NOT NULL,
    login_method text DEFAULT 'password'::text NOT NULL,
    CONSTRAINT session_login_method_check CHECK ((login_method = ANY (ARRAY['password'::text, 'sso'::text, 'emergency'::text, 'identity-test'::text])))
);

CREATE TABLE auth."ssoProvider" (
    id text NOT NULL,
    issuer text NOT NULL,
    "oidcConfig" text,
    "samlConfig" text,
    "userId" uuid,
    "providerId" text NOT NULL,
    "organizationId" text,
    domain text NOT NULL
);

CREATE TABLE auth."user" (
    id uuid NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    image text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE auth.verification (
    id uuid NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE factory.access_revocation (
    user_id uuid NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    processed_version bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT access_revocation_check CHECK (((processed_version >= 0) AND (processed_version <= version)))
);

CREATE TABLE factory.account_access (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    disabled_at timestamp with time zone,
    directory_disabled_at timestamp with time zone,
    disabled_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE factory.administrator (
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE factory.agent_turn (
    id uuid NOT NULL,
    command_id uuid NOT NULL,
    project_id uuid NOT NULL,
    ticket_id uuid,
    conversation_id uuid,
    change_id uuid,
    created_by uuid NOT NULL,
    input jsonb NOT NULL,
    input_digest text NOT NULL,
    authority jsonb NOT NULL,
    state factory.agent_turn_state DEFAULT 'pending'::factory.agent_turn_state NOT NULL,
    owner_token uuid,
    owner_expires_at timestamp with time zone,
    outcome_summary text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_turn_authority_check CHECK (((jsonb_typeof(authority) = 'object'::text) AND (authority ? 'mode'::text) AND (octet_length((authority)::text) <= 2000))),
    CONSTRAINT agent_turn_check CHECK (((owner_token IS NULL) = (owner_expires_at IS NULL))),
    CONSTRAINT agent_turn_check1 CHECK (((((input ->> 'kind'::text) = ANY (ARRAY['project-message'::text, 'project-answer'::text])) AND (conversation_id IS NOT NULL) AND (change_id IS NULL) AND ((authority ->> 'mode'::text) = ANY (ARRAY['investigate'::text, 'plan'::text]))) OR (((input ->> 'kind'::text) = ANY (ARRAY['change-start'::text, 'change-prompt'::text, 'change-repair'::text, 'change-review'::text])) AND (change_id IS NOT NULL) AND (ticket_id IS NOT NULL) AND ((authority ->> 'mode'::text) = 'build'::text)))),
    CONSTRAINT agent_turn_check2 CHECK ((((input ->> 'kind'::text) <> 'project-answer'::text) OR ((authority ->> 'mode'::text) = 'plan'::text))),
    CONSTRAINT agent_turn_check3 CHECK (((state <> ALL (ARRAY['dispatching'::factory.agent_turn_state, 'running'::factory.agent_turn_state])) OR (owner_token IS NOT NULL))),
    CONSTRAINT agent_turn_check4 CHECK (((state <> ALL (ARRAY['completed'::factory.agent_turn_state, 'failed'::factory.agent_turn_state, 'stopped'::factory.agent_turn_state, 'uncertain'::factory.agent_turn_state])) OR (owner_token IS NULL))),
    CONSTRAINT agent_turn_input_check CHECK (((jsonb_typeof(input) = 'object'::text) AND (input ? 'kind'::text) AND (octet_length((input)::text) <= 100000))),
    CONSTRAINT agent_turn_input_digest_check CHECK ((input_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT agent_turn_outcome_summary_check CHECK ((length(outcome_summary) <= 2000)),
    CONSTRAINT agent_turn_review_authority CHECK ((((input ->> 'kind'::text) = 'change-review'::text) = (authority ? 'review'::text)))
);

CREATE TABLE factory.agent_turn_mcp (
    turn_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    credential_epoch uuid NOT NULL,
    revision_id uuid NOT NULL,
    policy_version bigint NOT NULL,
    tools jsonb NOT NULL,
    required boolean NOT NULL
);

CREATE TABLE factory.agent_turn_skill (
    turn_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    loaded_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE factory.attachment (
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    draft_id uuid,
    name text NOT NULL,
    media_type text NOT NULL,
    sha256 text NOT NULL,
    byte_length bigint NOT NULL,
    reserved_bytes bigint NOT NULL,
    state text NOT NULL,
    text_content text DEFAULT ''::text NOT NULL,
    objects jsonb DEFAULT '[]'::jsonb NOT NULL,
    failure text,
    upload_token uuid,
    upload_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    deleted_at timestamp with time zone,
    CONSTRAINT attachment_byte_length_check CHECK ((byte_length > 0)),
    CONSTRAINT attachment_check CHECK ((reserved_bytes >= byte_length)),
    CONSTRAINT attachment_name_check CHECK (((length(name) >= 1) AND (length(name) <= 240))),
    CONSTRAINT attachment_objects_check CHECK ((jsonb_typeof(objects) = 'array'::text)),
    CONSTRAINT attachment_sha256_check CHECK ((sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT attachment_state_check CHECK ((state = ANY (ARRAY['uploading'::text, 'ready'::text, 'failed'::text, 'deleting'::text, 'deleted'::text])))
);

CREATE TABLE factory.attachment_draft (
    id uuid NOT NULL,
    owner_id uuid NOT NULL,
    project_id uuid NOT NULL,
    sequence bigint NOT NULL,
    attachment_ids uuid[] NOT NULL,
    CONSTRAINT attachment_draft_sequence_check CHECK ((sequence >= 0))
);

CREATE TABLE factory.attachment_reference (
    attachment_id uuid NOT NULL,
    kind text NOT NULL,
    reference_id uuid NOT NULL,
    shared boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT attachment_reference_kind_check CHECK ((kind = ANY (ARRAY['ticket'::text, 'requirement'::text, 'knowledge'::text, 'conversation'::text, 'feedback'::text, 'turn'::text])))
);

CREATE TABLE factory.attachment_storage (
    singleton boolean DEFAULT true NOT NULL,
    id uuid NOT NULL,
    CONSTRAINT attachment_storage_singleton_check CHECK (singleton)
);

CREATE TABLE factory.attachment_turn_context (
    turn_id uuid NOT NULL,
    source text DEFAULT 'admission'::text NOT NULL,
    content text NOT NULL
);

CREATE TABLE factory.branch_create_operation (
    id uuid NOT NULL,
    change_id uuid NOT NULL,
    repository_owner text NOT NULL,
    repository_name text NOT NULL,
    branch_name text NOT NULL,
    start_sha text NOT NULL,
    idempotency_key text NOT NULL,
    state factory.branch_operation_state DEFAULT 'pending'::factory.branch_operation_state NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    lease_generation bigint DEFAULT 0 NOT NULL,
    reconcile_after timestamp with time zone DEFAULT now() NOT NULL,
    observed_head_sha text,
    last_error text,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT branch_create_operation_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT branch_create_operation_check CHECK (((lease_owner IS NULL) = (lease_expires_at IS NULL))),
    CONSTRAINT branch_create_operation_check1 CHECK (((state = ANY (ARRAY['succeeded'::factory.branch_operation_state, 'failed'::factory.branch_operation_state, 'cancelled'::factory.branch_operation_state])) = (completed_at IS NOT NULL))),
    CONSTRAINT branch_create_operation_check2 CHECK (((state <> 'succeeded'::factory.branch_operation_state) OR (observed_head_sha = start_sha))),
    CONSTRAINT branch_create_operation_lease_generation_check CHECK ((lease_generation >= 0)),
    CONSTRAINT branch_create_operation_observed_head_sha_check CHECK (((observed_head_sha IS NULL) OR (observed_head_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text))),
    CONSTRAINT branch_create_operation_repository_name_check CHECK ((length(btrim(repository_name)) > 0)),
    CONSTRAINT branch_create_operation_repository_owner_check CHECK ((length(btrim(repository_owner)) > 0)),
    CONSTRAINT branch_create_operation_start_sha_check CHECK ((start_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text))
);

CREATE TABLE factory.build_browser_session (
    id uuid NOT NULL,
    turn_id uuid NOT NULL,
    change_id uuid NOT NULL,
    runtime_attempt_id uuid NOT NULL,
    generation bigint NOT NULL,
    agent_session_id text NOT NULL,
    owner_id text NOT NULL,
    state text DEFAULT 'intended'::text NOT NULL,
    create_intended_at timestamp with time zone DEFAULT now() NOT NULL,
    create_confirmed_at timestamp with time zone,
    cleanup_intended_at timestamp with time zone,
    cleanup_confirmed_at timestamp with time zone,
    outcome_summary text,
    inspection_context jsonb,
    ordinal integer DEFAULT 1 NOT NULL,
    reopen_allowed boolean DEFAULT false NOT NULL,
    CONSTRAINT build_browser_session_agent_session_id_check CHECK (((agent_session_id ~~ 'ses%'::text) AND (length(agent_session_id) <= 200))),
    CONSTRAINT build_browser_session_check CHECK (((inspection_context IS NULL) OR (((jsonb_typeof(inspection_context) = 'object'::text) AND (octet_length((inspection_context)::text) <= 2048) AND ((inspection_context ->> 'sessionId'::text) = (id)::text) AND ((inspection_context ->> 'turnId'::text) = (turn_id)::text) AND ((inspection_context ->> 'changeId'::text) = (change_id)::text) AND ((inspection_context ->> 'runtimeAttemptId'::text) = (runtime_attempt_id)::text) AND (((inspection_context ->> 'generation'::text))::bigint = generation) AND ((inspection_context ->> 'headCommit'::text) ~ '^[a-f0-9]{40}$'::text) AND ((inspection_context ->> 'app'::text) ~ '^[a-z][a-z0-9-]{0,31}$'::text) AND (jsonb_typeof((inspection_context -> 'workingTreeModified'::text)) = 'boolean'::text)) IS TRUE))),
    CONSTRAINT build_browser_session_check1 CHECK (((state <> 'active'::text) OR (create_confirmed_at IS NOT NULL))),
    CONSTRAINT build_browser_session_check2 CHECK (((state <> 'active'::text) OR (inspection_context IS NOT NULL))),
    CONSTRAINT build_browser_session_check3 CHECK (((state = ANY (ARRAY['closing'::text, 'closed'::text])) = (cleanup_intended_at IS NOT NULL))),
    CONSTRAINT build_browser_session_check4 CHECK (((state = 'closed'::text) = (cleanup_confirmed_at IS NOT NULL))),
    CONSTRAINT build_browser_session_generation_check CHECK ((generation > 0)),
    CONSTRAINT build_browser_session_ordinal_check CHECK ((ordinal > 0)),
    CONSTRAINT build_browser_session_outcome_summary_check CHECK ((octet_length(outcome_summary) <= 512)),
    CONSTRAINT build_browser_session_owner_id_check CHECK ((owner_id ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT build_browser_session_state_check CHECK ((state = ANY (ARRAY['intended'::text, 'active'::text, 'closing'::text, 'closed'::text])))
);

CREATE TABLE factory.candidate_review (
    id uuid NOT NULL,
    verification_id uuid NOT NULL,
    ordinal integer DEFAULT 1 NOT NULL,
    supersedes_id uuid,
    change_id uuid NOT NULL,
    commit_sha text NOT NULL,
    base_sha text NOT NULL,
    created_by uuid NOT NULL,
    turn_id uuid,
    state text DEFAULT 'pending'::text NOT NULL,
    ui_required boolean DEFAULT false NOT NULL,
    result jsonb,
    evidence jsonb DEFAULT '[]'::jsonb NOT NULL,
    repair_command_id uuid DEFAULT gen_random_uuid() NOT NULL,
    repair_prompted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    coverage_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT candidate_review_base_sha_check CHECK ((base_sha ~ '^[a-f0-9]{40}$'::text)),
    CONSTRAINT candidate_review_check CHECK (((state <> ALL (ARRAY['passed'::text, 'changes-requested'::text])) OR (result IS NOT NULL))),
    CONSTRAINT candidate_review_commit_sha_check CHECK ((commit_sha ~ '^[a-f0-9]{40}$'::text)),
    CONSTRAINT candidate_review_evidence_check CHECK (((jsonb_typeof(evidence) = 'array'::text) AND (jsonb_array_length(evidence) <= 256))),
    CONSTRAINT candidate_review_ordinal_check CHECK ((ordinal > 0)),
    CONSTRAINT candidate_review_result_check CHECK (((result IS NULL) OR ((jsonb_typeof(result) = 'object'::text) AND (octet_length((result)::text) <= 32768)))),
    CONSTRAINT candidate_review_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'running'::text, 'passed'::text, 'changes-requested'::text, 'incomplete'::text])))
);

CREATE TABLE factory.change (
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    ticket_id uuid NOT NULL,
    requirement_approval_id uuid NOT NULL,
    branch_name text NOT NULL,
    base_sha text NOT NULL,
    state factory.change_state NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    cancel_requested_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    failure text,
    runtime_attempt_id uuid,
    CONSTRAINT change_base_sha_check CHECK ((base_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text)),
    CONSTRAINT change_branch_name_check CHECK ((branch_name ~ '^factory/change-[0-9a-f]{12}$'::text)),
    CONSTRAINT change_check CHECK (((state = 'cancelled'::factory.change_state) = (cancelled_at IS NOT NULL))),
    CONSTRAINT change_version_check CHECK ((version > 0))
);

CREATE TABLE factory.change_agent_session (
    change_id uuid NOT NULL,
    runtime_attempt_id uuid NOT NULL,
    opencode_session_id text,
    state factory.change_agent_state NOT NULL,
    active_inbox_id text,
    last_error text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    active_turn_id uuid,
    stop_pending boolean DEFAULT false NOT NULL,
    stop_dispatched boolean DEFAULT false NOT NULL,
    stop_id uuid,
    stop_turn_id uuid,
    native_session_confirmed_at timestamp with time zone,
    implementation_session_id text,
    implementation_session_confirmed_at timestamp with time zone,
    CONSTRAINT change_agent_implementation_confirmation CHECK (((implementation_session_confirmed_at IS NULL) OR (implementation_session_id IS NOT NULL))),
    CONSTRAINT change_agent_native_session_confirmation CHECK (((native_session_confirmed_at IS NULL) OR (opencode_session_id IS NOT NULL))),
    CONSTRAINT change_agent_session_active_inbox_id_check CHECK ((length(COALESCE(active_inbox_id, ''::text)) <= 200)),
    CONSTRAINT change_agent_session_check CHECK (((state <> 'starting'::factory.change_agent_state) OR (opencode_session_id IS NULL) OR (length(opencode_session_id) > 0))),
    CONSTRAINT change_agent_session_opencode_session_id_check CHECK ((length(COALESCE(opencode_session_id, ''::text)) <= 200)),
    CONSTRAINT change_agent_stop_dispatch_state CHECK (((NOT stop_dispatched) OR stop_pending)),
    CONSTRAINT change_agent_stop_pending_state CHECK (((NOT stop_pending) OR (state = 'stopped'::factory.change_agent_state)))
);

CREATE TABLE factory.change_agent_turn_intent (
    turn_id uuid NOT NULL,
    change_id uuid NOT NULL,
    session_id text NOT NULL,
    prompt_id text NOT NULL,
    prompt_text text NOT NULL,
    bootstrap boolean NOT NULL,
    session_title text NOT NULL,
    runtime_attempt_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    skill_loading text DEFAULT 'eager'::text NOT NULL,
    skill_manifest jsonb,
    skill_attachments jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT change_agent_turn_intent_prompt_id_check CHECK (((prompt_id ~~ 'msg_%'::text) AND (length(prompt_id) <= 200))),
    CONSTRAINT change_agent_turn_intent_prompt_text_check CHECK (((length(btrim(prompt_text)) > 0) AND (octet_length(prompt_text) <= 4000000))),
    CONSTRAINT change_agent_turn_intent_session_id_check CHECK (((session_id ~~ 'ses%'::text) AND (length(session_id) <= 200))),
    CONSTRAINT change_agent_turn_intent_session_title_check CHECK (((length(session_title) >= 1) AND (length(session_title) <= 200))),
    CONSTRAINT change_agent_turn_intent_skill_loading_check CHECK ((skill_loading = ANY (ARRAY['eager'::text, 'native'::text])))
);

CREATE TABLE factory.change_commit_operation (
    id uuid NOT NULL,
    change_id uuid NOT NULL,
    runtime_attempt_id uuid,
    sequence integer NOT NULL,
    branch_name text NOT NULL,
    expected_parent_sha text NOT NULL,
    commit_sha text,
    observed_remote_sha text,
    commit_message text NOT NULL,
    idempotency_key text NOT NULL,
    state factory.change_commit_state NOT NULL,
    last_error text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    source factory.change_commit_source DEFAULT 'agent'::factory.change_commit_source NOT NULL,
    repository_path text,
    repository_blob_sha text,
    repository_content text,
    content_digest text,
    CONSTRAINT change_commit_operation_check CHECK (((state = ANY (ARRAY['succeeded'::factory.change_commit_state, 'failed'::factory.change_commit_state])) = (completed_at IS NOT NULL))),
    CONSTRAINT change_commit_operation_check2 CHECK (((state <> 'succeeded'::factory.change_commit_state) OR (observed_remote_sha = commit_sha))),
    CONSTRAINT change_commit_operation_commit_message_check CHECK (((length(btrim(commit_message)) >= 1) AND (length(btrim(commit_message)) <= 240))),
    CONSTRAINT change_commit_operation_commit_presence_check CHECK (((state <> ALL (ARRAY['committed'::factory.change_commit_state, 'push-intended'::factory.change_commit_state, 'succeeded'::factory.change_commit_state])) OR (commit_sha IS NOT NULL) OR ((source = 'repository-document'::factory.change_commit_source) AND (state = 'push-intended'::factory.change_commit_state)))),
    CONSTRAINT change_commit_operation_commit_sha_check CHECK (((commit_sha IS NULL) OR (commit_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text))),
    CONSTRAINT change_commit_operation_expected_parent_sha_check CHECK ((expected_parent_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text)),
    CONSTRAINT change_commit_operation_observed_remote_sha_check CHECK (((observed_remote_sha IS NULL) OR (observed_remote_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text))),
    CONSTRAINT change_commit_operation_sequence_check CHECK ((sequence > 0)),
    CONSTRAINT change_commit_operation_source_check CHECK ((((source = 'agent'::factory.change_commit_source) AND (runtime_attempt_id IS NOT NULL) AND (repository_path IS NULL) AND (repository_blob_sha IS NULL) AND (repository_content IS NULL) AND (content_digest IS NULL)) OR ((source = 'repository-document'::factory.change_commit_source) AND (runtime_attempt_id IS NULL) AND (repository_path IS NOT NULL) AND (repository_blob_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text) AND (repository_content IS NOT NULL) AND (content_digest ~ '^[0-9a-f]{64}$'::text))))
);

CREATE TABLE factory.change_editing_decision (
    command_id uuid NOT NULL,
    change_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    target_id uuid,
    request_id uuid,
    writer_epoch bigint NOT NULL,
    kind text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT change_editing_decision_kind_check CHECK ((kind = ANY (ARRAY['takeover'::text, 'idle-takeover'::text, 'approve'::text, 'release'::text])))
);

CREATE TABLE factory.change_editing_request (
    id uuid NOT NULL,
    change_id uuid NOT NULL,
    requester_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    writer_epoch bigint NOT NULL,
    state text DEFAULT 'requested'::text NOT NULL,
    decided_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    CONSTRAINT change_editing_request_state_check CHECK ((state = ANY (ARRAY['requested'::text, 'accepted'::text, 'superseded'::text])))
);

CREATE TABLE factory.change_writer (
    change_id uuid NOT NULL,
    state text DEFAULT 'unassigned'::text NOT NULL,
    epoch bigint DEFAULT 1 NOT NULL,
    user_id uuid,
    turn_id uuid,
    fence_attempt_id uuid,
    fence_required boolean DEFAULT false NOT NULL,
    requested_by uuid,
    request_id uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    handoff_kind text DEFAULT 'takeover'::text NOT NULL,
    CONSTRAINT change_writer_check CHECK (((state = 'human'::text) = (user_id IS NOT NULL))),
    CONSTRAINT change_writer_check1 CHECK (((state = ANY (ARRAY['agent-preparing'::text, 'agent'::text])) = (turn_id IS NOT NULL))),
    CONSTRAINT change_writer_check2 CHECK (((state = 'handoff'::text) = ((requested_by IS NOT NULL) AND (request_id IS NOT NULL)))),
    CONSTRAINT change_writer_epoch_check CHECK ((epoch > 0)),
    CONSTRAINT change_writer_handoff_kind_check CHECK ((handoff_kind = ANY (ARRAY['takeover'::text, 'release'::text]))),
    CONSTRAINT change_writer_state_check CHECK ((state = ANY (ARRAY['unassigned'::text, 'agent-preparing'::text, 'agent'::text, 'handoff'::text, 'human'::text])))
);

CREATE TABLE factory.coding_pause (
    turn_id uuid NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resumed_by_turn_id uuid,
    CONSTRAINT coding_pause_reason_check CHECK ((reason = ANY (ARRAY['accounting-incomplete'::text, 'coding-budget-used'::text, 'finish-reserve-used'::text])))
);

CREATE TABLE factory.conversation_context (
    id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    command_id uuid NOT NULL,
    kind text NOT NULL,
    mode factory.conversation_mode DEFAULT 'investigate'::factory.conversation_mode NOT NULL,
    ordinal integer NOT NULL,
    title text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    change_id uuid,
    native_session_id text,
    previous_context_id uuid,
    original boolean DEFAULT false NOT NULL,
    archived_session jsonb,
    transcript jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT conversation_context_check CHECK (((kind = 'coding'::text) = (change_id IS NOT NULL))),
    CONSTRAINT conversation_context_check1 CHECK (((kind = 'coding'::text) = (mode = 'build'::factory.conversation_mode))),
    CONSTRAINT conversation_context_check2 CHECK (((kind = 'coding'::text) OR ((native_session_id IS NULL) AND (archived_session IS NULL) AND (NOT original)))),
    CONSTRAINT conversation_context_kind_check CHECK ((kind = ANY (ARRAY['research'::text, 'coding'::text]))),
    CONSTRAINT conversation_context_ordinal_check CHECK ((ordinal > 0)),
    CONSTRAINT conversation_context_title_check CHECK (((length(title) >= 1) AND (length(title) <= 200)))
);

CREATE TABLE factory.conversation_entry (
    id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    ordinal bigint NOT NULL,
    kind factory.conversation_entry_kind NOT NULL,
    actor factory.conversation_actor NOT NULL,
    mode factory.conversation_mode NOT NULL,
    body text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    citations jsonb DEFAULT '[]'::jsonb NOT NULL,
    in_reply_to_entry_id uuid,
    requirement_revision_id uuid,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT conversation_entry_body_check CHECK ((length(body) <= 12000)),
    CONSTRAINT conversation_entry_ordinal_check CHECK ((ordinal > 0))
);

CREATE TABLE factory.delivery_approval (
    id uuid NOT NULL,
    change_id uuid NOT NULL,
    verification_id uuid NOT NULL,
    commit_sha text NOT NULL,
    approved_by uuid NOT NULL,
    approved_at timestamp with time zone DEFAULT now() NOT NULL,
    candidate_review_id uuid,
    monitoring_incident_id uuid,
    monitoring_policy_id uuid,
    CONSTRAINT delivery_approval_commit_sha_check CHECK ((commit_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text)),
    CONSTRAINT delivery_monitoring_basis CHECK (((monitoring_incident_id IS NULL) = (monitoring_policy_id IS NULL)))
);

CREATE TABLE factory.developer_ide (
    user_id uuid NOT NULL,
    service_epoch bigint DEFAULT 1 NOT NULL,
    state text NOT NULL,
    image text NOT NULL,
    namespace_uid text,
    pod_uid text,
    failure text,
    create_intended_at timestamp with time zone DEFAULT now() NOT NULL,
    create_observed_at timestamp with time zone,
    stop_intended_at timestamp with time zone,
    stopped_at timestamp with time zone,
    last_active_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    resource_id uuid DEFAULT gen_random_uuid() NOT NULL,
    CONSTRAINT developer_ide_image_check CHECK ((image ~ '@sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT developer_ide_service_epoch_check CHECK ((service_epoch > 0)),
    CONSTRAINT developer_ide_state_check CHECK ((state = ANY (ARRAY['create-intended'::text, 'preparing'::text, 'ready'::text, 'failed'::text, 'stop-intended'::text, 'stopped'::text])))
);

CREATE TABLE factory.development_workspace (
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    kind factory.development_workspace_kind NOT NULL,
    owner_user_id uuid,
    ticket_id uuid,
    change_id uuid,
    source_branch text NOT NULL,
    source_revision text NOT NULL,
    kubernetes_namespace text NOT NULL,
    volume_name text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT development_workspace_check CHECK ((((kind = 'personal'::factory.development_workspace_kind) AND (owner_user_id IS NOT NULL) AND (ticket_id IS NULL) AND (change_id IS NULL)) OR ((kind = 'ticket'::factory.development_workspace_kind) AND (owner_user_id IS NULL) AND (ticket_id IS NOT NULL) AND (change_id IS NOT NULL)))),
    CONSTRAINT development_workspace_kubernetes_namespace_check CHECK ((kubernetes_namespace ~ '^factory-workspace-[0-9a-f]{12}$'::text)),
    CONSTRAINT development_workspace_source_branch_check CHECK (((length(source_branch) >= 1) AND (length(source_branch) <= 200))),
    CONSTRAINT development_workspace_source_revision_check CHECK ((source_revision ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text)),
    CONSTRAINT development_workspace_volume_name_check CHECK ((volume_name ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'::text))
);

CREATE TABLE factory.environment_write (
    command_id uuid NOT NULL,
    project_id uuid NOT NULL,
    environment text NOT NULL,
    base_version bigint NOT NULL,
    fingerprint text NOT NULL,
    manifest jsonb NOT NULL,
    secret_key text NOT NULL,
    state text DEFAULT 'write-intended'::text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    committed_at timestamp with time zone,
    CONSTRAINT environment_write_base_version_check CHECK ((base_version >= 0)),
    CONSTRAINT environment_write_environment_check CHECK ((environment = ANY (ARRAY['development'::text, 'main-preview'::text]))),
    CONSTRAINT environment_write_fingerprint_check CHECK ((fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT environment_write_state_check CHECK ((state = ANY (ARRAY['write-intended'::text, 'committed'::text, 'discarded'::text])))
);

CREATE TABLE factory.epic (
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    parent_id uuid,
    title text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT epic_check CHECK ((parent_id IS DISTINCT FROM id)),
    CONSTRAINT epic_description_check CHECK ((length(description) <= 10000)),
    CONSTRAINT epic_title_check CHECK (((length(btrim(title)) >= 1) AND (length(btrim(title)) <= 200))),
    CONSTRAINT epic_version_check CHECK ((version > 0))
);

CREATE TABLE factory.epic_confirmation (
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    proposal_entry_id uuid NOT NULL,
    epic_id uuid NOT NULL,
    origin_ticket_id uuid,
    input_digest text NOT NULL,
    decision jsonb NOT NULL,
    members jsonb NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT epic_confirmation_input_digest_check CHECK ((input_digest ~ '^[0-9a-f]{64}$'::text))
);

CREATE TABLE factory.execution_policy (
    scope text NOT NULL,
    version bigint NOT NULL,
    policy jsonb NOT NULL,
    timezone text,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT execution_policy_check CHECK (((scope = 'factory'::text) OR (timezone IS NULL))),
    CONSTRAINT execution_policy_policy_check CHECK ((jsonb_typeof(policy) = 'object'::text)),
    CONSTRAINT execution_policy_scope_check CHECK (((scope = 'factory'::text) OR (scope ~ '^[0-9a-f-]{36}$'::text))),
    CONSTRAINT execution_policy_version_check CHECK ((version >= 1))
);

CREATE TABLE factory.execution_policy_command (
    command_id uuid NOT NULL,
    scope text NOT NULL,
    actor_id uuid NOT NULL,
    input jsonb NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE factory.execution_slot (
    id uuid NOT NULL,
    role text NOT NULL,
    state text NOT NULL,
    runtime_host_image text NOT NULL,
    kubernetes_namespace text NOT NULL,
    namespace_uid text,
    pod_uid text,
    claim_uid text,
    assigned_attempt_id uuid,
    assigned_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    reconcile_after timestamp with time zone DEFAULT now() NOT NULL,
    factorybox_profile jsonb,
    factorybox_identity jsonb,
    factorybox_preparation jsonb,
    factorybox_start_attempted boolean DEFAULT false NOT NULL,
    factorybox_pause_attempted boolean DEFAULT false NOT NULL,
    factorybox_resume_attempted boolean DEFAULT false NOT NULL,
    CONSTRAINT execution_slot_check CHECK (((assigned_attempt_id IS NULL) = (assigned_at IS NULL))),
    CONSTRAINT execution_slot_check1 CHECK (((state <> 'assigned'::text) OR (assigned_attempt_id IS NOT NULL))),
    CONSTRAINT execution_slot_check2 CHECK (((state <> 'ready'::text) OR ((namespace_uid IS NOT NULL) AND (pod_uid IS NOT NULL) AND (claim_uid IS NOT NULL)))),
    CONSTRAINT execution_slot_check3 CHECK ((expires_at > created_at)),
    CONSTRAINT execution_slot_kubernetes_namespace_check CHECK ((kubernetes_namespace ~ '^factory-reserve-[0-9a-f]{12}$'::text)),
    CONSTRAINT execution_slot_role_check CHECK ((role = ANY (ARRAY['staging'::text, 'verification'::text]))),
    CONSTRAINT execution_slot_runtime_host_image_check CHECK ((runtime_host_image ~ '^[a-zA-Z0-9.:/-]+@sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT execution_slot_state_check CHECK ((state = ANY (ARRAY['creating'::text, 'ready'::text, 'assigned'::text, 'retiring'::text, 'deleted'::text])))
);

CREATE TABLE factory.external_identity (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    issuer text NOT NULL,
    subject text NOT NULL,
    user_id uuid NOT NULL,
    directory_subject text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE factory.factorybox_lifecycle_operation (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    runtime_attempt_id uuid NOT NULL,
    action text NOT NULL,
    snapshot_id text,
    intended_at timestamp with time zone DEFAULT now() NOT NULL,
    attempted_at timestamp with time zone,
    completed_at timestamp with time zone,
    observation jsonb,
    CONSTRAINT factorybox_lifecycle_operation_action_check CHECK ((action = ANY (ARRAY['prepare'::text, 'start'::text, 'pause'::text, 'resume'::text, 'delete'::text]))),
    CONSTRAINT factorybox_lifecycle_operation_check CHECK (((action = ANY (ARRAY['pause'::text, 'resume'::text])) = (snapshot_id IS NOT NULL))),
    CONSTRAINT factorybox_lifecycle_operation_snapshot_id_check CHECK ((snapshot_id ~ '^[a-f0-9]{32}$'::text))
);

CREATE TABLE factory.factorybox_runtime (
    runtime_attempt_id uuid NOT NULL,
    request jsonb NOT NULL,
    identity jsonb,
    inputs_released_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE factory.forge_account_intent (
    user_id uuid NOT NULL,
    username text NOT NULL,
    source_id bigint NOT NULL,
    forge_user_id bigint,
    state text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    observed_at timestamp with time zone,
    CONSTRAINT forge_account_intent_state_check CHECK ((state = ANY (ARRAY['create-intended'::text, 'ready'::text, 'disabled'::text])))
);

CREATE TABLE factory.forge_branch_intent (
    project_id uuid NOT NULL,
    branch text NOT NULL,
    writers text[] NOT NULL,
    merger text NOT NULL,
    confirmed boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE factory.forge_connection (
    id boolean DEFAULT true NOT NULL,
    source_name text NOT NULL,
    discovery_url text NOT NULL,
    redirect_uri text NOT NULL,
    source_id bigint,
    state text NOT NULL,
    intended_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    observed_at timestamp with time zone,
    CONSTRAINT forge_connection_id_check CHECK (id),
    CONSTRAINT forge_connection_source_name_check CHECK ((source_name = 'Factory'::text)),
    CONSTRAINT forge_connection_state_check CHECK ((state = ANY (ARRAY['create-intended'::text, 'ready'::text])))
);

CREATE TABLE factory.forge_grant_intent (
    project_id uuid NOT NULL,
    user_id uuid NOT NULL,
    desired boolean NOT NULL,
    confirmed boolean,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE factory.forge_identity_intent (
    client_id text NOT NULL,
    redirect_uri text NOT NULL,
    intended_by uuid NOT NULL,
    state text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    observed_at timestamp with time zone,
    CONSTRAINT forge_identity_intent_state_check CHECK ((state = ANY (ARRAY['create-intended'::text, 'ready'::text])))
);

CREATE TABLE factory.identity_configuration (
    singleton boolean DEFAULT true NOT NULL,
    version bigint NOT NULL,
    setup_id uuid NOT NULL,
    activated_by uuid NOT NULL,
    activated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT identity_configuration_singleton_check CHECK (singleton)
);

CREATE TABLE factory.identity_setup (
    id uuid NOT NULL,
    base_version bigint NOT NULL,
    metadata jsonb NOT NULL,
    fingerprint text NOT NULL,
    secret_key text NOT NULL,
    created_by uuid NOT NULL,
    state text NOT NULL,
    tested_at timestamp with time zone,
    tested_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT identity_setup_base_version_check CHECK ((base_version >= 0)),
    CONSTRAINT identity_setup_state_check CHECK ((state = ANY (ARRAY['write-intended'::text, 'saved'::text, 'active'::text, 'superseded'::text])))
);

CREATE TABLE factory.installation_maintenance (
    singleton boolean DEFAULT true NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    requested_at timestamp with time zone,
    CONSTRAINT installation_maintenance_singleton_check CHECK (singleton)
);

CREATE TABLE factory.knowledge_generation (
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    source_commit_sha text NOT NULL,
    state factory.knowledge_generation_state DEFAULT 'pending'::factory.knowledge_generation_state NOT NULL,
    page_count integer,
    conflict_count integer,
    failure text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    model_id text,
    attempt_id uuid,
    model_connection_id uuid,
    model_connection_version bigint,
    CONSTRAINT knowledge_generation_check CHECK (((state = ANY (ARRAY['succeeded'::factory.knowledge_generation_state, 'failed'::factory.knowledge_generation_state])) = (completed_at IS NOT NULL))),
    CONSTRAINT knowledge_generation_conflict_count_check CHECK (((conflict_count IS NULL) OR (conflict_count >= 0))),
    CONSTRAINT knowledge_generation_failure_check CHECK (((failure IS NULL) OR (length(failure) <= 4000))),
    CONSTRAINT knowledge_generation_model_id_check CHECK (((model_id IS NULL) OR ((length(model_id) >= 1) AND (length(model_id) <= 200)))),
    CONSTRAINT knowledge_generation_page_count_check CHECK (((page_count IS NULL) OR (page_count >= 0))),
    CONSTRAINT knowledge_generation_source_commit_sha_check CHECK ((source_commit_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text)),
    CONSTRAINT knowledge_model_connection_pair CHECK (((model_connection_id IS NULL) = (model_connection_version IS NULL)))
);

CREATE TABLE factory.knowledge_page (
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    state factory.knowledge_page_state DEFAULT 'active'::factory.knowledge_page_state NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    current_revision_id uuid,
    current_body text NOT NULL,
    generated_body text NOT NULL,
    source_commit_sha text NOT NULL,
    citations jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    parent_id uuid,
    sort_order integer DEFAULT 0 NOT NULL,
    icon text DEFAULT 'knowledge'::text NOT NULL,
    metadata_version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT knowledge_page_citations_check CHECK ((jsonb_typeof(citations) = 'array'::text)),
    CONSTRAINT knowledge_page_current_body_check CHECK (((length(current_body) >= 1) AND (length(current_body) <= 120000))),
    CONSTRAINT knowledge_page_generated_body_check CHECK (((length(generated_body) >= 1) AND (length(generated_body) <= 120000))),
    CONSTRAINT knowledge_page_icon_check CHECK ((icon = ANY (ARRAY['knowledge'::text, 'home'::text, 'ticket'::text, 'ide'::text, 'preview'::text, 'settings'::text]))),
    CONSTRAINT knowledge_page_metadata_version_check CHECK ((metadata_version > 0)),
    CONSTRAINT knowledge_page_not_own_parent CHECK ((parent_id IS DISTINCT FROM id)),
    CONSTRAINT knowledge_page_slug_check CHECK ((slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text)),
    CONSTRAINT knowledge_page_sort_order_check CHECK ((sort_order >= 0)),
    CONSTRAINT knowledge_page_source_commit_sha_check CHECK ((source_commit_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text)),
    CONSTRAINT knowledge_page_title_check CHECK (((length(btrim(title)) >= 1) AND (length(btrim(title)) <= 200))),
    CONSTRAINT knowledge_page_version_check CHECK ((version > 0))
);

CREATE TABLE factory.knowledge_page_alias (
    project_id uuid NOT NULL,
    slug text NOT NULL,
    page_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_page_alias_slug_check CHECK ((slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text))
);

CREATE TABLE factory.knowledge_revision (
    id uuid NOT NULL,
    page_id uuid NOT NULL,
    ordinal integer NOT NULL,
    kind factory.knowledge_revision_kind NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    generated_body text NOT NULL,
    source_commit_sha text NOT NULL,
    citations jsonb DEFAULT '[]'::jsonb NOT NULL,
    generation_id uuid,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_revision_body_check CHECK (((length(body) >= 1) AND (length(body) <= 120000))),
    CONSTRAINT knowledge_revision_citations_check CHECK ((jsonb_typeof(citations) = 'array'::text)),
    CONSTRAINT knowledge_revision_generated_body_check CHECK (((length(generated_body) >= 1) AND (length(generated_body) <= 120000))),
    CONSTRAINT knowledge_revision_ordinal_check CHECK ((ordinal > 0)),
    CONSTRAINT knowledge_revision_source_commit_sha_check CHECK ((source_commit_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text)),
    CONSTRAINT knowledge_revision_title_check CHECK (((length(btrim(title)) >= 1) AND (length(btrim(title)) <= 200)))
);

CREATE TABLE factory.mcp_access_decision (
    id uuid NOT NULL,
    connection_id uuid NOT NULL,
    credential_epoch uuid NOT NULL,
    project_id uuid,
    action text NOT NULL,
    decided_by uuid NOT NULL,
    decided_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_access_decision_action_check CHECK ((action = ANY (ARRAY['grant'::text, 'revoke'::text, 'disconnect'::text])))
);

CREATE TABLE factory.mcp_choice (
    library_id uuid NOT NULL,
    scope text NOT NULL,
    context_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    state text NOT NULL,
    revision_id uuid NOT NULL,
    version bigint NOT NULL,
    CONSTRAINT mcp_choice_check CHECK (((scope <> 'personal'::text) OR (state <> 'required'::text))),
    CONSTRAINT mcp_choice_role_check CHECK ((role = ANY (ARRAY['planning'::text, 'build'::text]))),
    CONSTRAINT mcp_choice_scope_check CHECK ((scope = ANY (ARRAY['personal'::text, 'project'::text, 'system'::text]))),
    CONSTRAINT mcp_choice_state_check CHECK ((state = ANY (ARRAY['inherit'::text, 'enable'::text, 'disable'::text, 'required'::text]))),
    CONSTRAINT mcp_choice_version_check CHECK ((version > 0))
);

CREATE TABLE factory.mcp_connect_intent (
    id uuid NOT NULL,
    connection_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    created_by uuid NOT NULL,
    fingerprint text NOT NULL,
    state text NOT NULL,
    authorization_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_connect_intent_state_check CHECK ((state = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text, 'uncertain'::text])))
);

CREATE TABLE factory.mcp_connection (
    id uuid NOT NULL,
    revision_id uuid NOT NULL,
    state text NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    secret_key text,
    credential_epoch uuid NOT NULL,
    tools jsonb DEFAULT '[]'::jsonb NOT NULL,
    allowed_tools jsonb DEFAULT '[]'::jsonb NOT NULL,
    authorized_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_connection_state_check CHECK ((state = ANY (ARRAY['disconnected'::text, 'authorizing'::text, 'review'::text, 'ready'::text, 'reconnect'::text, 'revoked'::text]))),
    CONSTRAINT mcp_connection_tools_check CHECK (((jsonb_typeof(tools) = 'array'::text) AND (octet_length((tools)::text) <= 1000000)))
);

CREATE TABLE factory.mcp_library (
    id uuid NOT NULL,
    scope text NOT NULL,
    owner_id uuid,
    project_id uuid,
    CONSTRAINT mcp_library_check CHECK ((((scope = 'personal'::text) AND (owner_id IS NOT NULL) AND (project_id IS NULL)) OR ((scope = 'project'::text) AND (owner_id IS NULL) AND (project_id IS NOT NULL)) OR ((scope = 'system'::text) AND (owner_id IS NULL) AND (project_id IS NULL)))),
    CONSTRAINT mcp_library_scope_check CHECK ((scope = ANY (ARRAY['personal'::text, 'project'::text, 'system'::text])))
);

CREATE TABLE factory.mcp_oauth_flow (
    id uuid NOT NULL,
    connection_id uuid NOT NULL,
    created_by uuid NOT NULL,
    state_digest text NOT NULL,
    state text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_oauth_flow_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'exchanging'::text, 'completed'::text, 'failed'::text])))
);

CREATE TABLE factory.mcp_observation (
    id uuid NOT NULL,
    turn_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    tool_name text NOT NULL,
    tool_digest text NOT NULL,
    result_digest text NOT NULL,
    is_error boolean NOT NULL,
    observed_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE factory.mcp_policy_approval (
    id uuid NOT NULL,
    connection_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    credential_epoch uuid NOT NULL,
    version bigint NOT NULL,
    tools jsonb NOT NULL,
    reviewed_by uuid NOT NULL,
    reviewed_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE factory.mcp_project_grant (
    connection_id uuid NOT NULL,
    credential_epoch uuid NOT NULL,
    project_id uuid NOT NULL,
    granted_by uuid NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE factory.mcp_revision (
    id uuid NOT NULL,
    library_id uuid NOT NULL,
    revision bigint NOT NULL,
    content jsonb NOT NULL,
    digest text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_revision_content_check CHECK (((jsonb_typeof(content) = 'object'::text) AND (octet_length((content)::text) < 16000))),
    CONSTRAINT mcp_revision_digest_check CHECK ((digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT mcp_revision_revision_check CHECK ((revision > 0))
);

CREATE TABLE factory.mcp_secret_write (
    id uuid NOT NULL,
    connection_id uuid NOT NULL,
    base_key text,
    credential_epoch uuid NOT NULL,
    secret_key text NOT NULL,
    digest text NOT NULL,
    state text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_secret_write_state_check CHECK ((state = ANY (ARRAY['intended'::text, 'committed'::text, 'superseded'::text])))
);

CREATE TABLE factory.mcp_share_proposal (
    id uuid NOT NULL,
    revision_id uuid NOT NULL,
    proposed_by uuid NOT NULL,
    target text NOT NULL,
    project_id uuid,
    accepted_library_id uuid,
    accepted_by uuid,
    accepted_at timestamp with time zone,
    CONSTRAINT mcp_share_proposal_check CHECK (((target = 'project'::text) = (project_id IS NOT NULL))),
    CONSTRAINT mcp_share_proposal_target_check CHECK ((target = ANY (ARRAY['project'::text, 'system'::text])))
);

CREATE TABLE factory.mcp_token_refresh (
    id uuid NOT NULL,
    connection_id uuid NOT NULL,
    credential_epoch uuid NOT NULL,
    state text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_token_refresh_state_check CHECK ((state = ANY (ARRAY['intended'::text, 'committed'::text, 'uncertain'::text])))
);

CREATE TABLE factory.merge_operation (
    id uuid NOT NULL,
    change_id uuid NOT NULL,
    delivery_approval_id uuid NOT NULL,
    pull_request_number bigint NOT NULL,
    base_sha text NOT NULL,
    commit_sha text NOT NULL,
    idempotency_key text NOT NULL,
    state factory.merge_operation_state DEFAULT 'pending'::factory.merge_operation_state NOT NULL,
    observed_default_sha text,
    last_error text,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT merge_operation_base_sha_check CHECK ((base_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text)),
    CONSTRAINT merge_operation_check CHECK (((state = ANY (ARRAY['succeeded'::factory.merge_operation_state, 'failed'::factory.merge_operation_state])) = (completed_at IS NOT NULL))),
    CONSTRAINT merge_operation_check1 CHECK (((state <> 'succeeded'::factory.merge_operation_state) OR (observed_default_sha = commit_sha))),
    CONSTRAINT merge_operation_commit_sha_check CHECK ((commit_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text)),
    CONSTRAINT merge_operation_observed_default_sha_check CHECK (((observed_default_sha IS NULL) OR (observed_default_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text)))
);

CREATE TABLE factory.model_connection_version (
    connection_id uuid NOT NULL,
    version bigint NOT NULL,
    provider text NOT NULL,
    endpoint text NOT NULL,
    secret_key text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT model_connection_version_provider_check CHECK ((provider = ANY (ARRAY['openai'::text, 'anthropic'::text, 'deepseek'::text]))),
    CONSTRAINT model_connection_version_version_check CHECK ((version > 0))
);

CREATE TABLE factory.model_connection_write (
    command_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    base_version bigint NOT NULL,
    provider text NOT NULL,
    endpoint text NOT NULL,
    fingerprint text NOT NULL,
    secret_key text NOT NULL,
    state text DEFAULT 'write-intended'::text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    committed_at timestamp with time zone,
    CONSTRAINT model_connection_write_base_version_check CHECK ((base_version >= 0)),
    CONSTRAINT model_connection_write_fingerprint_check CHECK ((fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT model_connection_write_provider_check CHECK ((provider = ANY (ARRAY['openai'::text, 'anthropic'::text, 'deepseek'::text]))),
    CONSTRAINT model_connection_write_state_check CHECK ((state = ANY (ARRAY['write-intended'::text, 'committed'::text])))
);

CREATE TABLE factory.model_defaults (
    singleton boolean DEFAULT true NOT NULL,
    version bigint NOT NULL,
    planning_model_id text NOT NULL,
    build_model_id text NOT NULL,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    role_rules jsonb,
    CONSTRAINT model_defaults_build_model_id_check CHECK (((length(build_model_id) >= 1) AND (length(build_model_id) <= 200))),
    CONSTRAINT model_defaults_planning_model_id_check CHECK (((length(planning_model_id) >= 1) AND (length(planning_model_id) <= 200))),
    CONSTRAINT model_defaults_singleton_check CHECK (singleton),
    CONSTRAINT model_defaults_version_check CHECK ((version > 0)),
    CONSTRAINT model_role_rules_object CHECK (((role_rules IS NULL) OR (jsonb_typeof(role_rules) = 'object'::text)))
);

CREATE TABLE factory.model_role_connection (
    role text NOT NULL,
    connection_id uuid NOT NULL,
    connection_version bigint NOT NULL,
    model_id text NOT NULL,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT model_role_connection_role_check CHECK ((role = ANY (ARRAY['planning'::text, 'build'::text])))
);

CREATE TABLE factory.model_role_probe (
    command_id uuid NOT NULL,
    role text NOT NULL,
    connection_id uuid NOT NULL,
    connection_version bigint NOT NULL,
    model_id text NOT NULL,
    settings_version bigint NOT NULL,
    created_by uuid NOT NULL,
    state text NOT NULL,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    reasoning_effort text,
    CONSTRAINT model_role_probe_check CHECK (((state = 'probing'::text) = (result IS NULL))),
    CONSTRAINT model_role_probe_reasoning_check CHECK (((reasoning_effort IS NULL) OR ((role = 'build'::text) AND (reasoning_effort = ANY (ARRAY['medium'::text, 'high'::text, 'xhigh'::text, 'max'::text]))))),
    CONSTRAINT model_role_probe_result_check CHECK (((result IS NULL) OR (jsonb_typeof(result) = 'object'::text))),
    CONSTRAINT model_role_probe_role_check CHECK ((role = ANY (ARRAY['planning'::text, 'build'::text]))),
    CONSTRAINT model_role_probe_settings_version_check CHECK ((settings_version >= 0)),
    CONSTRAINT model_role_probe_state_check CHECK ((state = ANY (ARRAY['probing'::text, 'finished'::text, 'uncertain'::text])))
);

CREATE TABLE factory.monitoring_command (
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    hook_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    input_digest text NOT NULL,
    action text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT monitoring_command_action_check CHECK ((action = ANY (ARRAY['save'::text, 'disable'::text, 'rotate'::text])))
);

CREATE TABLE factory.monitoring_evidence (
    id uuid NOT NULL,
    incident_id uuid NOT NULL,
    kind text NOT NULL,
    digest text NOT NULL,
    path text,
    commit_sha text,
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT monitoring_evidence_digest_check CHECK ((digest ~ '^[a-f0-9]{64}$'::text))
);

CREATE TABLE factory.monitoring_hook (
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    name text NOT NULL,
    version bigint NOT NULL,
    enabled boolean NOT NULL,
    secret_digest text NOT NULL,
    policy_id uuid NOT NULL,
    received_window timestamp with time zone DEFAULT now() NOT NULL,
    received_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT monitoring_hook_name_check CHECK (((length(name) >= 1) AND (length(name) <= 100))),
    CONSTRAINT monitoring_hook_secret_digest_check CHECK ((secret_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT monitoring_hook_version_check CHECK ((version > 0))
);

CREATE TABLE factory.monitoring_incident (
    id uuid NOT NULL,
    hook_id uuid NOT NULL,
    project_id uuid NOT NULL,
    policy_id uuid NOT NULL,
    hook_version bigint NOT NULL,
    fingerprint text NOT NULL,
    payload_digest text NOT NULL,
    title text NOT NULL,
    reference text,
    context text NOT NULL,
    occurrences bigint DEFAULT 1 NOT NULL,
    state text DEFAULT 'queued'::text NOT NULL,
    reason text,
    diagnosis jsonb,
    model_id text,
    model_connection jsonb,
    owner_token uuid,
    owner_expires_at timestamp with time zone,
    ticket_id uuid,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    settled_at timestamp with time zone,
    skill_assignment jsonb,
    CONSTRAINT monitoring_incident_context_check CHECK ((octet_length(context) <= 64000)),
    CONSTRAINT monitoring_incident_fingerprint_check CHECK ((fingerprint ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT monitoring_incident_occurrences_check CHECK ((occurrences > 0)),
    CONSTRAINT monitoring_incident_payload_digest_check CHECK ((payload_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT monitoring_incident_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'diagnosing'::text, 'insufficient-context'::text, 'not-application-defect'::text, 'prepared'::text, 'implementing'::text, 'delivered'::text, 'blocked'::text, 'uncertain'::text])))
);

CREATE TABLE factory.monitoring_policy (
    id uuid NOT NULL,
    hook_id uuid NOT NULL,
    connection_id uuid,
    assignment jsonb,
    delegated_by uuid NOT NULL,
    delegated_at timestamp with time zone DEFAULT now() NOT NULL,
    delegation text NOT NULL,
    instructions text,
    source_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    source_assignments jsonb,
    CONSTRAINT monitoring_policy_delegation_check CHECK ((delegation = ANY (ARRAY['prepare-ticket'::text, 'application-fix-and-delivery'::text]))),
    CONSTRAINT monitoring_policy_instructions_check CHECK (((length(instructions) >= 1) AND (length(instructions) <= 6000)))
);

CREATE TABLE factory.personal_model_settings (
    project_id uuid NOT NULL,
    user_id uuid NOT NULL,
    version bigint NOT NULL,
    planning_model_id text,
    build_model_id text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT personal_model_settings_build_model_id_check CHECK (((length(build_model_id) >= 1) AND (length(build_model_id) <= 200))),
    CONSTRAINT personal_model_settings_planning_model_id_check CHECK (((length(planning_model_id) >= 1) AND (length(planning_model_id) <= 200))),
    CONSTRAINT personal_model_settings_version_check CHECK ((version > 0))
);

CREATE TABLE factory.personal_skill_settings (
    project_id uuid NOT NULL,
    user_id uuid NOT NULL,
    version bigint NOT NULL,
    planning jsonb,
    build jsonb,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT personal_skill_settings_build_check CHECK (((build IS NULL) OR (jsonb_typeof(build) = 'array'::text))),
    CONSTRAINT personal_skill_settings_planning_check CHECK (((planning IS NULL) OR (jsonb_typeof(planning) = 'array'::text))),
    CONSTRAINT personal_skill_settings_version_check CHECK ((version > 0))
);

CREATE TABLE factory.project (
    id uuid NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    repository_url text NOT NULL,
    default_branch text NOT NULL,
    devcontainer_path text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    desktop_background_key text NOT NULL,
    CONSTRAINT project_default_branch_check CHECK (((length(default_branch) >= 1) AND (length(default_branch) <= 200))),
    CONSTRAINT project_desktop_background_key_check CHECK ((desktop_background_key = ANY (ARRAY['river-landscape'::text, 'the-harvesters'::text, 'mountainous-landscape'::text, 'gulf-of-marseille'::text, 'scene-on-the-ice'::text, 'moonlit-landscape'::text]))),
    CONSTRAINT project_devcontainer_path_check CHECK (((devcontainer_path <> ''::text) AND (devcontainer_path !~ '(^/|(^|/)\.\.(/|$))'::text))),
    CONSTRAINT project_name_check CHECK (((length(name) >= 1) AND (length(name) <= 200))),
    CONSTRAINT project_slug_check CHECK ((slug ~ '^[a-z][a-z0-9-]{1,62}$'::text))
);

CREATE TABLE factory.project_environment (
    project_id uuid NOT NULL,
    environment text NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    manifest jsonb DEFAULT '{"variables": [], "registries": []}'::jsonb NOT NULL,
    secret_key text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_environment_environment_check CHECK ((environment = ANY (ARRAY['development'::text, 'main-preview'::text]))),
    CONSTRAINT project_environment_version_check CHECK ((version >= 0))
);

CREATE TABLE factory.project_image_preparation (
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    environment text NOT NULL,
    revision text NOT NULL,
    environment_version bigint NOT NULL,
    runtime_attempt_id uuid,
    state text DEFAULT 'pending'::text NOT NULL,
    identity text,
    image text,
    failure text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_image_preparation_check CHECK (((state = 'succeeded'::text) = ((identity IS NOT NULL) AND (image IS NOT NULL)))),
    CONSTRAINT project_image_preparation_environment_check CHECK ((environment = ANY (ARRAY['development'::text, 'main-preview'::text]))),
    CONSTRAINT project_image_preparation_environment_version_check CHECK ((environment_version >= 0)),
    CONSTRAINT project_image_preparation_identity_check CHECK ((identity ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT project_image_preparation_image_check CHECK ((image ~ '^[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}$'::text)),
    CONSTRAINT project_image_preparation_revision_check CHECK ((revision ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'::text)),
    CONSTRAINT project_image_preparation_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'running'::text, 'succeeded'::text, 'unsupported'::text, 'failed'::text])))
);

CREATE TABLE factory.project_membership (
    project_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    manage_project boolean DEFAULT false NOT NULL,
    CONSTRAINT project_membership_role_check CHECK ((role = ANY (ARRAY['product-contributor'::text, 'developer'::text])))
);

CREATE TABLE factory.project_model_settings (
    project_id uuid NOT NULL,
    version bigint NOT NULL,
    planning jsonb NOT NULL,
    build jsonb NOT NULL,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_model_settings_build_check CHECK ((jsonb_typeof(build) = 'object'::text)),
    CONSTRAINT project_model_settings_planning_check CHECK ((jsonb_typeof(planning) = 'object'::text)),
    CONSTRAINT project_model_settings_version_check CHECK ((version > 0))
);

CREATE TABLE factory.project_release (
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    command_id uuid NOT NULL,
    version text NOT NULL,
    commit_sha text NOT NULL,
    workflow text,
    contract jsonb,
    notes text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    ended_at timestamp with time zone,
    run_id bigint,
    run_url text,
    release_url text,
    artifacts jsonb DEFAULT '[]'::jsonb NOT NULL,
    failure text,
    CONSTRAINT project_release_artifacts_check CHECK ((jsonb_typeof(artifacts) = 'array'::text)),
    CONSTRAINT project_release_commit_sha_check CHECK ((commit_sha ~ '^[a-f0-9]{40}$'::text)),
    CONSTRAINT project_release_contract_check CHECK (((contract IS NULL) OR (jsonb_typeof(contract) = 'object'::text))),
    CONSTRAINT project_release_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'dispatching'::text, 'running'::text, 'checking'::text, 'publishing'::text, 'published'::text, 'failed'::text, 'uncertain'::text]))),
    CONSTRAINT project_release_version_check CHECK ((version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'::text))
);

CREATE TABLE factory.project_repository_intent (
    command_id uuid NOT NULL,
    setup_id uuid NOT NULL,
    user_id uuid NOT NULL,
    project_id uuid NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    kind text NOT NULL,
    source_url text NOT NULL,
    credential_key text,
    fingerprint text NOT NULL,
    state text NOT NULL,
    default_branch text,
    failure text,
    credential_removed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT project_repository_intent_fingerprint_check CHECK ((fingerprint ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT project_repository_intent_kind_check CHECK ((kind = ANY (ARRAY['starter'::text, 'import'::text]))),
    CONSTRAINT project_repository_intent_state_check CHECK ((state = ANY (ARRAY['credential-intended'::text, 'create-intended'::text, 'repository-ready'::text, 'committed'::text, 'uncertain'::text, 'failed'::text])))
);

CREATE TABLE factory.project_setup_confirmation (
    inspection_id uuid NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE factory.project_setup_draft (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    slug text DEFAULT ''::text NOT NULL,
    kind text DEFAULT 'starter'::text NOT NULL,
    source_url text DEFAULT ''::text NOT NULL,
    state text DEFAULT 'draft'::text NOT NULL,
    project_id uuid,
    command_id uuid,
    failure text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_setup_draft_kind_check CHECK ((kind = ANY (ARRAY['starter'::text, 'import'::text]))),
    CONSTRAINT project_setup_draft_name_check CHECK ((length(name) <= 200)),
    CONSTRAINT project_setup_draft_slug_check CHECK (((slug = ''::text) OR (slug ~ '^[a-z][a-z0-9-]{1,62}$'::text))),
    CONSTRAINT project_setup_draft_source_url_check CHECK ((length(source_url) <= 2000)),
    CONSTRAINT project_setup_draft_state_check CHECK ((state = ANY (ARRAY['draft'::text, 'creating'::text, 'checking'::text, 'created'::text, 'failed'::text]))),
    CONSTRAINT project_setup_draft_version_check CHECK ((version > 0))
);

CREATE TABLE factory.project_setup_inspection (
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    source_commit text NOT NULL,
    state text NOT NULL,
    output jsonb,
    failure text,
    model_id text,
    connection_id uuid,
    connection_version bigint,
    parent_id uuid,
    answers jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_setup_inspection_check CHECK (((connection_id IS NULL) = (connection_version IS NULL))),
    CONSTRAINT project_setup_inspection_source_commit_check CHECK ((source_commit ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'::text)),
    CONSTRAINT project_setup_inspection_state_check CHECK ((state = ANY (ARRAY['inspecting'::text, 'complete'::text, 'proposal'::text, 'failed'::text, 'confirming'::text, 'confirmed'::text, 'superseded'::text])))
);

CREATE TABLE factory.project_setup_readiness (
    project_id uuid NOT NULL,
    task text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    command_id uuid NOT NULL,
    operation_id uuid,
    failure text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_setup_readiness_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'running'::text, 'ready'::text, 'failed'::text]))),
    CONSTRAINT project_setup_readiness_task_check CHECK ((task = ANY (ARRAY['configuration'::text, 'development-secrets'::text, 'preview-secrets'::text, 'protection'::text, 'hook'::text, 'wiki'::text, 'development'::text, 'preview-image'::text, 'main-preview'::text])))
);

CREATE TABLE factory.project_skill_settings (
    project_id uuid NOT NULL,
    version bigint NOT NULL,
    planning jsonb NOT NULL,
    build jsonb NOT NULL,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_skill_settings_build_check CHECK ((jsonb_typeof(build) = 'object'::text)),
    CONSTRAINT project_skill_settings_planning_check CHECK ((jsonb_typeof(planning) = 'object'::text)),
    CONSTRAINT project_skill_settings_version_check CHECK ((version > 0))
);

CREATE TABLE factory.promotion_operation (
    id uuid NOT NULL,
    change_id uuid NOT NULL,
    project_id uuid NOT NULL,
    commit_sha text NOT NULL,
    previous_runtime_attempt_id uuid,
    replacement_runtime_attempt_id uuid,
    state factory.promotion_operation_state DEFAULT 'pending'::factory.promotion_operation_state NOT NULL,
    last_error text,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT promotion_operation_check CHECK (((state = ANY (ARRAY['succeeded'::factory.promotion_operation_state, 'failed'::factory.promotion_operation_state])) = (completed_at IS NOT NULL))),
    CONSTRAINT promotion_operation_commit_sha_check CHECK ((commit_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text))
);

CREATE TABLE factory.pull_request_operation (
    id uuid NOT NULL,
    change_id uuid NOT NULL,
    repository_owner text NOT NULL,
    repository_name text NOT NULL,
    base_branch text NOT NULL,
    head_branch text NOT NULL,
    first_head_sha text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    idempotency_key text NOT NULL,
    state factory.pull_request_operation_state DEFAULT 'pending'::factory.pull_request_operation_state NOT NULL,
    pull_request_number bigint,
    pull_request_url text,
    last_error text,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT pull_request_operation_body_check CHECK ((length(body) <= 10000)),
    CONSTRAINT pull_request_operation_check CHECK (((state = ANY (ARRAY['succeeded'::factory.pull_request_operation_state, 'failed'::factory.pull_request_operation_state])) = (completed_at IS NOT NULL))),
    CONSTRAINT pull_request_operation_check1 CHECK (((state <> 'succeeded'::factory.pull_request_operation_state) OR ((pull_request_number IS NOT NULL) AND (pull_request_url IS NOT NULL)))),
    CONSTRAINT pull_request_operation_first_head_sha_check CHECK ((first_head_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text)),
    CONSTRAINT pull_request_operation_title_check CHECK (((length(btrim(title)) >= 1) AND (length(btrim(title)) <= 240)))
);

CREATE TABLE factory.release_access (
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    command_id uuid NOT NULL,
    name text NOT NULL,
    scope text NOT NULL,
    state text NOT NULL,
    username text NOT NULL,
    secret_key text NOT NULL,
    created_by uuid NOT NULL,
    release_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    token_id bigint,
    replaces_id uuid,
    CONSTRAINT release_access_scope_check CHECK ((scope = ANY (ARRAY['git'::text, 'packages'::text, 'publish'::text]))),
    CONSTRAINT release_access_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'active'::text, 'revoking'::text, 'revoked'::text, 'uncertain'::text])))
);

CREATE TABLE factory.release_attempt (
    id uuid NOT NULL,
    release_id uuid NOT NULL,
    command_id uuid NOT NULL,
    ordinal integer NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    dispatch_intended_at timestamp with time zone,
    run_id bigint,
    runner_id bigint,
    runner_uuid text,
    runner_token text,
    job_handle text,
    runtime_attempt_id uuid,
    cleaned_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT release_attempt_check CHECK (((run_id IS NULL) OR (dispatch_intended_at IS NOT NULL))),
    CONSTRAINT release_attempt_ordinal_check CHECK ((ordinal > 0))
);

CREATE TABLE factory.requirement_approval (
    id uuid NOT NULL,
    ticket_id uuid NOT NULL,
    requirement_revision_id uuid NOT NULL,
    approved_by uuid NOT NULL,
    approved_at timestamp with time zone DEFAULT now() NOT NULL,
    monitoring_incident_id uuid,
    monitoring_policy_id uuid,
    CONSTRAINT requirement_monitoring_basis CHECK (((monitoring_incident_id IS NULL) = (monitoring_policy_id IS NULL)))
);

CREATE TABLE factory.requirement_revision (
    id uuid NOT NULL,
    ticket_id uuid NOT NULL,
    ordinal integer NOT NULL,
    canonical_content text NOT NULL,
    content_digest text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT requirement_revision_canonical_content_check CHECK ((length(canonical_content) > 0)),
    CONSTRAINT requirement_revision_check CHECK ((content_digest = encode(factory.digest(convert_to(canonical_content, 'UTF8'::name), 'sha256'::text), 'hex'::text))),
    CONSTRAINT requirement_revision_content_digest_check CHECK ((content_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT requirement_revision_ordinal_check CHECK ((ordinal > 0))
);

CREATE TABLE factory.requirements_entry_intent (
    ticket_id uuid NOT NULL,
    command_id uuid NOT NULL,
    created_by uuid NOT NULL,
    admitted_at timestamp with time zone,
    failure text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE factory.review_feedback (
    id uuid NOT NULL,
    change_id uuid NOT NULL,
    author_id uuid NOT NULL,
    kind text NOT NULL,
    state text DEFAULT 'open'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    commit_sha text NOT NULL,
    annotation jsonb,
    media_id uuid,
    resolved_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT review_feedback_annotation_media CHECK (((media_id IS NULL) OR (annotation IS NOT NULL))),
    CONSTRAINT review_feedback_check CHECK (((kind <> 'comment'::text) OR (state = 'open'::text))),
    CONSTRAINT review_feedback_commit_sha_check CHECK ((commit_sha ~ '^[a-f0-9]{40}$'::text)),
    CONSTRAINT review_feedback_kind_check CHECK ((kind = ANY (ARRAY['comment'::text, 'thread'::text]))),
    CONSTRAINT review_feedback_state_check CHECK ((state = ANY (ARRAY['open'::text, 'implemented'::text, 'resolved'::text])))
);

CREATE TABLE factory.review_feedback_command (
    id uuid NOT NULL,
    change_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    input jsonb NOT NULL,
    feedback_id uuid,
    turn_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE factory.review_feedback_message (
    id uuid NOT NULL,
    feedback_id uuid NOT NULL,
    author_id uuid NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT review_feedback_message_body_check CHECK (((length(body) >= 1) AND (length(body) <= 2000)))
);

CREATE TABLE factory.review_media (
    id uuid NOT NULL,
    change_id uuid NOT NULL,
    review_id uuid,
    browser_session_id uuid,
    created_by uuid,
    kind text NOT NULL,
    commit_sha text NOT NULL,
    runtime_attempt_id uuid,
    source_context jsonb,
    state text NOT NULL,
    byte_length integer,
    sha256 text,
    duration_ms integer,
    reason text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    completed_at timestamp with time zone,
    deleted_at timestamp with time zone,
    CONSTRAINT review_media_byte_length_check CHECK (((byte_length >= 1) AND (byte_length <= 100663296))),
    CONSTRAINT review_media_check CHECK (((state <> 'complete'::text) OR ((byte_length IS NOT NULL) AND (sha256 IS NOT NULL)))),
    CONSTRAINT review_media_check1 CHECK (((kind <> 'recording'::text) OR (review_id IS NOT NULL))),
    CONSTRAINT review_media_commit_sha_check CHECK ((commit_sha ~ '^[a-f0-9]{40}$'::text)),
    CONSTRAINT review_media_duration_ms_check CHECK ((duration_ms >= 0)),
    CONSTRAINT review_media_kind_check CHECK ((kind = ANY (ARRAY['recording'::text, 'still'::text]))),
    CONSTRAINT review_media_sha256_check CHECK ((sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT review_media_state_check CHECK ((state = ANY (ARRAY['intended'::text, 'recording'::text, 'complete'::text, 'unavailable'::text, 'deleted'::text])))
);

CREATE TABLE factory.review_scenario (
    review_id uuid NOT NULL,
    id text NOT NULL,
    title text NOT NULL,
    category text NOT NULL,
    criterion integer NOT NULL,
    expected text NOT NULL,
    started_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    ended_at timestamp with time zone,
    observed text,
    media_started_ms bigint,
    media_session_id uuid,
    status text,
    observation_kind text,
    CONSTRAINT review_scenario_category_check CHECK ((category = ANY (ARRAY['normal'::text, 'error'::text, 'boundary'::text]))),
    CONSTRAINT review_scenario_criterion_check CHECK ((criterion > 0)),
    CONSTRAINT review_scenario_expected_check CHECK (((length(expected) >= 1) AND (length(expected) <= 1000))),
    CONSTRAINT review_scenario_id_check CHECK ((id ~ '^[a-z0-9-]{1,64}$'::text)),
    CONSTRAINT review_scenario_media_started_ms_check CHECK ((media_started_ms >= 0)),
    CONSTRAINT review_scenario_observation_kind_check CHECK ((observation_kind = ANY (ARRAY['app'::text, 'source'::text]))),
    CONSTRAINT review_scenario_observed_check CHECK (((length(observed) >= 1) AND (length(observed) <= 2000))),
    CONSTRAINT review_scenario_status_check CHECK ((status = ANY (ARRAY['passed'::text, 'failed'::text, 'unverified'::text]))),
    CONSTRAINT review_scenario_title_check CHECK (((length(title) >= 1) AND (length(title) <= 200)))
);

CREATE TABLE factory.runtime_artifact_intent (
    runtime_attempt_id uuid NOT NULL,
    role text NOT NULL,
    runtime_host_image text NOT NULL,
    browser_tools_image text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    factorybox_profile jsonb,
    CONSTRAINT runtime_artifact_intent_browser_tools_image_check CHECK ((browser_tools_image ~ '^[a-zA-Z0-9.:/-]+@sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT runtime_artifact_intent_check CHECK (((role = 'build'::text) = (browser_tools_image IS NOT NULL))),
    CONSTRAINT runtime_artifact_intent_role_check CHECK ((role = ANY (ARRAY['development'::text, 'build'::text, 'verification'::text, 'staging'::text]))),
    CONSTRAINT runtime_artifact_intent_runtime_host_image_check CHECK ((runtime_host_image ~ '^[a-zA-Z0-9.:/-]+@sha256:[0-9a-f]{64}$'::text))
);

CREATE TABLE factory.runtime_attempt (
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    change_id uuid,
    workspace_id uuid,
    generation bigint NOT NULL,
    revision text NOT NULL,
    state factory.runtime_attempt_state NOT NULL,
    kubernetes_namespace text NOT NULL,
    kubernetes_namespace_uid text,
    kubernetes_pod_name text NOT NULL,
    kubernetes_uid text,
    parent_connector_token_hash text NOT NULL,
    child_connector_token_hash text NOT NULL,
    create_intended_at timestamp with time zone NOT NULL,
    create_observed_at timestamp with time zone,
    stop_intended_at timestamp with time zone,
    stopped_at timestamp with time zone,
    failure text,
    declared_apps jsonb DEFAULT '[]'::jsonb NOT NULL CHECK (jsonb_typeof(declared_apps) = 'array'),
    cleanup_attempts integer DEFAULT 0 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    isolated_kind factory.isolated_runtime_kind,
    verification_id uuid,
    CONSTRAINT runtime_attempt_cleanup_attempts_check CHECK ((cleanup_attempts >= 0)),
    CONSTRAINT runtime_attempt_generation_check CHECK ((generation > 0)),
    CONSTRAINT runtime_attempt_owner_shape_check CHECK ((((workspace_id IS NOT NULL) AND (isolated_kind IS NULL)) OR ((change_id IS NOT NULL) AND (workspace_id IS NOT NULL) AND (isolated_kind IS NULL)) OR ((change_id IS NULL) AND (workspace_id IS NULL) AND (isolated_kind IS NOT NULL)))),
    CONSTRAINT runtime_attempt_verification_shape_check CHECK (((isolated_kind = 'verification'::factory.isolated_runtime_kind) = (verification_id IS NOT NULL)))
);

CREATE TABLE factory.runtime_compute_wait (
    attempt_id uuid NOT NULL,
    reason text DEFAULT 'compute-capacity'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT runtime_compute_wait_reason_check CHECK ((reason = ANY (ARRAY['compute-capacity'::text, 'accounting-incomplete'::text, 'coding-budget-used'::text, 'finish-reserve-used'::text])))
);

CREATE TABLE factory.runtime_environment_intent (
    runtime_attempt_id uuid NOT NULL,
    environment text NOT NULL,
    version bigint NOT NULL,
    secret_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT runtime_environment_intent_environment_check CHECK ((environment = ANY (ARRAY['development'::text, 'main-preview'::text]))),
    CONSTRAINT runtime_environment_intent_version_check CHECK ((version >= 0))
);

CREATE TABLE factory.schema_migration (
    version integer NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE factory.skill_library (
    id uuid NOT NULL,
    storage_key text NOT NULL,
    scope text NOT NULL,
    owner_id uuid,
    project_id uuid,
    CONSTRAINT skill_library_check CHECK ((((scope = 'personal'::text) AND (owner_id IS NOT NULL) AND (project_id IS NULL)) OR ((scope = 'project'::text) AND (owner_id IS NULL) AND (project_id IS NOT NULL)) OR ((scope = 'system'::text) AND (owner_id IS NULL) AND (project_id IS NULL)))),
    CONSTRAINT skill_library_scope_check CHECK ((scope = ANY (ARRAY['system'::text, 'project'::text, 'personal'::text])))
);

CREATE TABLE factory.skill_library_choice (
    library_id uuid NOT NULL,
    scope text NOT NULL,
    context_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    state text NOT NULL,
    revision_id uuid NOT NULL,
    version bigint NOT NULL,
    CONSTRAINT skill_library_choice_check CHECK (((state <> 'required'::text) OR (scope <> 'personal'::text))),
    CONSTRAINT skill_library_choice_role_check CHECK ((role = ANY (ARRAY['planning'::text, 'build'::text]))),
    CONSTRAINT skill_library_choice_scope_check CHECK ((scope = ANY (ARRAY['system'::text, 'project'::text, 'personal'::text]))),
    CONSTRAINT skill_library_choice_state_check CHECK ((state = ANY (ARRAY['inherit'::text, 'enable'::text, 'disable'::text, 'required'::text]))),
    CONSTRAINT skill_library_choice_version_check CHECK ((version > 0))
);

CREATE TABLE factory.skill_library_revision (
    library_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    copied_from uuid
);

CREATE TABLE factory.skill_publication (
    revision_id uuid NOT NULL,
    published boolean NOT NULL,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE factory.skill_revision (
    id uuid NOT NULL,
    skill_key text NOT NULL,
    revision bigint NOT NULL,
    content jsonb NOT NULL,
    content_digest text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT skill_revision_content_check CHECK (((jsonb_typeof(content) = 'object'::text) AND (octet_length((content)::text) <= 2100000))),
    CONSTRAINT skill_revision_content_digest_check CHECK ((content_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT skill_revision_revision_check CHECK ((revision > 0)),
    CONSTRAINT skill_revision_skill_key_check CHECK ((skill_key ~ '^[a-z][a-z0-9-]{1,63}$'::text))
);

CREATE TABLE factory.skill_share_proposal (
    id uuid NOT NULL,
    revision_id uuid NOT NULL,
    proposed_by uuid NOT NULL,
    target text NOT NULL,
    project_id uuid,
    accepted_library_id uuid,
    CONSTRAINT skill_share_proposal_check CHECK (((target = 'project'::text) = (project_id IS NOT NULL))),
    CONSTRAINT skill_share_proposal_target_check CHECK ((target = ANY (ARRAY['system'::text, 'project'::text])))
);

CREATE TABLE factory.staging_preview (
    project_id uuid NOT NULL,
    revision text NOT NULL,
    runtime_attempt_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT staging_preview_revision_check CHECK ((revision ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text))
);

CREATE TABLE factory.system_skill_settings (
    singleton boolean DEFAULT true NOT NULL,
    version bigint NOT NULL,
    planning jsonb NOT NULL,
    build jsonb NOT NULL,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT system_skill_settings_build_check CHECK ((jsonb_typeof(build) = 'object'::text)),
    CONSTRAINT system_skill_settings_planning_check CHECK ((jsonb_typeof(planning) = 'object'::text)),
    CONSTRAINT system_skill_settings_singleton_check CHECK (singleton),
    CONSTRAINT system_skill_settings_version_check CHECK ((version > 0))
);

CREATE TABLE factory.ticket (
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    title text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    state factory.ticket_state DEFAULT 'inbox'::factory.ticket_state NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    epic_id uuid,
    trashed_at timestamp with time zone,
    trashed_by uuid,
    trash_stop_pending boolean DEFAULT false NOT NULL,
    trash_error text,
    converted_to_epic_id uuid,
    CONSTRAINT ticket_description_check CHECK ((length(description) <= 10000)),
    CONSTRAINT ticket_title_check CHECK (((length(btrim(title)) >= 1) AND (length(btrim(title)) <= 200))),
    CONSTRAINT ticket_version_check CHECK ((version > 0))
);

CREATE TABLE factory.ticket_conversation (
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    ticket_id uuid,
    mode factory.conversation_mode DEFAULT 'investigate'::factory.conversation_mode NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    active_coding_context_id uuid,
    CONSTRAINT ticket_conversation_version_check CHECK ((version > 0))
);

CREATE TABLE factory.ticket_dependency (
    project_id uuid NOT NULL,
    ticket_id uuid NOT NULL,
    prerequisite_id uuid NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ticket_dependency_check CHECK ((ticket_id <> prerequisite_id))
);

CREATE TABLE factory.ticket_document_revision (
    id uuid NOT NULL,
    ticket_id uuid NOT NULL,
    ordinal integer NOT NULL,
    title text NOT NULL,
    description text NOT NULL,
    canonical_content text NOT NULL,
    content_digest text NOT NULL,
    requirement_revision_id uuid,
    input_digest text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    author_kind text DEFAULT 'human'::text NOT NULL,
    proposal_entry_id uuid,
    CONSTRAINT ticket_document_revision_author_kind_check CHECK ((author_kind = ANY (ARRAY['human'::text, 'ai'::text]))),
    CONSTRAINT ticket_document_revision_check CHECK ((content_digest = encode(factory.digest(convert_to(canonical_content, 'UTF8'::name), 'sha256'::text), 'hex'::text))),
    CONSTRAINT ticket_document_revision_content_digest_check CHECK ((content_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT ticket_document_revision_input_digest_check CHECK ((input_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT ticket_document_revision_ordinal_check CHECK ((ordinal > 0)),
    CONSTRAINT ticket_document_revision_title_check CHECK ((length(title) > 0))
);

CREATE TABLE factory.ticket_follow_up (
    ticket_id uuid NOT NULL,
    source_ticket_id uuid NOT NULL,
    source_document_id uuid,
    source_revision_id uuid NOT NULL,
    CONSTRAINT ticket_follow_up_check CHECK ((ticket_id <> source_ticket_id))
);

CREATE TABLE factory.usage_entry (
    operation_id text NOT NULL,
    event_id text NOT NULL,
    source text NOT NULL,
    outcome text NOT NULL,
    counters jsonb NOT NULL,
    nano_usd bigint,
    known_nano_usd bigint NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    CONSTRAINT usage_entry_event_id_check CHECK (((length(event_id) >= 1) AND (length(event_id) <= 400))),
    CONSTRAINT usage_entry_known_nano_usd_check CHECK ((known_nano_usd >= 0)),
    CONSTRAINT usage_entry_nano_usd_check CHECK ((nano_usd >= 0)),
    CONSTRAINT usage_entry_outcome_check CHECK ((outcome = ANY (ARRAY['completed'::text, 'failed'::text, 'interrupted'::text, 'unknown'::text]))),
    CONSTRAINT usage_entry_source_check CHECK ((source = ANY (ARRAY['step'::text, 'title'::text, 'compaction'::text, 'unobserved'::text])))
);

CREATE TABLE factory.usage_operation (
    id text NOT NULL,
    project_id uuid,
    user_id uuid,
    purpose text NOT NULL,
    engine text NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    rate jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    settled_at timestamp with time zone,
    outcome text,
    CONSTRAINT usage_operation_check CHECK (((settled_at IS NULL) = (outcome IS NULL))),
    CONSTRAINT usage_operation_engine_check CHECK ((engine = ANY (ARRAY['opencode'::text, 'mastra'::text]))),
    CONSTRAINT usage_operation_id_check CHECK (((length(id) >= 1) AND (length(id) <= 400))),
    CONSTRAINT usage_operation_outcome_check CHECK ((outcome = ANY (ARRAY['completed'::text, 'failed'::text, 'interrupted'::text, 'unknown'::text]))),
    CONSTRAINT usage_operation_purpose_check CHECK ((purpose = ANY (ARRAY['coding'::text, 'research'::text, 'requirements'::text, 'wiki'::text, 'setup'::text, 'probe'::text])))
);

CREATE TABLE factory.usage_rate_override (
    provider text NOT NULL,
    model text NOT NULL,
    version bigint NOT NULL,
    rate jsonb,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT usage_rate_override_version_check CHECK ((version > 0))
);

CREATE TABLE factory.usage_replay_cursor (
    operation_id text NOT NULL,
    session_id text NOT NULL,
    sequence bigint NOT NULL,
    start_sequence bigint DEFAULT 0 NOT NULL,
    CONSTRAINT usage_replay_cursor_sequence_check CHECK ((sequence >= 0)),
    CONSTRAINT usage_replay_cursor_start_sequence_check CHECK ((start_sequence >= 0))
);

CREATE TABLE factory.user_ui_preference (
    user_id uuid NOT NULL,
    desktop_background_key text DEFAULT 'river-landscape'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_ui_preference_desktop_background_key_check CHECK ((desktop_background_key = ANY (ARRAY['river-landscape'::text, 'the-harvesters'::text, 'mountainous-landscape'::text])))
);

CREATE TABLE factory.verification (
    id uuid NOT NULL,
    change_id uuid NOT NULL,
    commit_sha text NOT NULL,
    pull_request_number bigint NOT NULL,
    workflow_id text DEFAULT 'factory-verification.yml'::text NOT NULL,
    action_run_id bigint,
    action_run_url text,
    runtime_attempt_id uuid,
    runner_name text NOT NULL,
    runner_id bigint,
    runner_uuid uuid,
    runner_token text,
    state factory.verification_state DEFAULT 'pending'::factory.verification_state NOT NULL,
    summary text,
    repair_prompted_at timestamp with time zone,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT verification_check CHECK (((state = ANY (ARRAY['succeeded'::factory.verification_state, 'failed'::factory.verification_state, 'cancelled'::factory.verification_state])) = (completed_at IS NOT NULL))),
    CONSTRAINT verification_check1 CHECK (((state <> ALL (ARRAY['runner-starting'::factory.verification_state, 'running'::factory.verification_state, 'succeeded'::factory.verification_state, 'failed'::factory.verification_state])) OR (action_run_id IS NOT NULL))),
    CONSTRAINT verification_check2 CHECK (((runtime_attempt_id IS NULL) OR (runner_token IS NOT NULL))),
    CONSTRAINT verification_commit_sha_check CHECK ((commit_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text)),
    CONSTRAINT verification_summary_check CHECK (((summary IS NULL) OR (length(summary) <= 2000)))
);

CREATE TABLE factory.wiki_source_update (
    project_id uuid NOT NULL,
    target_url text NOT NULL,
    hook_id bigint,
    hook_state text DEFAULT 'create-intended'::text NOT NULL,
    hook_lease uuid,
    hook_lease_until timestamp with time zone,
    event_version bigint DEFAULT 0 NOT NULL,
    handled_version bigint DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    failure text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT wiki_source_update_check CHECK (((handled_version >= 0) AND (handled_version <= event_version))),
    CONSTRAINT wiki_source_update_event_version_check CHECK ((event_version >= 0)),
    CONSTRAINT wiki_source_update_hook_state_check CHECK ((hook_state = ANY (ARRAY['create-intended'::text, 'ready'::text, 'failed'::text])))
);

CREATE TABLE factory.workspace_source (
    workspace_id uuid NOT NULL,
    source_directory text GENERATED ALWAYS AS (('workspaces/'::text || replace(workspace_id::text, '-'::text, ''::text)) || '/home'::text) STORED NOT NULL,
    access_epoch bigint DEFAULT 1 NOT NULL,
    resource_key text GENERATED ALWAYS AS ((replace(workspace_id::text, '-'::text, ''::text) || '-'::text) || access_epoch::text) STORED NOT NULL,
    state text NOT NULL,
    files_image text NOT NULL,
    capability_hash text NOT NULL,
    namespace_uid text,
    claim_uid text,
    pod_uid text,
    storage_node text,
    failure text,
    create_intended_at timestamp with time zone DEFAULT now() NOT NULL,
    create_observed_at timestamp with time zone,
    stop_intended_at timestamp with time zone,
    stopped_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_source_access_epoch_check CHECK ((access_epoch > 0)),
    CONSTRAINT workspace_source_capability_hash_check CHECK ((capability_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT workspace_source_files_image_check CHECK ((files_image ~ '@sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT workspace_source_state_check CHECK ((state = ANY (ARRAY['create-intended'::text, 'preparing'::text, 'ready'::text, 'failed'::text, 'stop-intended'::text, 'stopped'::text])))
);

ALTER TABLE ONLY auth.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.account
    ADD CONSTRAINT account_provider_id_account_id_key UNIQUE (provider_id, account_id);

ALTER TABLE ONLY auth.jwks
    ADD CONSTRAINT jwks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY auth."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_token_key" UNIQUE (token);

ALTER TABLE ONLY auth."oauthClientAssertion"
    ADD CONSTRAINT "oauthClientAssertion_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY auth."oauthClientResource"
    ADD CONSTRAINT "oauthClientResource_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY auth."oauthClient"
    ADD CONSTRAINT "oauthClient_clientId_key" UNIQUE ("clientId");

ALTER TABLE ONLY auth."oauthClient"
    ADD CONSTRAINT "oauthClient_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY auth."oauthConsent"
    ADD CONSTRAINT "oauthConsent_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY auth."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY auth."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_token_key" UNIQUE (token);

ALTER TABLE ONLY auth."oauthResource"
    ADD CONSTRAINT "oauthResource_identifier_key" UNIQUE (identifier);

ALTER TABLE ONLY auth."oauthResource"
    ADD CONSTRAINT "oauthResource_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY auth."scimConnectionBinding"
    ADD CONSTRAINT "scimConnectionBinding_connectionKey_key" UNIQUE ("connectionKey");

ALTER TABLE ONLY auth."scimConnectionBinding"
    ADD CONSTRAINT "scimConnectionBinding_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY auth."scimGroupMember"
    ADD CONSTRAINT "scimGroupMember_membershipKey_key" UNIQUE ("membershipKey");

ALTER TABLE ONLY auth."scimGroupMember"
    ADD CONSTRAINT "scimGroupMember_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY auth."scimGroup"
    ADD CONSTRAINT "scimGroup_displayNameKey_key" UNIQUE ("displayNameKey");

ALTER TABLE ONLY auth."scimGroup"
    ADD CONSTRAINT "scimGroup_externalIdKey_key" UNIQUE ("externalIdKey");

ALTER TABLE ONLY auth."scimGroup"
    ADD CONSTRAINT "scimGroup_orderKey_key" UNIQUE ("orderKey");

ALTER TABLE ONLY auth."scimGroup"
    ADD CONSTRAINT "scimGroup_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY auth."scimIdentityTombstone"
    ADD CONSTRAINT "scimIdentityTombstone_externalIdKey_key" UNIQUE ("externalIdKey");

ALTER TABLE ONLY auth."scimIdentityTombstone"
    ADD CONSTRAINT "scimIdentityTombstone_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY auth."scimProjectionGrant"
    ADD CONSTRAINT "scimProjectionGrant_grantKey_key" UNIQUE ("grantKey");

ALTER TABLE ONLY auth."scimProjectionGrant"
    ADD CONSTRAINT "scimProjectionGrant_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY auth."scimSubject"
    ADD CONSTRAINT "scimSubject_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY auth."scimSubject"
    ADD CONSTRAINT "scimSubject_userId_key" UNIQUE ("userId");

ALTER TABLE ONLY auth."scimUser"
    ADD CONSTRAINT "scimUser_connectionUserKey_key" UNIQUE ("connectionUserKey");

ALTER TABLE ONLY auth."scimUser"
    ADD CONSTRAINT "scimUser_externalIdKey_key" UNIQUE ("externalIdKey");

ALTER TABLE ONLY auth."scimUser"
    ADD CONSTRAINT "scimUser_orderKey_key" UNIQUE ("orderKey");

ALTER TABLE ONLY auth."scimUser"
    ADD CONSTRAINT "scimUser_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY auth."scimUser"
    ADD CONSTRAINT "scimUser_userNameKey_key" UNIQUE ("userNameKey");

ALTER TABLE ONLY auth.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.session
    ADD CONSTRAINT session_token_key UNIQUE (token);

ALTER TABLE ONLY auth."ssoProvider"
    ADD CONSTRAINT "ssoProvider_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY auth."ssoProvider"
    ADD CONSTRAINT "ssoProvider_providerId_key" UNIQUE ("providerId");

ALTER TABLE ONLY auth."user"
    ADD CONSTRAINT user_email_key UNIQUE (email);

ALTER TABLE ONLY auth."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.access_revocation
    ADD CONSTRAINT access_revocation_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY factory.account_access
    ADD CONSTRAINT account_access_id_key UNIQUE (id);

ALTER TABLE ONLY factory.account_access
    ADD CONSTRAINT account_access_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY factory.administrator
    ADD CONSTRAINT administrator_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY factory.agent_turn
    ADD CONSTRAINT agent_turn_command_id_key UNIQUE (command_id);

ALTER TABLE ONLY factory.agent_turn_mcp
    ADD CONSTRAINT agent_turn_mcp_pkey PRIMARY KEY (turn_id, connection_id);

ALTER TABLE ONLY factory.agent_turn
    ADD CONSTRAINT agent_turn_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.agent_turn_skill
    ADD CONSTRAINT agent_turn_skill_pkey PRIMARY KEY (turn_id, revision_id);

ALTER TABLE ONLY factory.attachment_draft
    ADD CONSTRAINT attachment_draft_pkey PRIMARY KEY (id, owner_id);

ALTER TABLE ONLY factory.attachment
    ADD CONSTRAINT attachment_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.attachment_reference
    ADD CONSTRAINT attachment_reference_pkey PRIMARY KEY (attachment_id, kind, reference_id);

ALTER TABLE ONLY factory.attachment_storage
    ADD CONSTRAINT attachment_storage_id_key UNIQUE (id);

ALTER TABLE ONLY factory.attachment_storage
    ADD CONSTRAINT attachment_storage_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY factory.attachment_turn_context
    ADD CONSTRAINT attachment_turn_context_pkey PRIMARY KEY (turn_id, source);

ALTER TABLE ONLY factory.branch_create_operation
    ADD CONSTRAINT branch_create_operation_change_id_key UNIQUE (change_id);

ALTER TABLE ONLY factory.branch_create_operation
    ADD CONSTRAINT branch_create_operation_idempotency_key_key UNIQUE (idempotency_key);

ALTER TABLE ONLY factory.branch_create_operation
    ADD CONSTRAINT branch_create_operation_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.branch_create_operation
    ADD CONSTRAINT branch_create_operation_repository_owner_repository_name_br_key UNIQUE (repository_owner, repository_name, branch_name);

ALTER TABLE ONLY factory.build_browser_session
    ADD CONSTRAINT build_browser_session_owner_ordinal_key UNIQUE (turn_id, owner_id, ordinal);

ALTER TABLE ONLY factory.build_browser_session
    ADD CONSTRAINT build_browser_session_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.candidate_review
    ADD CONSTRAINT candidate_review_id_change_id_verification_id_commit_sha_key UNIQUE (id, change_id, verification_id, commit_sha);

ALTER TABLE ONLY factory.candidate_review
    ADD CONSTRAINT candidate_review_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.candidate_review
    ADD CONSTRAINT candidate_review_repair_command_id_key UNIQUE (repair_command_id);

ALTER TABLE ONLY factory.candidate_review
    ADD CONSTRAINT candidate_review_supersedes_id_key UNIQUE (supersedes_id);

ALTER TABLE ONLY factory.candidate_review
    ADD CONSTRAINT candidate_review_turn_id_key UNIQUE (turn_id);

ALTER TABLE ONLY factory.candidate_review
    ADD CONSTRAINT candidate_review_verification_id_ordinal_key UNIQUE (verification_id, ordinal);

ALTER TABLE ONLY factory.change_agent_session
    ADD CONSTRAINT change_agent_session_pkey PRIMARY KEY (change_id);

ALTER TABLE ONLY factory.change_agent_turn_intent
    ADD CONSTRAINT change_agent_turn_intent_pkey PRIMARY KEY (turn_id);

ALTER TABLE ONLY factory.change_agent_turn_intent
    ADD CONSTRAINT change_agent_turn_intent_prompt_id_key UNIQUE (prompt_id);

ALTER TABLE ONLY factory.change_commit_operation
    ADD CONSTRAINT change_commit_operation_change_id_sequence_key UNIQUE (change_id, sequence);

ALTER TABLE ONLY factory.change_commit_operation
    ADD CONSTRAINT change_commit_operation_idempotency_key_key UNIQUE (idempotency_key);

ALTER TABLE ONLY factory.change_commit_operation
    ADD CONSTRAINT change_commit_operation_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.change_editing_decision
    ADD CONSTRAINT change_editing_decision_pkey PRIMARY KEY (command_id);

ALTER TABLE ONLY factory.change_editing_request
    ADD CONSTRAINT change_editing_request_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_id_branch_name_base_sha_key UNIQUE (id, branch_name, base_sha);

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_id_project_id_base_sha_key UNIQUE (id, project_id, base_sha);

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_id_project_id_key UNIQUE (id, project_id);

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_id_ticket_id_key UNIQUE (id, ticket_id);

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_project_id_branch_name_key UNIQUE (project_id, branch_name);

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_requirement_approval_id_key UNIQUE (requirement_approval_id);

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_runtime_attempt_id_key UNIQUE (runtime_attempt_id);

ALTER TABLE ONLY factory.change_writer
    ADD CONSTRAINT change_writer_pkey PRIMARY KEY (change_id);

ALTER TABLE ONLY factory.coding_pause
    ADD CONSTRAINT coding_pause_pkey PRIMARY KEY (turn_id);

ALTER TABLE ONLY factory.conversation_context
    ADD CONSTRAINT conversation_context_command_id_key UNIQUE (command_id);

ALTER TABLE ONLY factory.conversation_context
    ADD CONSTRAINT conversation_context_conversation_id_ordinal_key UNIQUE (conversation_id, ordinal);

ALTER TABLE ONLY factory.conversation_context
    ADD CONSTRAINT conversation_context_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.conversation_entry
    ADD CONSTRAINT conversation_entry_conversation_id_ordinal_key UNIQUE (conversation_id, ordinal);

ALTER TABLE ONLY factory.conversation_entry
    ADD CONSTRAINT conversation_entry_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.delivery_approval
    ADD CONSTRAINT delivery_approval_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.delivery_approval
    ADD CONSTRAINT delivery_approval_verification_id_key UNIQUE (verification_id);

ALTER TABLE ONLY factory.developer_ide
    ADD CONSTRAINT developer_ide_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY factory.developer_ide
    ADD CONSTRAINT developer_ide_resource_id_unique UNIQUE (resource_id);

ALTER TABLE ONLY factory.development_workspace
    ADD CONSTRAINT development_workspace_id_change_id_key UNIQUE (id, change_id);

ALTER TABLE ONLY factory.development_workspace
    ADD CONSTRAINT development_workspace_id_project_id_key UNIQUE (id, project_id);

ALTER TABLE ONLY factory.development_workspace
    ADD CONSTRAINT development_workspace_kubernetes_namespace_key UNIQUE (kubernetes_namespace);

ALTER TABLE ONLY factory.development_workspace
    ADD CONSTRAINT development_workspace_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.environment_write
    ADD CONSTRAINT environment_write_pkey PRIMARY KEY (command_id);

ALTER TABLE ONLY factory.environment_write
    ADD CONSTRAINT environment_write_secret_key_key UNIQUE (secret_key);

ALTER TABLE ONLY factory.epic_confirmation
    ADD CONSTRAINT epic_confirmation_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.epic_confirmation
    ADD CONSTRAINT epic_confirmation_proposal_entry_id_key UNIQUE (proposal_entry_id);

ALTER TABLE ONLY factory.epic
    ADD CONSTRAINT epic_id_project_id_key UNIQUE (id, project_id);

ALTER TABLE ONLY factory.epic
    ADD CONSTRAINT epic_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.execution_policy_command
    ADD CONSTRAINT execution_policy_command_pkey PRIMARY KEY (command_id);

ALTER TABLE ONLY factory.execution_policy
    ADD CONSTRAINT execution_policy_pkey PRIMARY KEY (scope);

ALTER TABLE ONLY factory.execution_slot
    ADD CONSTRAINT execution_slot_assigned_attempt_id_key UNIQUE (assigned_attempt_id);

ALTER TABLE ONLY factory.execution_slot
    ADD CONSTRAINT execution_slot_kubernetes_namespace_key UNIQUE (kubernetes_namespace);

ALTER TABLE ONLY factory.execution_slot
    ADD CONSTRAINT execution_slot_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.external_identity
    ADD CONSTRAINT external_identity_issuer_subject_key UNIQUE (issuer, subject);

ALTER TABLE ONLY factory.external_identity
    ADD CONSTRAINT external_identity_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.factorybox_lifecycle_operation
    ADD CONSTRAINT factorybox_lifecycle_operatio_runtime_attempt_id_action_sna_key UNIQUE NULLS NOT DISTINCT (runtime_attempt_id, action, snapshot_id);

ALTER TABLE ONLY factory.factorybox_lifecycle_operation
    ADD CONSTRAINT factorybox_lifecycle_operation_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.factorybox_runtime
    ADD CONSTRAINT factorybox_runtime_pkey PRIMARY KEY (runtime_attempt_id);

ALTER TABLE ONLY factory.forge_account_intent
    ADD CONSTRAINT forge_account_intent_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY factory.forge_account_intent
    ADD CONSTRAINT forge_account_intent_username_key UNIQUE (username);

ALTER TABLE ONLY factory.forge_branch_intent
    ADD CONSTRAINT forge_branch_intent_pkey PRIMARY KEY (project_id, branch);

ALTER TABLE ONLY factory.forge_connection
    ADD CONSTRAINT forge_connection_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.forge_grant_intent
    ADD CONSTRAINT forge_grant_intent_pkey PRIMARY KEY (project_id, user_id);

ALTER TABLE ONLY factory.forge_identity_intent
    ADD CONSTRAINT forge_identity_intent_pkey PRIMARY KEY (client_id);

ALTER TABLE ONLY factory.identity_configuration
    ADD CONSTRAINT identity_configuration_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY factory.identity_setup
    ADD CONSTRAINT identity_setup_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.identity_setup
    ADD CONSTRAINT identity_setup_secret_key_key UNIQUE (secret_key);

ALTER TABLE ONLY factory.installation_maintenance
    ADD CONSTRAINT installation_maintenance_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY factory.knowledge_generation
    ADD CONSTRAINT knowledge_generation_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.knowledge_page_alias
    ADD CONSTRAINT knowledge_page_alias_pkey PRIMARY KEY (project_id, slug);

ALTER TABLE ONLY factory.knowledge_page
    ADD CONSTRAINT knowledge_page_id_project_id_key UNIQUE (id, project_id);

ALTER TABLE ONLY factory.knowledge_page
    ADD CONSTRAINT knowledge_page_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.knowledge_page
    ADD CONSTRAINT knowledge_page_project_id_slug_key UNIQUE (project_id, slug);

ALTER TABLE ONLY factory.knowledge_page
    ADD CONSTRAINT knowledge_page_project_identity UNIQUE (project_id, id);

ALTER TABLE ONLY factory.knowledge_revision
    ADD CONSTRAINT knowledge_revision_id_page_id_key UNIQUE (id, page_id);

ALTER TABLE ONLY factory.knowledge_revision
    ADD CONSTRAINT knowledge_revision_page_id_ordinal_key UNIQUE (page_id, ordinal);

ALTER TABLE ONLY factory.knowledge_revision
    ADD CONSTRAINT knowledge_revision_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.mcp_access_decision
    ADD CONSTRAINT mcp_access_decision_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.mcp_choice
    ADD CONSTRAINT mcp_choice_pkey PRIMARY KEY (library_id, scope, context_id, user_id, role);

ALTER TABLE ONLY factory.mcp_connect_intent
    ADD CONSTRAINT mcp_connect_intent_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.mcp_connection
    ADD CONSTRAINT mcp_connection_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.mcp_library
    ADD CONSTRAINT mcp_library_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.mcp_oauth_flow
    ADD CONSTRAINT mcp_oauth_flow_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.mcp_oauth_flow
    ADD CONSTRAINT mcp_oauth_flow_state_digest_key UNIQUE (state_digest);

ALTER TABLE ONLY factory.mcp_observation
    ADD CONSTRAINT mcp_observation_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.mcp_policy_approval
    ADD CONSTRAINT mcp_policy_approval_connection_id_version_key UNIQUE (connection_id, version);

ALTER TABLE ONLY factory.mcp_policy_approval
    ADD CONSTRAINT mcp_policy_approval_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.mcp_project_grant
    ADD CONSTRAINT mcp_project_grant_pkey PRIMARY KEY (connection_id, project_id);

ALTER TABLE ONLY factory.mcp_revision
    ADD CONSTRAINT mcp_revision_library_id_revision_key UNIQUE (library_id, revision);

ALTER TABLE ONLY factory.mcp_revision
    ADD CONSTRAINT mcp_revision_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.mcp_secret_write
    ADD CONSTRAINT mcp_secret_write_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.mcp_secret_write
    ADD CONSTRAINT mcp_secret_write_secret_key_key UNIQUE (secret_key);

ALTER TABLE ONLY factory.mcp_share_proposal
    ADD CONSTRAINT mcp_share_proposal_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.mcp_token_refresh
    ADD CONSTRAINT mcp_token_refresh_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.merge_operation
    ADD CONSTRAINT merge_operation_change_id_key UNIQUE (change_id);

ALTER TABLE ONLY factory.merge_operation
    ADD CONSTRAINT merge_operation_delivery_approval_id_key UNIQUE (delivery_approval_id);

ALTER TABLE ONLY factory.merge_operation
    ADD CONSTRAINT merge_operation_idempotency_key_key UNIQUE (idempotency_key);

ALTER TABLE ONLY factory.merge_operation
    ADD CONSTRAINT merge_operation_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.model_connection_version
    ADD CONSTRAINT model_connection_version_pkey PRIMARY KEY (connection_id, version);

ALTER TABLE ONLY factory.model_connection_version
    ADD CONSTRAINT model_connection_version_secret_key_key UNIQUE (secret_key);

ALTER TABLE ONLY factory.model_connection_write
    ADD CONSTRAINT model_connection_write_pkey PRIMARY KEY (command_id);

ALTER TABLE ONLY factory.model_connection_write
    ADD CONSTRAINT model_connection_write_secret_key_key UNIQUE (secret_key);

ALTER TABLE ONLY factory.model_defaults
    ADD CONSTRAINT model_defaults_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY factory.model_role_connection
    ADD CONSTRAINT model_role_connection_pkey PRIMARY KEY (role);

ALTER TABLE ONLY factory.model_role_probe
    ADD CONSTRAINT model_role_probe_pkey PRIMARY KEY (command_id);

ALTER TABLE ONLY factory.monitoring_command
    ADD CONSTRAINT monitoring_command_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.monitoring_evidence
    ADD CONSTRAINT monitoring_evidence_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.monitoring_hook
    ADD CONSTRAINT monitoring_hook_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.monitoring_incident
    ADD CONSTRAINT monitoring_incident_hook_id_fingerprint_key UNIQUE (hook_id, fingerprint);

ALTER TABLE ONLY factory.monitoring_incident
    ADD CONSTRAINT monitoring_incident_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.monitoring_policy
    ADD CONSTRAINT monitoring_policy_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.personal_model_settings
    ADD CONSTRAINT personal_model_settings_pkey PRIMARY KEY (project_id, user_id);

ALTER TABLE ONLY factory.personal_skill_settings
    ADD CONSTRAINT personal_skill_settings_pkey PRIMARY KEY (project_id, user_id);

ALTER TABLE ONLY factory.project_environment
    ADD CONSTRAINT project_environment_pkey PRIMARY KEY (project_id, environment);

ALTER TABLE ONLY factory.project_image_preparation
    ADD CONSTRAINT project_image_preparation_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.project_image_preparation
    ADD CONSTRAINT project_image_preparation_project_id_environment_revision_e_key UNIQUE (project_id, environment, revision, environment_version);

ALTER TABLE ONLY factory.project_image_preparation
    ADD CONSTRAINT project_image_preparation_runtime_attempt_id_key UNIQUE (runtime_attempt_id);

ALTER TABLE ONLY factory.project_membership
    ADD CONSTRAINT project_membership_pkey PRIMARY KEY (project_id, user_id);

ALTER TABLE ONLY factory.project_model_settings
    ADD CONSTRAINT project_model_settings_pkey PRIMARY KEY (project_id);

ALTER TABLE ONLY factory.project
    ADD CONSTRAINT project_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.project_release
    ADD CONSTRAINT project_release_command_id_key UNIQUE (command_id);

ALTER TABLE ONLY factory.project_release
    ADD CONSTRAINT project_release_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.project_release
    ADD CONSTRAINT project_release_project_id_version_key UNIQUE (project_id, version);

ALTER TABLE ONLY factory.project_repository_intent
    ADD CONSTRAINT project_repository_intent_credential_key_key UNIQUE (credential_key);

ALTER TABLE ONLY factory.project_repository_intent
    ADD CONSTRAINT project_repository_intent_pkey PRIMARY KEY (command_id);

ALTER TABLE ONLY factory.project_repository_intent
    ADD CONSTRAINT project_repository_intent_project_id_key UNIQUE (project_id);

ALTER TABLE ONLY factory.project_repository_intent
    ADD CONSTRAINT project_repository_intent_setup_id_key UNIQUE (setup_id);

ALTER TABLE ONLY factory.project_repository_intent
    ADD CONSTRAINT project_repository_intent_slug_key UNIQUE (slug);

ALTER TABLE ONLY factory.project_setup_confirmation
    ADD CONSTRAINT project_setup_confirmation_pkey PRIMARY KEY (inspection_id);

ALTER TABLE ONLY factory.project_setup_draft
    ADD CONSTRAINT project_setup_draft_command_id_key UNIQUE (command_id);

ALTER TABLE ONLY factory.project_setup_draft
    ADD CONSTRAINT project_setup_draft_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.project_setup_draft
    ADD CONSTRAINT project_setup_draft_user_id_key UNIQUE (user_id);

ALTER TABLE ONLY factory.project_setup_inspection
    ADD CONSTRAINT project_setup_inspection_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.project_setup_readiness
    ADD CONSTRAINT project_setup_readiness_command_id_key UNIQUE (command_id);

ALTER TABLE ONLY factory.project_setup_readiness
    ADD CONSTRAINT project_setup_readiness_pkey PRIMARY KEY (project_id, task);

ALTER TABLE ONLY factory.project_skill_settings
    ADD CONSTRAINT project_skill_settings_pkey PRIMARY KEY (project_id);

ALTER TABLE ONLY factory.project
    ADD CONSTRAINT project_slug_key UNIQUE (slug);

ALTER TABLE ONLY factory.promotion_operation
    ADD CONSTRAINT promotion_operation_change_id_key UNIQUE (change_id);

ALTER TABLE ONLY factory.promotion_operation
    ADD CONSTRAINT promotion_operation_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.promotion_operation
    ADD CONSTRAINT promotion_operation_replacement_runtime_attempt_id_key UNIQUE (replacement_runtime_attempt_id);

ALTER TABLE ONLY factory.pull_request_operation
    ADD CONSTRAINT pull_request_operation_change_id_key UNIQUE (change_id);

ALTER TABLE ONLY factory.pull_request_operation
    ADD CONSTRAINT pull_request_operation_idempotency_key_key UNIQUE (idempotency_key);

ALTER TABLE ONLY factory.pull_request_operation
    ADD CONSTRAINT pull_request_operation_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.release_access
    ADD CONSTRAINT release_access_command_id_key UNIQUE (command_id);

ALTER TABLE ONLY factory.release_access
    ADD CONSTRAINT release_access_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.release_access
    ADD CONSTRAINT release_access_username_key UNIQUE (username);

ALTER TABLE ONLY factory.release_attempt
    ADD CONSTRAINT release_attempt_command_id_key UNIQUE (command_id);

ALTER TABLE ONLY factory.release_attempt
    ADD CONSTRAINT release_attempt_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.release_attempt
    ADD CONSTRAINT release_attempt_release_id_ordinal_key UNIQUE (release_id, ordinal);

ALTER TABLE ONLY factory.requirement_approval
    ADD CONSTRAINT requirement_approval_id_ticket_id_key UNIQUE (id, ticket_id);

ALTER TABLE ONLY factory.requirement_approval
    ADD CONSTRAINT requirement_approval_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.requirement_approval
    ADD CONSTRAINT requirement_approval_requirement_revision_id_key UNIQUE (requirement_revision_id);

ALTER TABLE ONLY factory.requirement_approval
    ADD CONSTRAINT requirement_approval_ticket_id_key UNIQUE (ticket_id);

ALTER TABLE ONLY factory.requirement_revision
    ADD CONSTRAINT requirement_revision_id_ticket_id_key UNIQUE (id, ticket_id);

ALTER TABLE ONLY factory.requirement_revision
    ADD CONSTRAINT requirement_revision_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.requirement_revision
    ADD CONSTRAINT requirement_revision_ticket_id_ordinal_key UNIQUE (ticket_id, ordinal);

ALTER TABLE ONLY factory.requirements_entry_intent
    ADD CONSTRAINT requirements_entry_intent_command_id_key UNIQUE (command_id);

ALTER TABLE ONLY factory.requirements_entry_intent
    ADD CONSTRAINT requirements_entry_intent_pkey PRIMARY KEY (ticket_id);

ALTER TABLE ONLY factory.review_feedback_command
    ADD CONSTRAINT review_feedback_command_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.review_feedback_command
    ADD CONSTRAINT review_feedback_command_turn_id_key UNIQUE (turn_id);

ALTER TABLE ONLY factory.review_feedback_message
    ADD CONSTRAINT review_feedback_message_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.review_feedback
    ADD CONSTRAINT review_feedback_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.review_media
    ADD CONSTRAINT review_media_browser_session_id_kind_key UNIQUE (browser_session_id, kind);

ALTER TABLE ONLY factory.review_media
    ADD CONSTRAINT review_media_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.review_scenario
    ADD CONSTRAINT review_scenario_pkey PRIMARY KEY (review_id, id);

ALTER TABLE ONLY factory.runtime_artifact_intent
    ADD CONSTRAINT runtime_artifact_intent_pkey PRIMARY KEY (runtime_attempt_id);

ALTER TABLE ONLY factory.runtime_attempt
    ADD CONSTRAINT runtime_attempt_id_change_id_key UNIQUE (id, change_id);

ALTER TABLE ONLY factory.runtime_attempt
    ADD CONSTRAINT runtime_attempt_id_project_id_key UNIQUE (id, project_id);

ALTER TABLE ONLY factory.runtime_attempt
    ADD CONSTRAINT runtime_attempt_id_workspace_id_key UNIQUE (id, workspace_id);

ALTER TABLE ONLY factory.runtime_attempt
    ADD CONSTRAINT runtime_attempt_kubernetes_namespace_kubernetes_pod_name_key UNIQUE (kubernetes_namespace, kubernetes_pod_name);

ALTER TABLE ONLY factory.runtime_attempt
    ADD CONSTRAINT runtime_attempt_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.runtime_attempt
    ADD CONSTRAINT runtime_attempt_verification_identity_unique UNIQUE (id, verification_id);

ALTER TABLE ONLY factory.runtime_compute_wait
    ADD CONSTRAINT runtime_compute_wait_pkey PRIMARY KEY (attempt_id);

ALTER TABLE ONLY factory.runtime_environment_intent
    ADD CONSTRAINT runtime_environment_intent_pkey PRIMARY KEY (runtime_attempt_id);

ALTER TABLE ONLY factory.schema_migration
    ADD CONSTRAINT schema_migration_pkey PRIMARY KEY (version);

ALTER TABLE ONLY factory.skill_library_choice
    ADD CONSTRAINT skill_library_choice_pkey PRIMARY KEY (library_id, scope, context_id, user_id, role);

ALTER TABLE ONLY factory.skill_library
    ADD CONSTRAINT skill_library_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.skill_library_revision
    ADD CONSTRAINT skill_library_revision_pkey PRIMARY KEY (revision_id);

ALTER TABLE ONLY factory.skill_library
    ADD CONSTRAINT skill_library_storage_key_key UNIQUE (storage_key);

ALTER TABLE ONLY factory.skill_publication
    ADD CONSTRAINT skill_publication_pkey PRIMARY KEY (revision_id);

ALTER TABLE ONLY factory.skill_revision
    ADD CONSTRAINT skill_revision_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.skill_revision
    ADD CONSTRAINT skill_revision_skill_key_revision_key UNIQUE (skill_key, revision);

ALTER TABLE ONLY factory.skill_share_proposal
    ADD CONSTRAINT skill_share_proposal_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.staging_preview
    ADD CONSTRAINT staging_preview_pkey PRIMARY KEY (project_id);

ALTER TABLE ONLY factory.staging_preview
    ADD CONSTRAINT staging_preview_runtime_attempt_id_key UNIQUE (runtime_attempt_id);

ALTER TABLE ONLY factory.system_skill_settings
    ADD CONSTRAINT system_skill_settings_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY factory.ticket_conversation
    ADD CONSTRAINT ticket_conversation_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.ticket_dependency
    ADD CONSTRAINT ticket_dependency_pkey PRIMARY KEY (project_id, ticket_id, prerequisite_id);

ALTER TABLE ONLY factory.ticket_document_revision
    ADD CONSTRAINT ticket_document_revision_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.ticket_document_revision
    ADD CONSTRAINT ticket_document_revision_proposal_entry_id_key UNIQUE (proposal_entry_id);

ALTER TABLE ONLY factory.ticket_document_revision
    ADD CONSTRAINT ticket_document_revision_ticket_id_ordinal_key UNIQUE (ticket_id, ordinal);

ALTER TABLE ONLY factory.ticket_follow_up
    ADD CONSTRAINT ticket_follow_up_pkey PRIMARY KEY (ticket_id);

ALTER TABLE ONLY factory.ticket
    ADD CONSTRAINT ticket_id_project_id_key UNIQUE (id, project_id);

ALTER TABLE ONLY factory.ticket
    ADD CONSTRAINT ticket_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.usage_entry
    ADD CONSTRAINT usage_entry_pkey PRIMARY KEY (operation_id, event_id);

ALTER TABLE ONLY factory.usage_operation
    ADD CONSTRAINT usage_operation_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.usage_rate_override
    ADD CONSTRAINT usage_rate_override_pkey PRIMARY KEY (provider, model);

ALTER TABLE ONLY factory.usage_replay_cursor
    ADD CONSTRAINT usage_replay_cursor_pkey PRIMARY KEY (operation_id, session_id);

ALTER TABLE ONLY factory.user_ui_preference
    ADD CONSTRAINT user_ui_preference_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY factory.verification
    ADD CONSTRAINT verification_change_id_commit_sha_key UNIQUE (change_id, commit_sha);

ALTER TABLE ONLY factory.verification
    ADD CONSTRAINT verification_id_change_id_commit_sha_key UNIQUE (id, change_id, commit_sha);

ALTER TABLE ONLY factory.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);

ALTER TABLE ONLY factory.verification
    ADD CONSTRAINT verification_runtime_attempt_id_key UNIQUE (runtime_attempt_id);

ALTER TABLE ONLY factory.wiki_source_update
    ADD CONSTRAINT wiki_source_update_pkey PRIMARY KEY (project_id);

ALTER TABLE ONLY factory.workspace_source
    ADD CONSTRAINT workspace_source_pkey PRIMARY KEY (workspace_id);

CREATE INDEX auth_account_user_idx ON auth.account USING btree (user_id);

CREATE INDEX auth_session_user_idx ON auth.session USING btree (user_id);

CREATE INDEX auth_verification_identifier_idx ON auth.verification USING btree (identifier);

CREATE INDEX "oauthAccessToken_authorizationCodeId_idx" ON auth."oauthAccessToken" USING btree ("authorizationCodeId");

CREATE INDEX "oauthAccessToken_clientId_idx" ON auth."oauthAccessToken" USING btree ("clientId");

CREATE INDEX "oauthAccessToken_refreshId_idx" ON auth."oauthAccessToken" USING btree ("refreshId");

CREATE INDEX "oauthAccessToken_sessionId_idx" ON auth."oauthAccessToken" USING btree ("sessionId");

CREATE INDEX "oauthAccessToken_userId_idx" ON auth."oauthAccessToken" USING btree ("userId");

CREATE INDEX "oauthClientResource_clientId_idx" ON auth."oauthClientResource" USING btree ("clientId");

CREATE UNIQUE INDEX "oauthClientResource_clientId_resourceId_idx" ON auth."oauthClientResource" USING btree ("clientId", "resourceId");

CREATE INDEX "oauthClientResource_resourceId_idx" ON auth."oauthClientResource" USING btree ("resourceId");

CREATE INDEX "oauthClient_userId_idx" ON auth."oauthClient" USING btree ("userId");

CREATE INDEX "oauthConsent_clientId_idx" ON auth."oauthConsent" USING btree ("clientId");

CREATE INDEX "oauthConsent_userId_idx" ON auth."oauthConsent" USING btree ("userId");

CREATE INDEX "oauthRefreshToken_authorizationCodeId_idx" ON auth."oauthRefreshToken" USING btree ("authorizationCodeId");

CREATE INDEX "oauthRefreshToken_clientId_idx" ON auth."oauthRefreshToken" USING btree ("clientId");

CREATE INDEX "oauthRefreshToken_sessionId_idx" ON auth."oauthRefreshToken" USING btree ("sessionId");

CREATE INDEX "oauthRefreshToken_userId_idx" ON auth."oauthRefreshToken" USING btree ("userId");

CREATE INDEX "scimConnectionBinding_connectionId_idx" ON auth."scimConnectionBinding" USING btree ("connectionId");

CREATE INDEX "scimGroupMember_connectionId_idx" ON auth."scimGroupMember" USING btree ("connectionId");

CREATE INDEX "scimGroupMember_groupId_idx" ON auth."scimGroupMember" USING btree ("groupId");

CREATE INDEX "scimGroupMember_scimUserId_idx" ON auth."scimGroupMember" USING btree ("scimUserId");

CREATE INDEX "scimGroup_connectionId_idx" ON auth."scimGroup" USING btree ("connectionId");

CREATE INDEX "scimGroup_provisioningDomainId_idx" ON auth."scimGroup" USING btree ("provisioningDomainId");

CREATE INDEX "scimIdentityTombstone_connectionId_idx" ON auth."scimIdentityTombstone" USING btree ("connectionId");

CREATE INDEX "scimIdentityTombstone_provisioningDomainId_idx" ON auth."scimIdentityTombstone" USING btree ("provisioningDomainId");

CREATE INDEX "scimIdentityTombstone_userId_idx" ON auth."scimIdentityTombstone" USING btree ("userId");

CREATE INDEX "scimProjectionGrant_connectionId_idx" ON auth."scimProjectionGrant" USING btree ("connectionId");

CREATE INDEX "scimProjectionGrant_provisioningDomainId_idx" ON auth."scimProjectionGrant" USING btree ("provisioningDomainId");

CREATE INDEX "scimProjectionGrant_scimUserId_idx" ON auth."scimProjectionGrant" USING btree ("scimUserId");

CREATE INDEX "scimProjectionGrant_userId_idx" ON auth."scimProjectionGrant" USING btree ("userId");

CREATE INDEX "scimSubject_profileSourceId_idx" ON auth."scimSubject" USING btree ("profileSourceId");

CREATE INDEX "scimUser_connectionId_idx" ON auth."scimUser" USING btree ("connectionId");

CREATE INDEX "scimUser_provisioningDomainId_idx" ON auth."scimUser" USING btree ("provisioningDomainId");

CREATE INDEX "scimUser_userId_idx" ON auth."scimUser" USING btree ("userId");

CREATE UNIQUE INDEX agent_turn_active_boundary_uidx ON factory.agent_turn USING btree (project_id, (
CASE
    WHEN ((change_id IS NULL) AND ((input ->> 'contextId'::text) IS NOT NULL)) THEN ('context:'::text || (input ->> 'contextId'::text))
    ELSE COALESCE((ticket_id)::text, ('draft:'::text || (created_by)::text))
END)) WHERE (state = ANY (ARRAY['pending'::factory.agent_turn_state, 'dispatching'::factory.agent_turn_state, 'running'::factory.agent_turn_state]));

CREATE INDEX agent_turn_recovery_idx ON factory.agent_turn USING btree (state, owner_expires_at) WHERE (state = ANY (ARRAY['pending'::factory.agent_turn_state, 'dispatching'::factory.agent_turn_state, 'running'::factory.agent_turn_state, 'uncertain'::factory.agent_turn_state]));

CREATE UNIQUE INDEX agent_turn_unresolved_change_boundary_uidx ON factory.agent_turn USING btree (project_id, ticket_id) WHERE ((change_id IS NOT NULL) AND (state = ANY (ARRAY['pending'::factory.agent_turn_state, 'dispatching'::factory.agent_turn_state, 'running'::factory.agent_turn_state, 'uncertain'::factory.agent_turn_state])));

CREATE INDEX attachment_project_storage ON factory.attachment USING btree (project_id, state);

CREATE INDEX attachment_reference_target ON factory.attachment_reference USING btree (kind, reference_id);

CREATE INDEX branch_create_operation_due_idx ON factory.branch_create_operation USING btree (state, reconcile_after, lease_expires_at);

CREATE UNIQUE INDEX build_browser_one_unclosed_session ON factory.build_browser_session USING btree (turn_id, owner_id) WHERE (state <> 'closed'::text);

CREATE INDEX build_browser_session_cleanup_idx ON factory.build_browser_session USING btree (runtime_attempt_id) WHERE (state <> 'closed'::text);

CREATE INDEX candidate_review_change_idx ON factory.candidate_review USING btree (change_id);

CREATE UNIQUE INDEX change_agent_opencode_session_uidx ON factory.change_agent_session USING btree (opencode_session_id) WHERE (opencode_session_id IS NOT NULL);

CREATE UNIQUE INDEX change_commit_one_active_uidx ON factory.change_commit_operation USING btree (change_id) WHERE (state <> ALL (ARRAY['succeeded'::factory.change_commit_state, 'failed'::factory.change_commit_state]));

CREATE UNIQUE INDEX change_editing_request_pending ON factory.change_editing_request USING btree (change_id, requester_id, writer_epoch) WHERE (state = 'requested'::text);

CREATE UNIQUE INDEX change_one_active_per_ticket ON factory.change USING btree (ticket_id) WHERE (state = ANY (ARRAY['branch-pending'::factory.change_state, 'starting'::factory.change_state, 'active'::factory.change_state, 'cancelling'::factory.change_state]));

CREATE UNIQUE INDEX conversation_context_original ON factory.conversation_context USING btree (conversation_id) WHERE original;

CREATE UNIQUE INDEX conversation_entry_question_answer_uidx ON factory.conversation_entry USING btree (in_reply_to_entry_id) WHERE ((kind = 'answer'::factory.conversation_entry_kind) AND (in_reply_to_entry_id IS NOT NULL));

CREATE UNIQUE INDEX conversation_entry_requirement_uidx ON factory.conversation_entry USING btree (requirement_revision_id) WHERE (requirement_revision_id IS NOT NULL);

CREATE UNIQUE INDEX development_workspace_one_per_ticket ON factory.development_workspace USING btree (ticket_id) WHERE (kind = 'ticket'::factory.development_workspace_kind);

CREATE UNIQUE INDEX development_workspace_one_personal_per_user_project ON factory.development_workspace USING btree (project_id, owner_user_id) WHERE (kind = 'personal'::factory.development_workspace_kind);

CREATE UNIQUE INDEX environment_one_pending ON factory.environment_write USING btree (project_id, environment) WHERE (state = 'write-intended'::text);

CREATE INDEX epic_project_parent_idx ON factory.epic USING btree (project_id, parent_id);

CREATE INDEX epic_research_idx ON factory.epic USING gin (factory.research_vector(title, description));

CREATE INDEX epic_title_trgm_idx ON factory.epic USING gin (lower(title) factory.gin_trgm_ops);

CREATE INDEX execution_slot_due ON factory.execution_slot USING btree (state, reconcile_after);

CREATE UNIQUE INDEX knowledge_generation_one_active_per_project ON factory.knowledge_generation USING btree (project_id) WHERE (state = ANY (ARRAY['pending'::factory.knowledge_generation_state, 'running'::factory.knowledge_generation_state]));

CREATE INDEX knowledge_page_parent_order ON factory.knowledge_page USING btree (project_id, parent_id, sort_order, id);

CREATE INDEX knowledge_page_search_idx ON factory.knowledge_page USING gin (to_tsvector('simple'::regconfig, ((title || ' '::text) || current_body)));

CREATE INDEX knowledge_research_idx ON factory.knowledge_page USING gin (factory.research_vector(title, current_body));

CREATE INDEX knowledge_title_trgm_idx ON factory.knowledge_page USING gin (lower(title) factory.gin_trgm_ops);

CREATE UNIQUE INDEX mcp_connect_running ON factory.mcp_connect_intent USING btree (connection_id) WHERE (state = 'running'::text);

CREATE UNIQUE INDEX mcp_refresh_pending ON factory.mcp_token_refresh USING btree (connection_id) WHERE (state = 'intended'::text);

CREATE UNIQUE INDEX mcp_secret_pending ON factory.mcp_secret_write USING btree (connection_id) WHERE (state = 'intended'::text);

CREATE UNIQUE INDEX model_connection_pending ON factory.model_connection_write USING btree (connection_id) WHERE (state = 'write-intended'::text);

CREATE INDEX monitoring_pending ON factory.monitoring_incident USING btree (project_id, received_at, id) WHERE (state = ANY (ARRAY['queued'::text, 'diagnosing'::text, 'implementing'::text]));

CREATE UNIQUE INDEX monitoring_ticket ON factory.monitoring_incident USING btree (ticket_id) WHERE (ticket_id IS NOT NULL);

CREATE INDEX project_membership_user_idx ON factory.project_membership USING btree (user_id, project_id);

CREATE UNIQUE INDEX project_release_one_active ON factory.project_release USING btree (project_id) WHERE ((state = ANY (ARRAY['pending'::text, 'dispatching'::text, 'running'::text, 'checking'::text, 'publishing'::text, 'uncertain'::text])) AND (ended_at IS NULL));

CREATE UNIQUE INDEX project_setup_one_inspection ON factory.project_setup_inspection USING btree (project_id) WHERE (state = ANY (ARRAY['inspecting'::text, 'proposal'::text, 'confirming'::text]));

CREATE UNIQUE INDEX release_access_publish_attempt ON factory.release_access USING btree (release_id) WHERE ((scope = 'publish'::text) AND (state = ANY (ARRAY['pending'::text, 'active'::text, 'uncertain'::text])));

CREATE INDEX requirement_research_idx ON factory.requirement_revision USING gin (factory.research_vector(''::text, canonical_content));

CREATE INDEX review_feedback_delivery ON factory.review_feedback USING btree (change_id) WHERE ((kind = 'thread'::text) AND (state <> 'resolved'::text));

CREATE INDEX review_media_retention ON factory.review_media USING btree (change_id, kind, state);

CREATE INDEX runtime_attempt_active_isolated_idx ON factory.runtime_attempt USING btree (project_id, isolated_kind, state) WHERE ((isolated_kind IS NOT NULL) AND (state = ANY (ARRAY['create-intended'::factory.runtime_attempt_state, 'starting'::factory.runtime_attempt_state, 'ready'::factory.runtime_attempt_state, 'stop-intended'::factory.runtime_attempt_state, 'stopping'::factory.runtime_attempt_state, 'cleanup-failed'::factory.runtime_attempt_state])));

CREATE UNIQUE INDEX runtime_attempt_change_generation_uidx ON factory.runtime_attempt USING btree (change_id, generation) WHERE (change_id IS NOT NULL);

CREATE UNIQUE INDEX runtime_attempt_one_active_per_change ON factory.runtime_attempt USING btree (change_id) WHERE ((change_id IS NOT NULL) AND (state <> ALL (ARRAY['stopped'::factory.runtime_attempt_state, 'failed'::factory.runtime_attempt_state])));

CREATE UNIQUE INDEX runtime_attempt_one_active_per_workspace ON factory.runtime_attempt USING btree (workspace_id) WHERE ((workspace_id IS NOT NULL) AND (state <> ALL (ARRAY['stopped'::factory.runtime_attempt_state, 'failed'::factory.runtime_attempt_state])));

CREATE UNIQUE INDEX runtime_attempt_project_generation_uidx ON factory.runtime_attempt USING btree (project_id, generation) WHERE ((change_id IS NULL) AND (workspace_id IS NULL));

CREATE UNIQUE INDEX runtime_attempt_workspace_generation_uidx ON factory.runtime_attempt USING btree (workspace_id, generation) WHERE (workspace_id IS NOT NULL);

CREATE UNIQUE INDEX ticket_conversation_project_draft_uidx ON factory.ticket_conversation USING btree (project_id, created_by) WHERE (ticket_id IS NULL);

CREATE UNIQUE INDEX ticket_conversation_ticket_uidx ON factory.ticket_conversation USING btree (ticket_id) WHERE (ticket_id IS NOT NULL);

CREATE INDEX ticket_dependency_prerequisite_idx ON factory.ticket_dependency USING btree (project_id, prerequisite_id);

CREATE INDEX ticket_document_research_idx ON factory.ticket_document_revision USING gin (factory.research_vector(title, canonical_content));

CREATE INDEX ticket_epic_idx ON factory.ticket USING btree (project_id, epic_id);

CREATE INDEX ticket_project_updated_idx ON factory.ticket USING btree (project_id, updated_at DESC, id DESC);

CREATE INDEX ticket_research_idx ON factory.ticket USING gin (factory.research_vector(title, description));

CREATE INDEX ticket_title_trgm_idx ON factory.ticket USING gin (lower(title) factory.gin_trgm_ops);

CREATE INDEX usage_entry_time_idx ON factory.usage_entry USING btree (occurred_at);

CREATE INDEX usage_operation_scope_time_idx ON factory.usage_operation USING btree (project_id, created_at);

CREATE UNIQUE INDEX verification_one_active_per_change ON factory.verification USING btree (change_id) WHERE (state = ANY (ARRAY['pending'::factory.verification_state, 'runner-starting'::factory.verification_state, 'running'::factory.verification_state]));

CREATE TRIGGER check_session_access BEFORE INSERT OR UPDATE ON auth.session FOR EACH ROW EXECUTE FUNCTION factory.check_session_access();

CREATE TRIGGER initialize_account_access AFTER INSERT ON auth."user" FOR EACH ROW EXECUTE FUNCTION factory.initialize_account_access();

CREATE TRIGGER agent_turn_guard BEFORE INSERT OR UPDATE ON factory.agent_turn FOR EACH ROW EXECUTE FUNCTION factory.guard_agent_turn();

CREATE TRIGGER agent_turn_mcp_immutable BEFORE DELETE OR UPDATE ON factory.agent_turn_mcp FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER agent_turn_skill_guard BEFORE INSERT OR DELETE OR UPDATE ON factory.agent_turn_skill FOR EACH ROW EXECUTE FUNCTION factory.guard_loaded_skill();

CREATE TRIGGER agent_untrashed_ticket BEFORE INSERT ON factory.agent_turn FOR EACH ROW EXECUTE FUNCTION factory.require_untrashed_ticket();

CREATE TRIGGER attachment_identity BEFORE UPDATE ON factory.attachment FOR EACH ROW EXECUTE FUNCTION factory.protect_attachment_identity();

CREATE TRIGGER attachment_reference_immutable BEFORE DELETE OR UPDATE ON factory.attachment_reference FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER attachment_storage_immutable BEFORE DELETE OR UPDATE ON factory.attachment_storage FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER attachment_turn_context_immutable BEFORE DELETE OR UPDATE ON factory.attachment_turn_context FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER branch_operation_immutable BEFORE UPDATE ON factory.branch_create_operation FOR EACH ROW EXECUTE FUNCTION factory.protect_branch_operation();

CREATE TRIGGER build_browser_ordinal_guard BEFORE INSERT OR UPDATE ON factory.build_browser_session FOR EACH ROW EXECUTE FUNCTION factory.guard_build_browser_ordinal();

CREATE TRIGGER build_browser_session_guard BEFORE INSERT OR UPDATE ON factory.build_browser_session FOR EACH ROW EXECUTE FUNCTION factory.guard_build_browser_session();

CREATE TRIGGER candidate_review_guard BEFORE UPDATE ON factory.candidate_review FOR EACH ROW EXECUTE FUNCTION factory.guard_candidate_review();

CREATE TRIGGER change_agent_turn_intent_guard BEFORE INSERT OR UPDATE ON factory.change_agent_turn_intent FOR EACH ROW EXECUTE FUNCTION factory.guard_change_agent_turn_intent();

CREATE TRIGGER change_editing_decision_immutable BEFORE DELETE OR UPDATE ON factory.change_editing_decision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER change_identity_immutable BEFORE UPDATE ON factory.change FOR EACH ROW EXECUTE FUNCTION factory.protect_change_identity();

CREATE TRIGGER change_prerequisites_guard BEFORE INSERT ON factory.change FOR EACH ROW EXECUTE FUNCTION factory.guard_change_prerequisites();

CREATE TRIGGER conversation_attachments AFTER INSERT ON factory.conversation_entry FOR EACH ROW EXECUTE FUNCTION factory.bind_authored_attachments();

CREATE TRIGGER conversation_context_identity BEFORE UPDATE ON factory.conversation_context FOR EACH ROW EXECUTE FUNCTION factory.guard_conversation_context();

CREATE TRIGGER conversation_entry_no_update BEFORE DELETE OR UPDATE ON factory.conversation_entry FOR EACH ROW EXECUTE FUNCTION factory.prevent_conversation_entry_mutation();

CREATE TRIGGER delivery_approval_immutable BEFORE DELETE OR UPDATE ON factory.delivery_approval FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER developer_ide_intent_immutable BEFORE UPDATE ON factory.developer_ide FOR EACH ROW EXECUTE FUNCTION factory.protect_developer_ide_intent();

CREATE TRIGGER development_workspace_identity_immutable BEFORE UPDATE ON factory.development_workspace FOR EACH ROW EXECUTE FUNCTION factory.protect_development_workspace_identity();

CREATE TRIGGER enqueue_account_revocation AFTER UPDATE ON factory.account_access FOR EACH ROW EXECUTE FUNCTION factory.enqueue_access_revocation();

CREATE TRIGGER enqueue_membership_revocation AFTER INSERT OR DELETE OR UPDATE ON factory.project_membership FOR EACH ROW EXECUTE FUNCTION factory.enqueue_access_revocation();

CREATE TRIGGER enqueue_project_access AFTER INSERT ON factory.project FOR EACH ROW EXECUTE FUNCTION factory.enqueue_project_access();

CREATE TRIGGER epic_confirmation_immutable BEFORE DELETE OR UPDATE ON factory.epic_confirmation FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER epic_hierarchy_guard BEFORE INSERT OR UPDATE ON factory.epic FOR EACH ROW EXECUTE FUNCTION factory.guard_epic_hierarchy();

CREATE TRIGGER execution_policy_command_immutable BEFORE UPDATE ON factory.execution_policy_command FOR EACH ROW EXECUTE FUNCTION factory.guard_usage_entry();

CREATE CONSTRAINT TRIGGER execution_slot_assignment AFTER INSERT OR UPDATE ON factory.execution_slot DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.validate_execution_slot_assignment();

CREATE TRIGGER execution_slot_identity BEFORE INSERT OR UPDATE ON factory.execution_slot FOR EACH ROW EXECUTE FUNCTION factory.protect_execution_slot();

CREATE TRIGGER factorybox_operation_identity BEFORE UPDATE ON factory.factorybox_lifecycle_operation FOR EACH ROW EXECUTE FUNCTION factory.protect_factorybox_operation();

CREATE TRIGGER factorybox_runtime_identity BEFORE INSERT OR UPDATE ON factory.factorybox_runtime FOR EACH ROW EXECUTE FUNCTION factory.protect_factorybox_runtime();

CREATE TRIGGER factorybox_slot_identity BEFORE UPDATE ON factory.execution_slot FOR EACH ROW EXECUTE FUNCTION factory.protect_factorybox_slot();

CREATE TRIGGER feedback_attachments AFTER INSERT ON factory.review_feedback_message FOR EACH ROW EXECUTE FUNCTION factory.bind_authored_attachments();

CREATE TRIGGER guard_usage_entry BEFORE UPDATE ON factory.usage_entry FOR EACH ROW EXECUTE FUNCTION factory.guard_usage_entry();

CREATE TRIGGER guard_usage_operation BEFORE UPDATE ON factory.usage_operation FOR EACH ROW EXECUTE FUNCTION factory.guard_usage_operation();

CREATE TRIGGER initialize_change_writer AFTER INSERT ON factory.change FOR EACH ROW EXECUTE FUNCTION factory.initialize_change_writer();

CREATE TRIGGER installation_admission BEFORE INSERT ON factory.agent_turn FOR EACH ROW EXECUTE FUNCTION factory.require_installation_admission();

CREATE TRIGGER installation_admission BEFORE INSERT ON factory.knowledge_generation FOR EACH ROW EXECUTE FUNCTION factory.require_installation_admission();

CREATE TRIGGER installation_admission BEFORE INSERT ON factory.model_role_probe FOR EACH ROW EXECUTE FUNCTION factory.require_installation_admission();

CREATE TRIGGER installation_admission BEFORE INSERT ON factory.project_setup_inspection FOR EACH ROW EXECUTE FUNCTION factory.require_installation_admission();

CREATE TRIGGER knowledge_attachments AFTER INSERT ON factory.knowledge_revision FOR EACH ROW EXECUTE FUNCTION factory.bind_authored_attachments();

CREATE TRIGGER knowledge_hierarchy_guard BEFORE INSERT OR UPDATE OF id, project_id, parent_id ON factory.knowledge_page FOR EACH ROW EXECUTE FUNCTION factory.guard_knowledge_hierarchy();

CREATE TRIGGER knowledge_revision_immutable BEFORE DELETE OR UPDATE ON factory.knowledge_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER mcp_access_decision_immutable BEFORE DELETE OR UPDATE ON factory.mcp_access_decision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER mcp_library_identity_immutable BEFORE DELETE OR UPDATE ON factory.mcp_library FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER mcp_observation_immutable BEFORE DELETE OR UPDATE ON factory.mcp_observation FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER mcp_policy_approval_immutable BEFORE DELETE OR UPDATE ON factory.mcp_policy_approval FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER mcp_revision_immutable BEFORE DELETE OR UPDATE ON factory.mcp_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER model_connection_version_immutable BEFORE INSERT OR DELETE OR UPDATE ON factory.model_connection_version FOR EACH ROW EXECUTE FUNCTION factory.protect_model_connection_version();

CREATE TRIGGER model_connection_write_guard BEFORE DELETE OR UPDATE ON factory.model_connection_write FOR EACH ROW EXECUTE FUNCTION factory.protect_model_connection_write();

CREATE TRIGGER model_role_probe_guard BEFORE DELETE OR UPDATE ON factory.model_role_probe FOR EACH ROW EXECUTE FUNCTION factory.protect_model_role_probe();

CREATE TRIGGER monitoring_command_immutable BEFORE DELETE OR UPDATE ON factory.monitoring_command FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER monitoring_evidence_immutable BEFORE DELETE OR UPDATE ON factory.monitoring_evidence FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER monitoring_policy_immutable BEFORE DELETE OR UPDATE ON factory.monitoring_policy FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER native_skill_intent_guard BEFORE INSERT OR UPDATE ON factory.change_agent_turn_intent FOR EACH ROW EXECUTE FUNCTION factory.guard_native_skill_intent();

CREATE TRIGGER project_background_assignment BEFORE INSERT ON factory.project FOR EACH ROW EXECUTE FUNCTION factory.assign_project_background();

CREATE TRIGGER project_image_preparation_immutable BEFORE UPDATE ON factory.project_image_preparation FOR EACH ROW EXECUTE FUNCTION factory.protect_project_image_preparation();

CREATE TRIGGER project_release_identity BEFORE UPDATE ON factory.project_release FOR EACH ROW EXECUTE FUNCTION factory.protect_project_release_identity();

CREATE TRIGGER project_repository_intent_guard BEFORE UPDATE ON factory.project_repository_intent FOR EACH ROW EXECUTE FUNCTION factory.guard_project_repository_intent();

CREATE TRIGGER pull_request_operation_immutable BEFORE UPDATE ON factory.pull_request_operation FOR EACH ROW EXECUTE FUNCTION factory.protect_pull_request_operation();

CREATE TRIGGER release_attempt_identity BEFORE UPDATE ON factory.release_attempt FOR EACH ROW EXECUTE FUNCTION factory.protect_release_attempt_identity();

CREATE TRIGGER requirement_approval_immutable BEFORE DELETE OR UPDATE ON factory.requirement_approval FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER requirement_attachments AFTER INSERT ON factory.requirement_revision FOR EACH ROW EXECUTE FUNCTION factory.bind_authored_attachments();

CREATE TRIGGER requirement_revision_immutable BEFORE DELETE OR UPDATE ON factory.requirement_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER review_media_guard BEFORE UPDATE ON factory.review_media FOR EACH ROW EXECUTE FUNCTION factory.guard_review_media();

CREATE TRIGGER review_scenario_guard BEFORE INSERT OR UPDATE ON factory.review_scenario FOR EACH ROW EXECUTE FUNCTION factory.guard_review_scenario();

CREATE TRIGGER runtime_artifact_intent_immutable BEFORE INSERT OR UPDATE ON factory.runtime_artifact_intent FOR EACH ROW EXECUTE FUNCTION factory.protect_runtime_artifact_intent();

CREATE TRIGGER runtime_attempt_identity_immutable BEFORE UPDATE ON factory.runtime_attempt FOR EACH ROW EXECUTE FUNCTION factory.protect_runtime_attempt_identity();

CREATE TRIGGER runtime_environment_intent_immutable BEFORE INSERT OR UPDATE ON factory.runtime_environment_intent FOR EACH ROW EXECUTE FUNCTION factory.protect_runtime_environment_intent();

CREATE TRIGGER runtime_untrashed_ticket BEFORE INSERT ON factory.runtime_attempt FOR EACH ROW EXECUTE FUNCTION factory.require_untrashed_ticket();

CREATE TRIGGER setup_confirmation_immutable BEFORE DELETE OR UPDATE ON factory.project_setup_confirmation FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER setup_inspection_guard BEFORE UPDATE ON factory.project_setup_inspection FOR EACH ROW EXECUTE FUNCTION factory.guard_setup_inspection();

CREATE TRIGGER skill_library_identity_immutable BEFORE DELETE OR UPDATE ON factory.skill_library FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER skill_library_revision_immutable BEFORE DELETE OR UPDATE ON factory.skill_library_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER skill_revision_immutable BEFORE DELETE OR UPDATE ON factory.skill_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER ticket_attachments AFTER INSERT ON factory.ticket FOR EACH ROW EXECUTE FUNCTION factory.bind_authored_attachments();

CREATE TRIGGER ticket_conversation_coding_context BEFORE INSERT OR UPDATE OF active_coding_context_id ON factory.ticket_conversation FOR EACH ROW EXECUTE FUNCTION factory.guard_active_coding_context();

CREATE TRIGGER ticket_conversation_project_guard BEFORE INSERT OR UPDATE OF project_id, ticket_id ON factory.ticket_conversation FOR EACH ROW EXECUTE FUNCTION factory.validate_ticket_conversation_project();

CREATE TRIGGER ticket_dependency_guard BEFORE INSERT OR UPDATE ON factory.ticket_dependency FOR EACH ROW EXECUTE FUNCTION factory.guard_ticket_dependency();

CREATE TRIGGER ticket_document_attachments AFTER INSERT ON factory.ticket_document_revision FOR EACH ROW EXECUTE FUNCTION factory.bind_authored_attachments();

CREATE TRIGGER ticket_document_revision_immutable BEFORE DELETE OR UPDATE ON factory.ticket_document_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER ticket_follow_up_immutable BEFORE DELETE OR UPDATE ON factory.ticket_follow_up FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER workspace_source_intent_immutable BEFORE UPDATE ON factory.workspace_source FOR EACH ROW EXECUTE FUNCTION factory.protect_workspace_source_intent();

ALTER TABLE ONLY auth.account
    ADD CONSTRAINT account_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY auth."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES auth."oauthClient"("clientId");

ALTER TABLE ONLY auth."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_refreshId_fkey" FOREIGN KEY ("refreshId") REFERENCES auth."oauthRefreshToken"(id);

ALTER TABLE ONLY auth."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES auth.session(id) ON DELETE SET NULL;

ALTER TABLE ONLY auth."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id);

ALTER TABLE ONLY auth."oauthClientResource"
    ADD CONSTRAINT "oauthClientResource_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES auth."oauthClient"("clientId") ON DELETE CASCADE;

ALTER TABLE ONLY auth."oauthClientResource"
    ADD CONSTRAINT "oauthClientResource_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES auth."oauthResource"(identifier) ON DELETE CASCADE;

ALTER TABLE ONLY auth."oauthClient"
    ADD CONSTRAINT "oauthClient_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id);

ALTER TABLE ONLY auth."oauthConsent"
    ADD CONSTRAINT "oauthConsent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES auth."oauthClient"("clientId");

ALTER TABLE ONLY auth."oauthConsent"
    ADD CONSTRAINT "oauthConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id);

ALTER TABLE ONLY auth."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES auth."oauthClient"("clientId");

ALTER TABLE ONLY auth."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES auth.session(id) ON DELETE SET NULL;

ALTER TABLE ONLY auth."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id);

ALTER TABLE ONLY auth."scimGroupMember"
    ADD CONSTRAINT "scimGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES auth."scimGroup"(id);

ALTER TABLE ONLY auth."scimGroupMember"
    ADD CONSTRAINT "scimGroupMember_scimUserId_fkey" FOREIGN KEY ("scimUserId") REFERENCES auth."scimUser"(id);

ALTER TABLE ONLY auth."scimIdentityTombstone"
    ADD CONSTRAINT "scimIdentityTombstone_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id);

ALTER TABLE ONLY auth."scimProjectionGrant"
    ADD CONSTRAINT "scimProjectionGrant_scimUserId_fkey" FOREIGN KEY ("scimUserId") REFERENCES auth."scimUser"(id);

ALTER TABLE ONLY auth."scimProjectionGrant"
    ADD CONSTRAINT "scimProjectionGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id);

ALTER TABLE ONLY auth."scimSubject"
    ADD CONSTRAINT "scimSubject_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id);

ALTER TABLE ONLY auth."scimUser"
    ADD CONSTRAINT "scimUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id);

ALTER TABLE ONLY auth.session
    ADD CONSTRAINT session_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY auth."ssoProvider"
    ADD CONSTRAINT "ssoProvider_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.access_revocation
    ADD CONSTRAINT access_revocation_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.account_access
    ADD CONSTRAINT account_access_disabled_by_fkey FOREIGN KEY (disabled_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.account_access
    ADD CONSTRAINT account_access_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.administrator
    ADD CONSTRAINT administrator_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.agent_turn
    ADD CONSTRAINT agent_turn_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.agent_turn
    ADD CONSTRAINT agent_turn_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES factory.ticket_conversation(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.agent_turn
    ADD CONSTRAINT agent_turn_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.agent_turn_mcp
    ADD CONSTRAINT agent_turn_mcp_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES factory.mcp_connection(id);

ALTER TABLE ONLY factory.agent_turn_mcp
    ADD CONSTRAINT agent_turn_mcp_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES factory.mcp_revision(id);

ALTER TABLE ONLY factory.agent_turn_mcp
    ADD CONSTRAINT agent_turn_mcp_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES factory.agent_turn(id);

ALTER TABLE ONLY factory.agent_turn
    ADD CONSTRAINT agent_turn_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.agent_turn_skill
    ADD CONSTRAINT agent_turn_skill_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES factory.skill_revision(id);

ALTER TABLE ONLY factory.agent_turn_skill
    ADD CONSTRAINT agent_turn_skill_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES factory.agent_turn(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.agent_turn
    ADD CONSTRAINT agent_turn_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES factory.ticket(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.attachment_draft
    ADD CONSTRAINT attachment_draft_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.attachment_draft
    ADD CONSTRAINT attachment_draft_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);

ALTER TABLE ONLY factory.attachment
    ADD CONSTRAINT attachment_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.attachment
    ADD CONSTRAINT attachment_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);

ALTER TABLE ONLY factory.attachment_reference
    ADD CONSTRAINT attachment_reference_attachment_id_fkey FOREIGN KEY (attachment_id) REFERENCES factory.attachment(id);

ALTER TABLE ONLY factory.attachment_turn_context
    ADD CONSTRAINT attachment_turn_context_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES factory.agent_turn(id);

ALTER TABLE ONLY factory.branch_create_operation
    ADD CONSTRAINT branch_create_operation_change_id_branch_name_start_sha_fkey FOREIGN KEY (change_id, branch_name, start_sha) REFERENCES factory.change(id, branch_name, base_sha);

ALTER TABLE ONLY factory.branch_create_operation
    ADD CONSTRAINT branch_create_operation_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);

ALTER TABLE ONLY factory.build_browser_session
    ADD CONSTRAINT build_browser_session_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);

ALTER TABLE ONLY factory.build_browser_session
    ADD CONSTRAINT build_browser_session_runtime_attempt_id_change_id_fkey FOREIGN KEY (runtime_attempt_id, change_id) REFERENCES factory.runtime_attempt(id, change_id);

ALTER TABLE ONLY factory.build_browser_session
    ADD CONSTRAINT build_browser_session_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES factory.agent_turn(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.candidate_review
    ADD CONSTRAINT candidate_review_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);

ALTER TABLE ONLY factory.candidate_review
    ADD CONSTRAINT candidate_review_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.candidate_review
    ADD CONSTRAINT candidate_review_supersedes_id_fkey FOREIGN KEY (supersedes_id) REFERENCES factory.candidate_review(id);

ALTER TABLE ONLY factory.candidate_review
    ADD CONSTRAINT candidate_review_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES factory.agent_turn(id);

ALTER TABLE ONLY factory.candidate_review
    ADD CONSTRAINT candidate_review_verification_id_change_id_commit_sha_fkey FOREIGN KEY (verification_id, change_id, commit_sha) REFERENCES factory.verification(id, change_id, commit_sha);

ALTER TABLE ONLY factory.candidate_review
    ADD CONSTRAINT candidate_review_verification_id_fkey FOREIGN KEY (verification_id) REFERENCES factory.verification(id);

ALTER TABLE ONLY factory.change_agent_session
    ADD CONSTRAINT change_agent_session_active_turn_id_fkey FOREIGN KEY (active_turn_id) REFERENCES factory.agent_turn(id);

ALTER TABLE ONLY factory.change_agent_session
    ADD CONSTRAINT change_agent_session_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);

ALTER TABLE ONLY factory.change_agent_session
    ADD CONSTRAINT change_agent_session_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.change_agent_session
    ADD CONSTRAINT change_agent_session_runtime_attempt_id_fkey FOREIGN KEY (runtime_attempt_id) REFERENCES factory.runtime_attempt(id);

ALTER TABLE ONLY factory.change_agent_session
    ADD CONSTRAINT change_agent_session_runtime_change_fk FOREIGN KEY (runtime_attempt_id, change_id) REFERENCES factory.runtime_attempt(id, change_id);

ALTER TABLE ONLY factory.change_agent_turn_intent
    ADD CONSTRAINT change_agent_turn_intent_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);

ALTER TABLE ONLY factory.change_agent_turn_intent
    ADD CONSTRAINT change_agent_turn_intent_runtime_attempt_id_change_id_fkey FOREIGN KEY (runtime_attempt_id, change_id) REFERENCES factory.runtime_attempt(id, change_id);

ALTER TABLE ONLY factory.change_agent_turn_intent
    ADD CONSTRAINT change_agent_turn_intent_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES factory.agent_turn(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.change_commit_operation
    ADD CONSTRAINT change_commit_operation_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);

ALTER TABLE ONLY factory.change_commit_operation
    ADD CONSTRAINT change_commit_operation_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.change_commit_operation
    ADD CONSTRAINT change_commit_operation_runtime_attempt_id_fkey FOREIGN KEY (runtime_attempt_id) REFERENCES factory.runtime_attempt(id);

ALTER TABLE ONLY factory.change_commit_operation
    ADD CONSTRAINT change_commit_operation_runtime_change_fk FOREIGN KEY (runtime_attempt_id, change_id) REFERENCES factory.runtime_attempt(id, change_id);

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.change_editing_decision
    ADD CONSTRAINT change_editing_decision_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.change_editing_decision
    ADD CONSTRAINT change_editing_decision_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);

ALTER TABLE ONLY factory.change_editing_decision
    ADD CONSTRAINT change_editing_decision_request_id_fkey FOREIGN KEY (request_id) REFERENCES factory.change_editing_request(id);

ALTER TABLE ONLY factory.change_editing_decision
    ADD CONSTRAINT change_editing_decision_target_id_fkey FOREIGN KEY (target_id) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.change_editing_request
    ADD CONSTRAINT change_editing_request_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);

ALTER TABLE ONLY factory.change_editing_request
    ADD CONSTRAINT change_editing_request_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.change_editing_request
    ADD CONSTRAINT change_editing_request_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.change_editing_request
    ADD CONSTRAINT change_editing_request_requester_id_fkey FOREIGN KEY (requester_id) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_requirement_approval_id_fkey FOREIGN KEY (requirement_approval_id) REFERENCES factory.requirement_approval(id);

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_requirement_approval_id_ticket_id_fkey FOREIGN KEY (requirement_approval_id, ticket_id) REFERENCES factory.requirement_approval(id, ticket_id);

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_runtime_attempt_fk FOREIGN KEY (runtime_attempt_id, id) REFERENCES factory.runtime_attempt(id, change_id);

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES factory.ticket(id);

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_ticket_id_project_id_fkey FOREIGN KEY (ticket_id, project_id) REFERENCES factory.ticket(id, project_id);

ALTER TABLE ONLY factory.change_writer
    ADD CONSTRAINT change_writer_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.change_writer
    ADD CONSTRAINT change_writer_fence_attempt_id_fkey FOREIGN KEY (fence_attempt_id) REFERENCES factory.runtime_attempt(id);

ALTER TABLE ONLY factory.change_writer
    ADD CONSTRAINT change_writer_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.change_writer
    ADD CONSTRAINT change_writer_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.coding_pause
    ADD CONSTRAINT coding_pause_resumed_by_turn_id_fkey FOREIGN KEY (resumed_by_turn_id) REFERENCES factory.agent_turn(id);

ALTER TABLE ONLY factory.coding_pause
    ADD CONSTRAINT coding_pause_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES factory.agent_turn(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.conversation_context
    ADD CONSTRAINT conversation_context_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);

ALTER TABLE ONLY factory.conversation_context
    ADD CONSTRAINT conversation_context_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES factory.ticket_conversation(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.conversation_context
    ADD CONSTRAINT conversation_context_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.conversation_context
    ADD CONSTRAINT conversation_context_previous_context_id_fkey FOREIGN KEY (previous_context_id) REFERENCES factory.conversation_context(id);

ALTER TABLE ONLY factory.conversation_entry
    ADD CONSTRAINT conversation_entry_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES factory.ticket_conversation(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.conversation_entry
    ADD CONSTRAINT conversation_entry_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.conversation_entry
    ADD CONSTRAINT conversation_entry_in_reply_to_entry_id_fkey FOREIGN KEY (in_reply_to_entry_id) REFERENCES factory.conversation_entry(id) ON DELETE RESTRICT;

ALTER TABLE ONLY factory.conversation_entry
    ADD CONSTRAINT conversation_entry_requirement_revision_id_fkey FOREIGN KEY (requirement_revision_id) REFERENCES factory.requirement_revision(id) ON DELETE RESTRICT;

ALTER TABLE ONLY factory.delivery_approval
    ADD CONSTRAINT delivery_approval_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.delivery_approval
    ADD CONSTRAINT delivery_approval_candidate_review_identity FOREIGN KEY (candidate_review_id, change_id, verification_id, commit_sha) REFERENCES factory.candidate_review(id, change_id, verification_id, commit_sha);

ALTER TABLE ONLY factory.delivery_approval
    ADD CONSTRAINT delivery_approval_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);

ALTER TABLE ONLY factory.delivery_approval
    ADD CONSTRAINT delivery_approval_monitoring_incident_id_fkey FOREIGN KEY (monitoring_incident_id) REFERENCES factory.monitoring_incident(id);

ALTER TABLE ONLY factory.delivery_approval
    ADD CONSTRAINT delivery_approval_monitoring_policy_id_fkey FOREIGN KEY (monitoring_policy_id) REFERENCES factory.monitoring_policy(id);

ALTER TABLE ONLY factory.delivery_approval
    ADD CONSTRAINT delivery_approval_verification_id_change_id_commit_sha_fkey FOREIGN KEY (verification_id, change_id, commit_sha) REFERENCES factory.verification(id, change_id, commit_sha);

ALTER TABLE ONLY factory.developer_ide
    ADD CONSTRAINT developer_ide_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.development_workspace
    ADD CONSTRAINT development_workspace_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);

ALTER TABLE ONLY factory.development_workspace
    ADD CONSTRAINT development_workspace_change_id_project_id_fkey FOREIGN KEY (change_id, project_id) REFERENCES factory.change(id, project_id);

ALTER TABLE ONLY factory.development_workspace
    ADD CONSTRAINT development_workspace_change_id_ticket_id_fkey FOREIGN KEY (change_id, ticket_id) REFERENCES factory.change(id, ticket_id);

ALTER TABLE ONLY factory.development_workspace
    ADD CONSTRAINT development_workspace_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.development_workspace
    ADD CONSTRAINT development_workspace_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.development_workspace
    ADD CONSTRAINT development_workspace_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);

ALTER TABLE ONLY factory.development_workspace
    ADD CONSTRAINT development_workspace_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES factory.ticket(id);

ALTER TABLE ONLY factory.development_workspace
    ADD CONSTRAINT development_workspace_ticket_id_project_id_fkey FOREIGN KEY (ticket_id, project_id) REFERENCES factory.ticket(id, project_id);

ALTER TABLE ONLY factory.environment_write
    ADD CONSTRAINT environment_write_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.environment_write
    ADD CONSTRAINT environment_write_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);

ALTER TABLE ONLY factory.epic_confirmation
    ADD CONSTRAINT epic_confirmation_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.epic_confirmation
    ADD CONSTRAINT epic_confirmation_epic_id_fkey FOREIGN KEY (epic_id) REFERENCES factory.epic(id);

ALTER TABLE ONLY factory.epic_confirmation
    ADD CONSTRAINT epic_confirmation_origin_ticket_id_fkey FOREIGN KEY (origin_ticket_id) REFERENCES factory.ticket(id);

ALTER TABLE ONLY factory.epic_confirmation
    ADD CONSTRAINT epic_confirmation_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);

ALTER TABLE ONLY factory.epic_confirmation
    ADD CONSTRAINT epic_confirmation_proposal_entry_id_fkey FOREIGN KEY (proposal_entry_id) REFERENCES factory.conversation_entry(id);

ALTER TABLE ONLY factory.epic
    ADD CONSTRAINT epic_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.epic
    ADD CONSTRAINT epic_parent_id_project_id_fkey FOREIGN KEY (parent_id, project_id) REFERENCES factory.epic(id, project_id);

ALTER TABLE ONLY factory.epic
    ADD CONSTRAINT epic_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.execution_policy_command
    ADD CONSTRAINT execution_policy_command_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.execution_policy
    ADD CONSTRAINT execution_policy_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.execution_slot
    ADD CONSTRAINT execution_slot_assigned_attempt_id_fkey FOREIGN KEY (assigned_attempt_id) REFERENCES factory.runtime_attempt(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY factory.external_identity
    ADD CONSTRAINT external_identity_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.factorybox_lifecycle_operation
    ADD CONSTRAINT factorybox_lifecycle_operation_runtime_attempt_id_fkey FOREIGN KEY (runtime_attempt_id) REFERENCES factory.factorybox_runtime(runtime_attempt_id);

ALTER TABLE ONLY factory.factorybox_runtime
    ADD CONSTRAINT factorybox_runtime_runtime_attempt_id_fkey FOREIGN KEY (runtime_attempt_id) REFERENCES factory.runtime_attempt(id);

ALTER TABLE ONLY factory.forge_account_intent
    ADD CONSTRAINT forge_account_intent_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.forge_branch_intent
    ADD CONSTRAINT forge_branch_intent_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);

ALTER TABLE ONLY factory.forge_connection
    ADD CONSTRAINT forge_connection_intended_by_fkey FOREIGN KEY (intended_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.forge_grant_intent
    ADD CONSTRAINT forge_grant_intent_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);

ALTER TABLE ONLY factory.forge_grant_intent
    ADD CONSTRAINT forge_grant_intent_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.forge_identity_intent
    ADD CONSTRAINT forge_identity_intent_intended_by_fkey FOREIGN KEY (intended_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.identity_configuration
    ADD CONSTRAINT identity_configuration_activated_by_fkey FOREIGN KEY (activated_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.identity_configuration
    ADD CONSTRAINT identity_configuration_setup_id_fkey FOREIGN KEY (setup_id) REFERENCES factory.identity_setup(id);

ALTER TABLE ONLY factory.identity_setup
    ADD CONSTRAINT identity_setup_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.identity_setup
    ADD CONSTRAINT identity_setup_tested_user_id_fkey FOREIGN KEY (tested_user_id) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.knowledge_generation
    ADD CONSTRAINT knowledge_generation_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.knowledge_generation
    ADD CONSTRAINT knowledge_generation_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);

ALTER TABLE ONLY factory.knowledge_generation
    ADD CONSTRAINT knowledge_model_connection FOREIGN KEY (model_connection_id, model_connection_version) REFERENCES factory.model_connection_version(connection_id, version);

ALTER TABLE ONLY factory.knowledge_page_alias
    ADD CONSTRAINT knowledge_page_alias_page_id_project_id_fkey FOREIGN KEY (page_id, project_id) REFERENCES factory.knowledge_page(id, project_id);

ALTER TABLE ONLY factory.knowledge_page_alias
    ADD CONSTRAINT knowledge_page_alias_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);

ALTER TABLE ONLY factory.knowledge_page
    ADD CONSTRAINT knowledge_page_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.knowledge_page
    ADD CONSTRAINT knowledge_page_current_revision_fk FOREIGN KEY (current_revision_id, id) REFERENCES factory.knowledge_revision(id, page_id);

ALTER TABLE ONLY factory.knowledge_page
    ADD CONSTRAINT knowledge_page_parent_project FOREIGN KEY (project_id, parent_id) REFERENCES factory.knowledge_page(project_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY factory.knowledge_page
    ADD CONSTRAINT knowledge_page_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);

ALTER TABLE ONLY factory.knowledge_revision
    ADD CONSTRAINT knowledge_revision_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.knowledge_revision
    ADD CONSTRAINT knowledge_revision_generation_id_fkey FOREIGN KEY (generation_id) REFERENCES factory.knowledge_generation(id);

ALTER TABLE ONLY factory.knowledge_revision
    ADD CONSTRAINT knowledge_revision_page_id_fkey FOREIGN KEY (page_id) REFERENCES factory.knowledge_page(id);

ALTER TABLE ONLY factory.mcp_access_decision
    ADD CONSTRAINT mcp_access_decision_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES factory.mcp_connection(id);

ALTER TABLE ONLY factory.mcp_access_decision
    ADD CONSTRAINT mcp_access_decision_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.mcp_access_decision
    ADD CONSTRAINT mcp_access_decision_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);

ALTER TABLE ONLY factory.mcp_choice
    ADD CONSTRAINT mcp_choice_library_id_fkey FOREIGN KEY (library_id) REFERENCES factory.mcp_library(id);

ALTER TABLE ONLY factory.mcp_choice
    ADD CONSTRAINT mcp_choice_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES factory.mcp_revision(id);

ALTER TABLE ONLY factory.mcp_connect_intent
    ADD CONSTRAINT mcp_connect_intent_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES factory.mcp_connection(id);

ALTER TABLE ONLY factory.mcp_connect_intent
    ADD CONSTRAINT mcp_connect_intent_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.mcp_connect_intent
    ADD CONSTRAINT mcp_connect_intent_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES factory.mcp_revision(id);

ALTER TABLE ONLY factory.mcp_connection
    ADD CONSTRAINT mcp_connection_authorized_by_fkey FOREIGN KEY (authorized_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.mcp_connection
    ADD CONSTRAINT mcp_connection_id_fkey FOREIGN KEY (id) REFERENCES factory.mcp_library(id);

ALTER TABLE ONLY factory.mcp_connection
    ADD CONSTRAINT mcp_connection_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES factory.mcp_revision(id);

ALTER TABLE ONLY factory.mcp_library
    ADD CONSTRAINT mcp_library_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.mcp_library
    ADD CONSTRAINT mcp_library_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);

ALTER TABLE ONLY factory.mcp_oauth_flow
    ADD CONSTRAINT mcp_oauth_flow_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES factory.mcp_connection(id);

ALTER TABLE ONLY factory.mcp_oauth_flow
    ADD CONSTRAINT mcp_oauth_flow_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.mcp_observation
    ADD CONSTRAINT mcp_observation_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES factory.mcp_connection(id);

ALTER TABLE ONLY factory.mcp_observation
    ADD CONSTRAINT mcp_observation_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES factory.agent_turn(id);

ALTER TABLE ONLY factory.mcp_policy_approval
    ADD CONSTRAINT mcp_policy_approval_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES factory.mcp_connection(id);

ALTER TABLE ONLY factory.mcp_policy_approval
    ADD CONSTRAINT mcp_policy_approval_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.mcp_policy_approval
    ADD CONSTRAINT mcp_policy_approval_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES factory.mcp_revision(id);

ALTER TABLE ONLY factory.mcp_project_grant
    ADD CONSTRAINT mcp_project_grant_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES factory.mcp_connection(id);

ALTER TABLE ONLY factory.mcp_project_grant
    ADD CONSTRAINT mcp_project_grant_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.mcp_project_grant
    ADD CONSTRAINT mcp_project_grant_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);

ALTER TABLE ONLY factory.mcp_revision
    ADD CONSTRAINT mcp_revision_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.mcp_revision
    ADD CONSTRAINT mcp_revision_library_id_fkey FOREIGN KEY (library_id) REFERENCES factory.mcp_library(id);

ALTER TABLE ONLY factory.mcp_secret_write
    ADD CONSTRAINT mcp_secret_write_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES factory.mcp_connection(id);

ALTER TABLE ONLY factory.mcp_share_proposal
    ADD CONSTRAINT mcp_share_proposal_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.mcp_share_proposal
    ADD CONSTRAINT mcp_share_proposal_accepted_library_id_fkey FOREIGN KEY (accepted_library_id) REFERENCES factory.mcp_library(id);

ALTER TABLE ONLY factory.mcp_share_proposal
    ADD CONSTRAINT mcp_share_proposal_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);

ALTER TABLE ONLY factory.mcp_share_proposal
    ADD CONSTRAINT mcp_share_proposal_proposed_by_fkey FOREIGN KEY (proposed_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.mcp_share_proposal
    ADD CONSTRAINT mcp_share_proposal_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES factory.mcp_revision(id);

ALTER TABLE ONLY factory.mcp_token_refresh
    ADD CONSTRAINT mcp_token_refresh_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES factory.mcp_connection(id);

ALTER TABLE ONLY factory.merge_operation
    ADD CONSTRAINT merge_operation_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);

ALTER TABLE ONLY factory.merge_operation
    ADD CONSTRAINT merge_operation_delivery_approval_id_fkey FOREIGN KEY (delivery_approval_id) REFERENCES factory.delivery_approval(id);

ALTER TABLE ONLY factory.model_connection_version
    ADD CONSTRAINT model_connection_version_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.model_connection_write
    ADD CONSTRAINT model_connection_write_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.model_defaults
    ADD CONSTRAINT model_defaults_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.model_role_connection
    ADD CONSTRAINT model_role_connection_connection_id_connection_version_fkey FOREIGN KEY (connection_id, connection_version) REFERENCES factory.model_connection_version(connection_id, version);

ALTER TABLE ONLY factory.model_role_connection
    ADD CONSTRAINT model_role_connection_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.model_role_probe
    ADD CONSTRAINT model_role_probe_connection_id_connection_version_fkey FOREIGN KEY (connection_id, connection_version) REFERENCES factory.model_connection_version(connection_id, version);

ALTER TABLE ONLY factory.model_role_probe
    ADD CONSTRAINT model_role_probe_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.monitoring_command
    ADD CONSTRAINT monitoring_command_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.monitoring_command
    ADD CONSTRAINT monitoring_command_hook_id_fkey FOREIGN KEY (hook_id) REFERENCES factory.monitoring_hook(id);

ALTER TABLE ONLY factory.monitoring_command
    ADD CONSTRAINT monitoring_command_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);

ALTER TABLE ONLY factory.monitoring_hook
    ADD CONSTRAINT monitoring_current_policy FOREIGN KEY (policy_id) REFERENCES factory.monitoring_policy(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY factory.monitoring_evidence
    ADD CONSTRAINT monitoring_evidence_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES factory.monitoring_incident(id);

ALTER TABLE ONLY factory.monitoring_hook
    ADD CONSTRAINT monitoring_hook_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);

ALTER TABLE ONLY factory.monitoring_incident
    ADD CONSTRAINT monitoring_incident_hook_id_fkey FOREIGN KEY (hook_id) REFERENCES factory.monitoring_hook(id);

ALTER TABLE ONLY factory.monitoring_incident
    ADD CONSTRAINT monitoring_incident_policy_id_fkey FOREIGN KEY (policy_id) REFERENCES factory.monitoring_policy(id);

ALTER TABLE ONLY factory.monitoring_incident
    ADD CONSTRAINT monitoring_incident_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);

ALTER TABLE ONLY factory.monitoring_incident
    ADD CONSTRAINT monitoring_incident_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES factory.ticket(id);

ALTER TABLE ONLY factory.monitoring_policy
    ADD CONSTRAINT monitoring_policy_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES factory.mcp_connection(id);

ALTER TABLE ONLY factory.monitoring_policy
    ADD CONSTRAINT monitoring_policy_delegated_by_fkey FOREIGN KEY (delegated_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.monitoring_policy
    ADD CONSTRAINT monitoring_policy_hook_id_fkey FOREIGN KEY (hook_id) REFERENCES factory.monitoring_hook(id);

ALTER TABLE ONLY factory.personal_model_settings
    ADD CONSTRAINT personal_model_settings_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.personal_model_settings
    ADD CONSTRAINT personal_model_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.personal_skill_settings
    ADD CONSTRAINT personal_skill_settings_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.personal_skill_settings
    ADD CONSTRAINT personal_skill_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.project
    ADD CONSTRAINT project_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.project_environment
    ADD CONSTRAINT project_environment_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);

ALTER TABLE ONLY factory.project_image_preparation
    ADD CONSTRAINT project_image_preparation_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);

ALTER TABLE ONLY factory.project_image_preparation
    ADD CONSTRAINT project_image_preparation_runtime_attempt_id_fkey FOREIGN KEY (runtime_attempt_id) REFERENCES factory.runtime_attempt(id);

ALTER TABLE ONLY factory.project_membership
    ADD CONSTRAINT project_membership_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.project_membership
    ADD CONSTRAINT project_membership_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.project_membership
    ADD CONSTRAINT project_membership_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.project_model_settings
    ADD CONSTRAINT project_model_settings_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.project_model_settings
    ADD CONSTRAINT project_model_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.project_release
    ADD CONSTRAINT project_release_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.project_release
    ADD CONSTRAINT project_release_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);

ALTER TABLE ONLY factory.project_repository_intent
    ADD CONSTRAINT project_repository_intent_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.project_setup_confirmation
    ADD CONSTRAINT project_setup_confirmation_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.project_setup_confirmation
    ADD CONSTRAINT project_setup_confirmation_inspection_id_fkey FOREIGN KEY (inspection_id) REFERENCES factory.project_setup_inspection(id);

ALTER TABLE ONLY factory.project_setup_draft
    ADD CONSTRAINT project_setup_draft_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);

ALTER TABLE ONLY factory.project_setup_draft
    ADD CONSTRAINT project_setup_draft_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.project_setup_inspection
    ADD CONSTRAINT project_setup_inspection_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.project_setup_inspection
    ADD CONSTRAINT project_setup_inspection_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES factory.project_setup_inspection(id);

ALTER TABLE ONLY factory.project_setup_inspection
    ADD CONSTRAINT project_setup_inspection_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.project_setup_readiness
    ADD CONSTRAINT project_setup_readiness_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.project_skill_settings
    ADD CONSTRAINT project_skill_settings_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.project_skill_settings
    ADD CONSTRAINT project_skill_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.promotion_operation
    ADD CONSTRAINT promotion_operation_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);

ALTER TABLE ONLY factory.promotion_operation
    ADD CONSTRAINT promotion_operation_previous_runtime_attempt_id_fkey FOREIGN KEY (previous_runtime_attempt_id) REFERENCES factory.runtime_attempt(id);

ALTER TABLE ONLY factory.promotion_operation
    ADD CONSTRAINT promotion_operation_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);

ALTER TABLE ONLY factory.promotion_operation
    ADD CONSTRAINT promotion_operation_replacement_runtime_attempt_id_fkey FOREIGN KEY (replacement_runtime_attempt_id) REFERENCES factory.runtime_attempt(id);

ALTER TABLE ONLY factory.pull_request_operation
    ADD CONSTRAINT pull_request_operation_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);

ALTER TABLE ONLY factory.release_access
    ADD CONSTRAINT release_access_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.release_access
    ADD CONSTRAINT release_access_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);

ALTER TABLE ONLY factory.release_access
    ADD CONSTRAINT release_access_release_id_fkey FOREIGN KEY (release_id) REFERENCES factory.project_release(id);

ALTER TABLE ONLY factory.release_access
    ADD CONSTRAINT release_access_replaces_id_fkey FOREIGN KEY (replaces_id) REFERENCES factory.release_access(id);

ALTER TABLE ONLY factory.release_attempt
    ADD CONSTRAINT release_attempt_release_id_fkey FOREIGN KEY (release_id) REFERENCES factory.project_release(id);

ALTER TABLE ONLY factory.release_attempt
    ADD CONSTRAINT release_attempt_runtime_attempt_id_fkey FOREIGN KEY (runtime_attempt_id) REFERENCES factory.runtime_attempt(id);

ALTER TABLE ONLY factory.requirement_approval
    ADD CONSTRAINT requirement_approval_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.requirement_approval
    ADD CONSTRAINT requirement_approval_monitoring_incident_id_fkey FOREIGN KEY (monitoring_incident_id) REFERENCES factory.monitoring_incident(id);

ALTER TABLE ONLY factory.requirement_approval
    ADD CONSTRAINT requirement_approval_monitoring_policy_id_fkey FOREIGN KEY (monitoring_policy_id) REFERENCES factory.monitoring_policy(id);

ALTER TABLE ONLY factory.requirement_approval
    ADD CONSTRAINT requirement_approval_requirement_revision_id_ticket_id_fkey FOREIGN KEY (requirement_revision_id, ticket_id) REFERENCES factory.requirement_revision(id, ticket_id);

ALTER TABLE ONLY factory.requirement_approval
    ADD CONSTRAINT requirement_approval_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES factory.ticket(id);

ALTER TABLE ONLY factory.requirement_revision
    ADD CONSTRAINT requirement_revision_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.requirement_revision
    ADD CONSTRAINT requirement_revision_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES factory.ticket(id);

ALTER TABLE ONLY factory.requirements_entry_intent
    ADD CONSTRAINT requirements_entry_intent_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.requirements_entry_intent
    ADD CONSTRAINT requirements_entry_intent_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES factory.ticket(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.review_feedback
    ADD CONSTRAINT review_feedback_author_id_fkey FOREIGN KEY (author_id) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.review_feedback
    ADD CONSTRAINT review_feedback_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);

ALTER TABLE ONLY factory.review_feedback_command
    ADD CONSTRAINT review_feedback_command_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.review_feedback_command
    ADD CONSTRAINT review_feedback_command_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);

ALTER TABLE ONLY factory.review_feedback_command
    ADD CONSTRAINT review_feedback_command_feedback_id_fkey FOREIGN KEY (feedback_id) REFERENCES factory.review_feedback(id);

ALTER TABLE ONLY factory.review_feedback_command
    ADD CONSTRAINT review_feedback_command_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES factory.agent_turn(id);

ALTER TABLE ONLY factory.review_feedback
    ADD CONSTRAINT review_feedback_media_id_fkey FOREIGN KEY (media_id) REFERENCES factory.review_media(id);

ALTER TABLE ONLY factory.review_feedback_message
    ADD CONSTRAINT review_feedback_message_author_id_fkey FOREIGN KEY (author_id) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.review_feedback_message
    ADD CONSTRAINT review_feedback_message_feedback_id_fkey FOREIGN KEY (feedback_id) REFERENCES factory.review_feedback(id);

ALTER TABLE ONLY factory.review_feedback
    ADD CONSTRAINT review_feedback_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.review_media
    ADD CONSTRAINT review_media_browser_session_id_fkey FOREIGN KEY (browser_session_id) REFERENCES factory.build_browser_session(id);

ALTER TABLE ONLY factory.review_media
    ADD CONSTRAINT review_media_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);

ALTER TABLE ONLY factory.review_media
    ADD CONSTRAINT review_media_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.review_media
    ADD CONSTRAINT review_media_review_id_fkey FOREIGN KEY (review_id) REFERENCES factory.candidate_review(id);

ALTER TABLE ONLY factory.review_media
    ADD CONSTRAINT review_media_runtime_attempt_id_fkey FOREIGN KEY (runtime_attempt_id) REFERENCES factory.runtime_attempt(id);

ALTER TABLE ONLY factory.review_scenario
    ADD CONSTRAINT review_scenario_media_session_id_fkey FOREIGN KEY (media_session_id) REFERENCES factory.build_browser_session(id);

ALTER TABLE ONLY factory.review_scenario
    ADD CONSTRAINT review_scenario_review_id_fkey FOREIGN KEY (review_id) REFERENCES factory.candidate_review(id);

ALTER TABLE ONLY factory.runtime_artifact_intent
    ADD CONSTRAINT runtime_artifact_intent_runtime_attempt_id_fkey FOREIGN KEY (runtime_attempt_id) REFERENCES factory.runtime_attempt(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.runtime_attempt
    ADD CONSTRAINT runtime_attempt_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);

ALTER TABLE ONLY factory.runtime_attempt
    ADD CONSTRAINT runtime_attempt_change_project_fk FOREIGN KEY (change_id, project_id) REFERENCES factory.change(id, project_id);

ALTER TABLE ONLY factory.runtime_attempt
    ADD CONSTRAINT runtime_attempt_change_revision_fk FOREIGN KEY (change_id, project_id, revision) REFERENCES factory.change(id, project_id, base_sha);

ALTER TABLE ONLY factory.runtime_attempt
    ADD CONSTRAINT runtime_attempt_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.runtime_attempt
    ADD CONSTRAINT runtime_attempt_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);

ALTER TABLE ONLY factory.runtime_attempt
    ADD CONSTRAINT runtime_attempt_verification_id_fkey FOREIGN KEY (verification_id) REFERENCES factory.verification(id);

ALTER TABLE ONLY factory.runtime_attempt
    ADD CONSTRAINT runtime_attempt_workspace_change_fk FOREIGN KEY (workspace_id, change_id) REFERENCES factory.development_workspace(id, change_id);

ALTER TABLE ONLY factory.runtime_attempt
    ADD CONSTRAINT runtime_attempt_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES factory.development_workspace(id);

ALTER TABLE ONLY factory.runtime_attempt
    ADD CONSTRAINT runtime_attempt_workspace_project_fk FOREIGN KEY (workspace_id, project_id) REFERENCES factory.development_workspace(id, project_id);

ALTER TABLE ONLY factory.runtime_compute_wait
    ADD CONSTRAINT runtime_compute_wait_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES factory.runtime_attempt(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY factory.runtime_environment_intent
    ADD CONSTRAINT runtime_environment_intent_runtime_attempt_id_fkey FOREIGN KEY (runtime_attempt_id) REFERENCES factory.runtime_attempt(id);

ALTER TABLE ONLY factory.skill_library_choice
    ADD CONSTRAINT skill_library_choice_library_id_fkey FOREIGN KEY (library_id) REFERENCES factory.skill_library(id);

ALTER TABLE ONLY factory.skill_library_choice
    ADD CONSTRAINT skill_library_choice_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES factory.skill_revision(id);

ALTER TABLE ONLY factory.skill_library
    ADD CONSTRAINT skill_library_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.skill_library
    ADD CONSTRAINT skill_library_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);

ALTER TABLE ONLY factory.skill_library_revision
    ADD CONSTRAINT skill_library_revision_copied_from_fkey FOREIGN KEY (copied_from) REFERENCES factory.skill_revision(id);

ALTER TABLE ONLY factory.skill_library_revision
    ADD CONSTRAINT skill_library_revision_library_id_fkey FOREIGN KEY (library_id) REFERENCES factory.skill_library(id);

ALTER TABLE ONLY factory.skill_library_revision
    ADD CONSTRAINT skill_library_revision_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES factory.skill_revision(id);

ALTER TABLE ONLY factory.skill_publication
    ADD CONSTRAINT skill_publication_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES factory.skill_revision(id);

ALTER TABLE ONLY factory.skill_publication
    ADD CONSTRAINT skill_publication_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.skill_revision
    ADD CONSTRAINT skill_revision_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.skill_share_proposal
    ADD CONSTRAINT skill_share_proposal_accepted_library_id_fkey FOREIGN KEY (accepted_library_id) REFERENCES factory.skill_library(id);

ALTER TABLE ONLY factory.skill_share_proposal
    ADD CONSTRAINT skill_share_proposal_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);

ALTER TABLE ONLY factory.skill_share_proposal
    ADD CONSTRAINT skill_share_proposal_proposed_by_fkey FOREIGN KEY (proposed_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.skill_share_proposal
    ADD CONSTRAINT skill_share_proposal_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES factory.skill_revision(id);

ALTER TABLE ONLY factory.staging_preview
    ADD CONSTRAINT staging_preview_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);

ALTER TABLE ONLY factory.staging_preview
    ADD CONSTRAINT staging_preview_runtime_attempt_id_project_id_fkey FOREIGN KEY (runtime_attempt_id, project_id) REFERENCES factory.runtime_attempt(id, project_id);

ALTER TABLE ONLY factory.system_skill_settings
    ADD CONSTRAINT system_skill_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.ticket_conversation
    ADD CONSTRAINT ticket_conversation_active_coding_context_id_fkey FOREIGN KEY (active_coding_context_id) REFERENCES factory.conversation_context(id);

ALTER TABLE ONLY factory.ticket_conversation
    ADD CONSTRAINT ticket_conversation_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.ticket_conversation
    ADD CONSTRAINT ticket_conversation_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.ticket_conversation
    ADD CONSTRAINT ticket_conversation_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES factory.ticket(id) ON DELETE RESTRICT;

ALTER TABLE ONLY factory.ticket
    ADD CONSTRAINT ticket_converted_to_epic_id_fkey FOREIGN KEY (converted_to_epic_id) REFERENCES factory.epic(id);

ALTER TABLE ONLY factory.ticket
    ADD CONSTRAINT ticket_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.ticket_dependency
    ADD CONSTRAINT ticket_dependency_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.ticket_dependency
    ADD CONSTRAINT ticket_dependency_prerequisite_id_project_id_fkey FOREIGN KEY (prerequisite_id, project_id) REFERENCES factory.ticket(id, project_id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.ticket_dependency
    ADD CONSTRAINT ticket_dependency_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.ticket_dependency
    ADD CONSTRAINT ticket_dependency_ticket_id_project_id_fkey FOREIGN KEY (ticket_id, project_id) REFERENCES factory.ticket(id, project_id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.ticket_document_revision
    ADD CONSTRAINT ticket_document_revision_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.ticket_document_revision
    ADD CONSTRAINT ticket_document_revision_proposal_entry_id_fkey FOREIGN KEY (proposal_entry_id) REFERENCES factory.conversation_entry(id);

ALTER TABLE ONLY factory.ticket_document_revision
    ADD CONSTRAINT ticket_document_revision_requirement_revision_id_ticket_id_fkey FOREIGN KEY (requirement_revision_id, ticket_id) REFERENCES factory.requirement_revision(id, ticket_id);

ALTER TABLE ONLY factory.ticket_document_revision
    ADD CONSTRAINT ticket_document_revision_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES factory.ticket(id);

ALTER TABLE ONLY factory.ticket
    ADD CONSTRAINT ticket_epic_id_project_id_fkey FOREIGN KEY (epic_id, project_id) REFERENCES factory.epic(id, project_id);

ALTER TABLE ONLY factory.ticket_follow_up
    ADD CONSTRAINT ticket_follow_up_source_document_id_fkey FOREIGN KEY (source_document_id) REFERENCES factory.ticket_document_revision(id);

ALTER TABLE ONLY factory.ticket_follow_up
    ADD CONSTRAINT ticket_follow_up_source_revision_id_source_ticket_id_fkey FOREIGN KEY (source_revision_id, source_ticket_id) REFERENCES factory.requirement_revision(id, ticket_id);

ALTER TABLE ONLY factory.ticket_follow_up
    ADD CONSTRAINT ticket_follow_up_source_ticket_id_fkey FOREIGN KEY (source_ticket_id) REFERENCES factory.ticket(id);

ALTER TABLE ONLY factory.ticket_follow_up
    ADD CONSTRAINT ticket_follow_up_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES factory.ticket(id);

ALTER TABLE ONLY factory.ticket
    ADD CONSTRAINT ticket_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);

ALTER TABLE ONLY factory.ticket
    ADD CONSTRAINT ticket_trashed_by_fkey FOREIGN KEY (trashed_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.usage_entry
    ADD CONSTRAINT usage_entry_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES factory.usage_operation(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.usage_operation
    ADD CONSTRAINT usage_operation_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.usage_operation
    ADD CONSTRAINT usage_operation_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.usage_rate_override
    ADD CONSTRAINT usage_rate_override_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.usage_replay_cursor
    ADD CONSTRAINT usage_replay_cursor_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES factory.usage_operation(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.user_ui_preference
    ADD CONSTRAINT user_ui_preference_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;

ALTER TABLE ONLY factory.verification
    ADD CONSTRAINT verification_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);

ALTER TABLE ONLY factory.verification
    ADD CONSTRAINT verification_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);

ALTER TABLE ONLY factory.verification
    ADD CONSTRAINT verification_runtime_fk FOREIGN KEY (runtime_attempt_id, id) REFERENCES factory.runtime_attempt(id, verification_id);

ALTER TABLE ONLY factory.wiki_source_update
    ADD CONSTRAINT wiki_source_update_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);

ALTER TABLE ONLY factory.workspace_source
    ADD CONSTRAINT workspace_source_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES factory.development_workspace(id);

CREATE TABLE factory.personal_git_operation (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES factory.development_workspace(id),
    runtime_attempt_id uuid NOT NULL REFERENCES factory.runtime_attempt(id),
    user_id uuid NOT NULL REFERENCES auth."user"(id),
    action text NOT NULL CHECK (action IN ('commit','fetch','pull')),
    expected_head text NOT NULL CHECK (expected_head ~ '^[a-f0-9]{40}([a-f0-9]{24})?$'),
    branch text NOT NULL CHECK (length(branch) BETWEEN 1 AND 200),
    message text NOT NULL CHECK (length(message) <= 240),
    state text NOT NULL DEFAULT 'intended' CHECK (state IN ('intended','attempted','succeeded','failed','uncertain')),
    result jsonb,
    failure text,
    created_at timestamptz NOT NULL DEFAULT now(),
    attempted_at timestamptz,
    completed_at timestamptz,
    CHECK ((state IN ('succeeded','failed')) = (completed_at IS NOT NULL)),
    CHECK (state <> 'succeeded' OR (result IS NOT NULL AND jsonb_typeof(result) = 'object')),
    FOREIGN KEY (runtime_attempt_id,workspace_id) REFERENCES factory.runtime_attempt(id,workspace_id)
);
CREATE INDEX personal_git_operation_workspace ON factory.personal_git_operation(workspace_id, created_at);
CREATE FUNCTION factory.protect_personal_git_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' OR
      ROW(NEW.id,NEW.workspace_id,NEW.runtime_attempt_id,NEW.user_id,NEW.action,NEW.expected_head,NEW.branch,NEW.message,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.runtime_attempt_id,OLD.user_id,OLD.action,OLD.expected_head,OLD.branch,OLD.message,OLD.created_at)
      OR OLD.state IN ('succeeded','failed')
      OR (OLD.attempted_at IS NOT NULL AND NEW.attempted_at IS DISTINCT FROM OLD.attempted_at)
      OR (OLD.state <> 'intended' AND NEW.state = 'intended') THEN
        RAISE EXCEPTION 'Personal Git intent and completed outcomes are immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER personal_git_operation_immutable BEFORE UPDATE OR DELETE
    ON factory.personal_git_operation FOR EACH ROW EXECUTE FUNCTION factory.protect_personal_git_operation();

CREATE PUBLICATION factory_zero_publication FOR TABLE factory.epic, factory.knowledge_page, factory.project, factory.project_membership, factory.ticket, factory.ticket_dependency;

INSERT INTO factory.installation_maintenance(singleton) VALUES (true);
INSERT INTO factory.attachment_storage(singleton,id) VALUES (true,gen_random_uuid());
INSERT INTO factory.schema_migration(version) VALUES (1);

COMMIT;
