-- Factory Greenfield baseline. Official Substrate is the sole execution runtime.
BEGIN;
--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14 (Debian 16.14-1.pgdg12+1)
-- Dumped by pg_dump version 16.14 (Debian 16.14-1.pgdg12+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: auth; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA auth;


--
-- Name: factory; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA factory;


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA factory;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA factory;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: agent_turn_state; Type: TYPE; Schema: factory; Owner: -
--

CREATE TYPE factory.agent_turn_state AS ENUM (
    'pending',
    'dispatching',
    'running',
    'completed',
    'failed',
    'stopped',
    'uncertain'
);


--
-- Name: branch_operation_state; Type: TYPE; Schema: factory; Owner: -
--

CREATE TYPE factory.branch_operation_state AS ENUM (
    'pending',
    'executing',
    'ambiguous',
    'succeeded',
    'failed',
    'cancelled'
);


--
-- Name: change_agent_state; Type: TYPE; Schema: factory; Owner: -
--

CREATE TYPE factory.change_agent_state AS ENUM (
    'starting',
    'working',
    'waiting',
    'stopped',
    'failed',
    'committed'
);


--
-- Name: change_commit_source; Type: TYPE; Schema: factory; Owner: -
--

CREATE TYPE factory.change_commit_source AS ENUM (
    'agent',
    'integration',
    'repository-document',
    'workspace'
);


--
-- Name: change_commit_state; Type: TYPE; Schema: factory; Owner: -
--

CREATE TYPE factory.change_commit_state AS ENUM (
    'commit-intended',
    'committed',
    'push-intended',
    'succeeded',
    'failed'
);


--
-- Name: change_state; Type: TYPE; Schema: factory; Owner: -
--

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


--
-- Name: conversation_actor; Type: TYPE; Schema: factory; Owner: -
--

CREATE TYPE factory.conversation_actor AS ENUM (
    'user',
    'project-agent',
    'change-agent',
    'system'
);


--
-- Name: conversation_entry_kind; Type: TYPE; Schema: factory; Owner: -
--

CREATE TYPE factory.conversation_entry_kind AS ENUM (
    'user-message',
    'agent-message',
    'question',
    'answer',
    'requirement',
    'mode-change'
);


--
-- Name: conversation_mode; Type: TYPE; Schema: factory; Owner: -
--

CREATE TYPE factory.conversation_mode AS ENUM (
    'investigate',
    'plan',
    'build'
);


--
-- Name: development_workspace_kind; Type: TYPE; Schema: factory; Owner: -
--

CREATE TYPE factory.development_workspace_kind AS ENUM (
    'personal',
    'ticket'
);


--
-- Name: isolated_runtime_kind; Type: TYPE; Schema: factory; Owner: -
--

CREATE TYPE factory.isolated_runtime_kind AS ENUM (
    'staging',
    'verification',
    'prebuild',
    'publication'
);


--
-- Name: knowledge_generation_state; Type: TYPE; Schema: factory; Owner: -
--

CREATE TYPE factory.knowledge_generation_state AS ENUM (
    'pending',
    'running',
    'succeeded',
    'failed'
);


--
-- Name: knowledge_page_state; Type: TYPE; Schema: factory; Owner: -
--

CREATE TYPE factory.knowledge_page_state AS ENUM (
    'active',
    'archived'
);


--
-- Name: knowledge_revision_kind; Type: TYPE; Schema: factory; Owner: -
--

CREATE TYPE factory.knowledge_revision_kind AS ENUM (
    'generated',
    'human',
    'proposed'
);


--
-- Name: merge_operation_state; Type: TYPE; Schema: factory; Owner: -
--

CREATE TYPE factory.merge_operation_state AS ENUM (
    'pending',
    'executing',
    'ambiguous',
    'succeeded',
    'failed'
);


--
-- Name: promotion_operation_state; Type: TYPE; Schema: factory; Owner: -
--

CREATE TYPE factory.promotion_operation_state AS ENUM (
    'pending',
    'starting',
    'switching',
    'succeeded',
    'failed'
);


--
-- Name: pull_request_operation_state; Type: TYPE; Schema: factory; Owner: -
--

CREATE TYPE factory.pull_request_operation_state AS ENUM (
    'pending',
    'executing',
    'ambiguous',
    'succeeded',
    'failed'
);


--
-- Name: runtime_attempt_state; Type: TYPE; Schema: factory; Owner: -
--

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


--
-- Name: ticket_state; Type: TYPE; Schema: factory; Owner: -
--

CREATE TYPE factory.ticket_state AS ENUM (
    'inbox',
    'backlog',
    'ready',
    'in-progress',
    'cancelled',
    'done'
);


--
-- Name: verification_state; Type: TYPE; Schema: factory; Owner: -
--

CREATE TYPE factory.verification_state AS ENUM (
    'pending',
    'runner-starting',
    'running',
    'succeeded',
    'failed',
    'cancelled'
);


--
-- Name: assign_project_background(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: bind_attachment_references(uuid, uuid, text, uuid, text, boolean); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: bind_authored_attachments(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: check_session_access(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: enqueue_access_revocation(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: enqueue_project_access(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: guard_active_coding_context(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: guard_agent_turn(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: guard_build_browser_ordinal(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: guard_build_browser_session(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: guard_candidate_review(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: guard_change_agent_turn_intent(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: guard_change_prerequisites(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: guard_conversation_context(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: guard_epic_hierarchy(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: guard_knowledge_hierarchy(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: guard_learning_record(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: guard_loaded_skill(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: guard_native_skill_intent(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: guard_project_repository_intent(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: guard_review_media(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: guard_review_scenario(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: guard_setup_inspection(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: guard_ticket_dependency(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: guard_usage_entry(); Type: FUNCTION; Schema: factory; Owner: -
--

CREATE FUNCTION factory.guard_usage_entry() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN RAISE EXCEPTION 'Usage observations are immutable'; END;
$$;


--
-- Name: guard_usage_operation(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: image_build_is_public(text); Type: FUNCTION; Schema: factory; Owner: -
--

CREATE FUNCTION factory.image_build_is_public(secret_key text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $_$
  SELECT $1 IS NULL OR EXISTS (
    SELECT 1 FROM factory.environment_write write
    WHERE write.secret_key=$1 AND write.state='committed'
      AND write.manifest->'registries'='[]'::jsonb
      AND jsonb_typeof(write.manifest->'variables')='array'
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(write.manifest->'variables') variable
        WHERE variable->'build' IS DISTINCT FROM 'false'::jsonb
      )
  )
$_$;


--
-- Name: initialize_account_access(); Type: FUNCTION; Schema: factory; Owner: -
--

CREATE FUNCTION factory.initialize_account_access() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO factory.account_access(user_id) VALUES (NEW.id);
  RETURN NEW;
END $$;


--
-- Name: initialize_change_writer(); Type: FUNCTION; Schema: factory; Owner: -
--

CREATE FUNCTION factory.initialize_change_writer() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO factory.change_writer(change_id) VALUES(NEW.id);
  RETURN NEW;
END;
$$;


--
-- Name: invalidate_factory_reads(); Type: FUNCTION; Schema: factory; Owner: -
--

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

  IF TG_TABLE_NAME IN ('inbox_receipt','account_access','administrator') THEN
    person := (record->>'user_id')::uuid;
    FOR project IN
      SELECT id FROM factory.project WHERE EXISTS(
        SELECT 1 FROM factory.project_membership WHERE project_id=id AND user_id=person)
        OR EXISTS(SELECT 1 FROM factory.administrator WHERE user_id=person)
      ORDER BY id
    LOOP
      PERFORM factory.touch_read_version(project,'inbox',project,person::text);
      IF TG_TABLE_NAME<>'inbox_receipt' THEN
        PERFORM factory.touch_read_version(project,'inbox',project);
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;

  project := (record->>'project_id')::uuid;
  ticket := (record->>'ticket_id')::uuid;
  change := (record->>'change_id')::uuid;
  conversation := (record->>'conversation_id')::uuid;
  IF TG_TABLE_NAME='project' THEN project := (record->>'id')::uuid; END IF;
  IF TG_TABLE_NAME='ticket' THEN ticket := (record->>'id')::uuid; END IF;
  IF TG_TABLE_NAME='change' THEN change := (record->>'id')::uuid; END IF;
  IF TG_TABLE_NAME='ticket_conversation' THEN conversation := (record->>'id')::uuid; END IF;
  IF TG_TABLE_NAME='coding_pause' THEN
    SELECT change_id INTO change FROM factory.agent_turn WHERE id=(record->>'turn_id')::uuid;
  END IF;
  IF TG_TABLE_NAME='runtime_compute_wait' THEN
    SELECT project_id,change_id INTO project,change FROM factory.runtime_attempt WHERE id=(record->>'attempt_id')::uuid;
  END IF;
  IF TG_TABLE_NAME='review_feedback_message' THEN
    SELECT change_id INTO change FROM factory.review_feedback WHERE id=(record->>'feedback_id')::uuid;
  END IF;
  IF TG_TABLE_NAME='review_scenario' THEN
    SELECT change_id INTO change FROM factory.candidate_review WHERE id=(record->>'review_id')::uuid;
  END IF;
  IF change IS NOT NULL THEN
    SELECT project_id,ticket_id INTO project,ticket FROM factory.change WHERE id=projection.change;
  ELSIF conversation IS NOT NULL THEN
    SELECT project_id,ticket_id,CASE WHEN ticket_id IS NULL THEN created_by::text ELSE 'shared' END
      INTO project,ticket,audience FROM factory.ticket_conversation WHERE id=projection.conversation;
  ELSIF ticket IS NOT NULL THEN
    SELECT project_id INTO project FROM factory.ticket WHERE id=projection.ticket;
  END IF;
  IF TG_TABLE_NAME='agent_turn' AND ticket IS NULL THEN audience := record->>'created_by'; END IF;
  IF TG_TABLE_NAME='ticket_follow' THEN audience := record->>'user_id'; END IF;
  IF TG_TABLE_NAME='change_editing_request' THEN audience := record->>'owner_id'; END IF;
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
  IF TG_TABLE_NAME IN ('change','runtime_attempt','runtime_compute_wait','staging_preview','verification','candidate_review',
    'change_agent_session','change_writer','change_editing_decision',
    'coding_pause','delivery_approval','merge_operation','promotion_operation',
    'pull_request_operation','review_feedback','review_feedback_message','review_media','review_scenario','implementation_order','project_delivery_queue')
    OR (TG_TABLE_NAME='agent_turn' AND change IS NOT NULL) THEN
    PERFORM factory.touch_read_version(project,'lifecycle',project);
  END IF;
  IF TG_TABLE_NAME IN ('knowledge_generation','knowledge_page') THEN
    PERFORM factory.touch_read_version(project,'knowledge',project);
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: invalidate_settings_reads(); Type: FUNCTION; Schema: factory; Owner: -
--

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
  ELSIF TG_TABLE_NAME IN ('project_release','release_access') THEN
    project := (record->>'project_id')::uuid;
    target_scope := 'releases';
  ELSIF TG_TABLE_NAME='release_attempt' THEN
    SELECT project_id INTO project FROM factory.project_release WHERE id=(record->>'release_id')::uuid;
    IF project IS NULL THEN RETURN NULL; END IF;
    target_scope := 'releases';
  ELSIF TG_TABLE_NAME='mcp_project_grant' THEN
    project := (record->>'project_id')::uuid;
    target_scope := 'sources';
  ELSIF TG_TABLE_NAME='mcp_choice' THEN
    IF record->>'scope'='personal' THEN RETURN NULL; END IF;
    IF record->>'scope'='project' THEN project := (record->>'context_id')::uuid; END IF;
    target_scope := 'sources';
  ELSE
    library := COALESCE((record->>'library_id')::uuid,(record->>'id')::uuid);
    IF TG_TABLE_NAME='mcp_library' THEN
      project := (record->>'project_id')::uuid;
      library_scope := record->>'scope';
    ELSE
      SELECT scope,project_id INTO library_scope,project FROM factory.mcp_library WHERE id=library;
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


--
-- Name: prevent_conversation_entry_mutation(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: project_knowledge_page_outline(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: protect_attachment_identity(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: protect_branch_operation(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: protect_change_identity(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: protect_delivery_policy(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: protect_developer_ide_intent(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: protect_development_workspace_identity(); Type: FUNCTION; Schema: factory; Owner: -
--

CREATE FUNCTION factory.protect_development_workspace_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.id,NEW.project_id,NEW.kind,NEW.owner_user_id,NEW.ticket_id,NEW.change_id,
      NEW.source_branch,NEW.source_revision,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.project_id,OLD.kind,OLD.owner_user_id,OLD.ticket_id,OLD.change_id,
      OLD.source_branch,OLD.source_revision,OLD.created_by,OLD.created_at)
    THEN RAISE EXCEPTION 'Development Workspace identity and source are immutable'; END IF;
  RETURN NEW;
END $$;


--
-- Name: protect_implementation_order(); Type: FUNCTION; Schema: factory; Owner: -
--

CREATE FUNCTION factory.protect_implementation_order() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.command_id,NEW.project_id,NEW.ticket_id,NEW.created_by,NEW.requirement_revision_id,
      NEW.technical_design_revision_id,NEW.coding_reasoning,NEW.source_sha,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.command_id,OLD.project_id,OLD.ticket_id,OLD.created_by,OLD.requirement_revision_id,
      OLD.technical_design_revision_id,OLD.coding_reasoning,OLD.source_sha,OLD.created_at)
    OR (OLD.state<>'waiting' AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Commissioned implementation scope is immutable';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: protect_integration_intent(); Type: FUNCTION; Schema: factory; Owner: -
--

CREATE FUNCTION factory.protect_integration_intent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.change_id,NEW.runtime_attempt_id,NEW.sequence,NEW.source,NEW.expected_parent_sha,
      NEW.integration_base_sha,NEW.merge_parent_sha,NEW.branch_name,NEW.commit_message,NEW.created_by,NEW.idempotency_key)
    IS DISTINCT FROM ROW(OLD.change_id,OLD.runtime_attempt_id,OLD.sequence,OLD.source,OLD.expected_parent_sha,
      OLD.integration_base_sha,OLD.merge_parent_sha,OLD.branch_name,OLD.commit_message,OLD.created_by,OLD.idempotency_key) THEN
    RAISE EXCEPTION 'Commit intent and integrated source are immutable';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: protect_model_connection_version(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: protect_model_connection_write(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: protect_model_role_probe(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: protect_personal_git_operation(); Type: FUNCTION; Schema: factory; Owner: -
--

CREATE FUNCTION factory.protect_personal_git_operation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: protect_project_image_preparation(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: protect_project_release_identity(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: protect_promotion_operation(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: protect_pull_request_operation(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: protect_release_attempt_identity(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: protect_repository_mirror_command(); Type: FUNCTION; Schema: factory; Owner: -
--

CREATE FUNCTION factory.protect_repository_mirror_command() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF ROW(NEW.id,NEW.project_id,NEW.created_by,NEW.action,NEW.target_url,NEW.remote_name,
           NEW.fingerprint,NEW.before_state,NEW.created_at) IS DISTINCT FROM
       ROW(OLD.id,OLD.project_id,OLD.created_by,OLD.action,OLD.target_url,OLD.remote_name,
           OLD.fingerprint,OLD.before_state,OLD.created_at)
       OR (OLD.state IN ('completed','failed','acknowledged') AND NEW IS DISTINCT FROM OLD) THEN
        RAISE EXCEPTION 'Repository mirror command identity and terminal outcome are immutable';
    END IF;
    RETURN NEW;
END $$;


--
-- Name: protect_runtime_attempt_identity(); Type: FUNCTION; Schema: factory; Owner: -
--

CREATE FUNCTION factory.protect_runtime_attempt_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.id,NEW.project_id,NEW.change_id,NEW.workspace_id,NEW.generation,NEW.revision,
      NEW.isolated_kind,NEW.verification_id,NEW.parent_connector_token_hash,NEW.child_connector_token_hash,
      NEW.create_intended_at,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.project_id,OLD.change_id,OLD.workspace_id,OLD.generation,OLD.revision,
      OLD.isolated_kind,OLD.verification_id,OLD.parent_connector_token_hash,OLD.child_connector_token_hash,
      OLD.create_intended_at,OLD.created_by,OLD.created_at)
    OR (OLD.declared_apps<>'[]'::jsonb AND NEW.declared_apps IS DISTINCT FROM OLD.declared_apps)
    THEN RAISE EXCEPTION 'Runtime Attempt identity and create intent are immutable'; END IF;
  RETURN NEW;
END $$;


--
-- Name: protect_runtime_environment_intent(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: protect_session_archive(); Type: FUNCTION; Schema: factory; Owner: -
--

CREATE FUNCTION factory.protect_session_archive() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM factory.agent_turn turn
      JOIN factory.change_agent_turn_intent intent ON intent.turn_id=turn.id
      JOIN factory.runtime_attempt attempt ON attempt.id=intent.runtime_attempt_id
        AND attempt.change_id=turn.change_id AND attempt.project_id=turn.project_id
      WHERE turn.id=NEW.turn_id AND turn.state='completed'
        AND intent.runtime_attempt_id=NEW.runtime_attempt_id
        AND intent.session_id=NEW.session_id AND intent.prompt_id=NEW.prompt_id
    ) THEN RAISE EXCEPTION 'Transcript archive requires its exact completed native turn'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' OR OLD.state='saved'
    OR (NEW.turn_id,NEW.runtime_attempt_id,NEW.session_id,NEW.prompt_id,NEW.source_refs,NEW.created_at)
      IS DISTINCT FROM (OLD.turn_id,OLD.runtime_attempt_id,OLD.session_id,OLD.prompt_id,OLD.source_refs,OLD.created_at)
  THEN RAISE EXCEPTION 'Native transcript checkpoint identity is immutable'; END IF;
  RETURN NEW;
END $$;


--
-- Name: protect_staging_configuration(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: protect_substrate_binding(); Type: FUNCTION; Schema: factory; Owner: -
--

CREATE FUNCTION factory.protect_substrate_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Native names and bindings cannot be reused'; END IF;
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM factory.runtime_attempt a WHERE a.id=NEW.runtime_attempt_id
      AND a.substrate AND a.state='create-intended' AND a.stop_intended_at IS NULL
      AND (EXISTS(SELECT 1 FROM factory.development_workspace w WHERE w.id=a.workspace_id AND w.substrate)
        OR EXISTS(SELECT 1 FROM factory.substrate_verification p WHERE p.verification_id=a.verification_id
          AND p.runtime_attempt_id=a.id AND p.generation=a.generation AND a.isolated_kind='verification'
          AND a.workspace_id IS NULL AND a.change_id IS NULL AND p.atespace IS NOT NULL
          AND p.policy IS NOT NULL AND p.template IS NOT NULL
          AND NEW.intent->>'projectID'=a.project_id::text
          AND NEW.intent->>'generation'=a.generation::text
          AND NEW.intent->>'verificationID'=p.verification_id::text
          AND NEW.intent->>'atespaceUID'=p.atespace#>>'{metadata,uid}'
          AND NEW.intent->>'templateUID'=p.template#>>'{metadata,uid}'
          AND NEW.intent->>'templateVersion'=p.template#>>'{metadata,version}'
          AND NEW.intent->>'templateSHA256'=p.intent->>'templateSHA256')
        OR EXISTS(SELECT 1 FROM factory.substrate_prebuild p JOIN factory.project_image_preparation preparation ON preparation.id=p.preparation_id
          WHERE p.runtime_attempt_id=a.id AND p.generation=a.generation AND a.isolated_kind='prebuild'
            AND a.workspace_id IS NULL AND a.change_id IS NULL AND preparation.runtime_attempt_id=a.id
            AND preparation.project_id=a.project_id AND preparation.revision=a.revision
            AND p.atespace IS NOT NULL AND p.policy IS NOT NULL AND p.template IS NOT NULL
            AND NOT p.atespace_rejected AND NOT p.policy_rejected AND NOT p.template_rejected
            AND NEW.intent->>'projectID'=a.project_id::text AND NEW.intent->>'generation'=a.generation::text
            AND NEW.intent->>'preparationID'=p.preparation_id::text
            AND NEW.intent->>'atespaceUID'=p.atespace#>>'{metadata,uid}'
            AND NEW.intent->>'templateUID'=p.template#>>'{metadata,uid}'
            AND NEW.intent->>'templateVersion'=p.template#>>'{metadata,version}'
            AND NEW.intent->>'templateSHA256'=p.intent->>'templateSHA256'
            AND NEW.intent->'environment'=p.intent->'environment')
        OR EXISTS(SELECT 1 FROM factory.substrate_isolated p
          WHERE p.runtime_attempt_id=a.id AND p.project_id=a.project_id AND p.generation=a.generation
            AND p.kind=a.isolated_kind::text AND a.workspace_id IS NULL AND a.change_id IS NULL AND a.verification_id IS NULL
            AND p.intent->>'revision'=a.revision AND p.intent->>'createdBy'=a.created_by::text
            AND p.atespace IS NOT NULL AND p.policy IS NOT NULL AND p.template IS NOT NULL
            AND NOT p.atespace_rejected AND NOT p.policy_rejected AND NOT p.template_rejected
            AND NEW.intent->>'projectID'=a.project_id::text AND NEW.intent->>'generation'=a.generation::text
            AND NEW.intent->>'isolatedID'=p.owner_id::text AND NEW.intent->>'isolatedKind'=p.kind
            AND (NEW.intent->>'promotionID') IS NOT DISTINCT FROM p.intent->>'promotionID'
            AND NEW.intent->>'atespaceUID'=p.atespace#>>'{metadata,uid}'
            AND NEW.intent->>'templateUID'=p.template#>>'{metadata,uid}'
            AND NEW.intent->>'templateVersion'=p.template#>>'{metadata,version}'
            AND NEW.intent->>'templateSHA256'=p.intent->>'templateSHA256'
            AND NEW.intent->'environment'=p.intent->'environment'))
      AND NEW.atespace='fa-'||replace(a.id::text,'-','')
      AND NEW.actor_name='runtime-'||replace(a.id::text,'-',''))
      THEN RAISE EXCEPTION 'Native binding requires deterministic active Attempt intent'; END IF;
  ELSIF ROW(NEW.runtime_attempt_id,NEW.atespace,NEW.actor_name,NEW.intent)
      IS DISTINCT FROM ROW(OLD.runtime_attempt_id,OLD.atespace,OLD.actor_name,OLD.intent)
    OR (OLD.actor_uid IS NOT NULL AND NEW.actor_uid IS DISTINCT FROM OLD.actor_uid)
    OR (OLD.create_attempted_at IS NOT NULL AND NEW.create_attempted_at IS DISTINCT FROM OLD.create_attempted_at)
    OR (OLD.create_rejected AND NOT NEW.create_rejected)
    OR (OLD.delete_intended_at IS NOT NULL AND NEW.delete_intended_at IS DISTINCT FROM OLD.delete_intended_at)
    OR (OLD.deleted_at IS NOT NULL AND NEW IS DISTINCT FROM OLD)
    THEN RAISE EXCEPTION 'Native binding identity and dispatch facts are immutable'; END IF;
  RETURN NEW;
END $$;


--
-- Name: protect_substrate_isolated(); Type: FUNCTION; Schema: factory; Owner: -
--

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
              WHERE predecessor.id=preview.runtime_attempt_id AND predecessor.substrate
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


--
-- Name: protect_substrate_prebuild(); Type: FUNCTION; Schema: factory; Owner: -
--

CREATE FUNCTION factory.protect_substrate_prebuild() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE raw bytea;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Native prebuild provisioning names cannot be reused'; END IF;
  IF TG_OP='INSERT' THEN
    raw:=digest(NEW.preparation_id::text||':'||NEW.generation::text,'sha256');
    raw:=set_byte(raw,6,(get_byte(raw,6)&15)|80);
    raw:=set_byte(raw,8,(get_byte(raw,8)&63)|128);
    IF NEW.runtime_attempt_id<>encode(substring(raw from 1 for 16),'hex')::uuid
      OR NOT EXISTS(SELECT 1 FROM factory.project_image_preparation p JOIN factory.project project ON project.id=p.project_id
        LEFT JOIN factory.project_environment environment ON environment.project_id=p.project_id AND environment.environment=p.environment
        WHERE p.id=NEW.preparation_id AND p.runtime_attempt_id IS NULL AND p.state='pending'
          AND NEW.intent#>>'{configuration,projectID}'=p.project_id::text
          AND NEW.intent#>>'{configuration,database}'=current_database()
          AND NEW.intent->>'revision'=p.revision AND NEW.intent->>'repository'=project.repository_url
          AND NEW.intent#>>'{environment,environment}'=p.environment
          AND NEW.intent#>>'{environment,version}'=p.environment_version::text
          AND p.environment_version=COALESCE(environment.version,0)
          AND (NEW.intent#>>'{environment,secretKey}') IS NOT DISTINCT FROM environment.secret_key
          AND EXISTS(SELECT 1 FROM factory.environment_write publication_grant
            WHERE publication_grant.project_id=p.project_id AND publication_grant.environment=p.environment
              AND publication_grant.secret_key=environment.secret_key AND publication_grant.base_version+1=p.environment_version
              AND publication_grant.state='committed' AND publication_grant.manifest @> jsonb_build_object('registries',jsonb_build_array(
                jsonb_build_object('host',NEW.intent#>>'{configuration,prebuildRegistry}','hasPassword',true))))
          AND NEW.intent->>'imageRepository'=NEW.intent#>>'{configuration,prebuildRegistry}'||'/open-factory/prebuilds/'||p.project_id::text
          AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt a WHERE a.id=NEW.runtime_attempt_id))
      THEN RAISE EXCEPTION 'Native prebuild requires deterministic fresh exact-input intent'; END IF;
  ELSIF ROW(NEW.preparation_id,NEW.runtime_attempt_id,NEW.generation,NEW.intent)
      IS DISTINCT FROM ROW(OLD.preparation_id,OLD.runtime_attempt_id,OLD.generation,OLD.intent)
    OR (OLD.atespace_attempted_at IS NOT NULL AND NEW.atespace_attempted_at IS DISTINCT FROM OLD.atespace_attempted_at)
    OR (OLD.policy_attempted_at IS NOT NULL AND NEW.policy_attempted_at IS DISTINCT FROM OLD.policy_attempted_at)
    OR (OLD.template_attempted_at IS NOT NULL AND NEW.template_attempted_at IS DISTINCT FROM OLD.template_attempted_at)
    OR (OLD.atespace IS NOT NULL AND NEW.atespace IS DISTINCT FROM OLD.atespace)
    OR (OLD.policy IS NOT NULL AND NEW.policy IS DISTINCT FROM OLD.policy)
    OR (OLD.template IS NOT NULL AND NEW.template IS DISTINCT FROM OLD.template)
    OR (OLD.atespace_rejected AND NOT NEW.atespace_rejected)
    OR (OLD.policy_rejected AND NOT NEW.policy_rejected)
    OR (OLD.template_rejected AND NOT NEW.template_rejected)
    THEN RAISE EXCEPTION 'Native prebuild provisioning identity and dispatch facts are immutable';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: protect_substrate_source(); Type: FUNCTION; Schema: factory; Owner: -
--

CREATE FUNCTION factory.protect_substrate_source() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Source ownership and checkpoints cannot be discarded'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.owner<>'actor' OR NEW.writer_epoch<>1 OR NOT NEW.writable OR NEW.generation<>0
      OR NOT EXISTS(SELECT 1 FROM factory.runtime_attempt a JOIN factory.substrate_binding b ON b.runtime_attempt_id=a.id
        WHERE a.workspace_id=NEW.workspace_id AND a.substrate AND b.actor_uid=NEW.actor_uid
          AND b.delete_intended_at IS NULL AND b.deleted_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt n WHERE n.workspace_id=a.workspace_id AND n.generation>a.generation))
      THEN RAISE EXCEPTION 'Source requires its current original Actor binding'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.writer_epoch<OLD.writer_epoch OR NEW.writer_epoch>OLD.writer_epoch+1
    OR NEW.generation<OLD.generation OR NEW.generation>OLD.generation+1
    THEN RAISE EXCEPTION 'Source identity/epoch/generation changed'; END IF;
  IF NEW.actor_uid IS DISTINCT FROM OLD.actor_uid THEN
    IF OLD.owner<>'service' OR NEW.owner<>'actor' OR OLD.writable OR NOT NEW.writable
      OR NOT EXISTS(
        SELECT 1 FROM factory.runtime_attempt predecessor
        JOIN factory.substrate_binding old_binding ON old_binding.runtime_attempt_id=predecessor.id
        JOIN factory.runtime_attempt current ON current.workspace_id=predecessor.workspace_id
          AND current.generation=predecessor.generation+1
        JOIN factory.substrate_binding new_binding ON new_binding.runtime_attempt_id=current.id
        JOIN factory.substrate_workspace provision ON provision.workspace_id=current.workspace_id AND provision.generation=current.generation
        WHERE predecessor.workspace_id=NEW.workspace_id AND predecessor.state='stopped'
          AND old_binding.actor_uid=OLD.actor_uid AND old_binding.deleted_at IS NOT NULL
          AND current.substrate AND current.state='create-intended' AND current.stop_intended_at IS NULL
          AND new_binding.actor_uid=NEW.actor_uid AND NOT new_binding.create_rejected
          AND new_binding.create_attempted_at IS NOT NULL
          AND new_binding.delete_intended_at IS NULL AND new_binding.deleted_at IS NULL
          AND new_binding.intent->>'workspaceID'=NEW.workspace_id::text
          AND new_binding.intent->>'generation'=current.generation::text
          AND new_binding.intent->>'atespaceUID'=provision.atespace#>>'{metadata,uid}'
          AND new_binding.intent->>'templateUID'=provision.template#>>'{metadata,uid}'
          AND new_binding.intent->>'templateVersion'=provision.template#>>'{metadata,version}'
          AND new_binding.intent->>'templateSHA256'=provision.intent->>'templateSHA256'
          AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt newer WHERE newer.workspace_id=current.workspace_id AND newer.generation>current.generation))
      THEN RAISE EXCEPTION 'Source Actor transfer requires its confirmed stopped predecessor and current native successor'; END IF;
  END IF;
  IF NEW.generation<>OLD.generation THEN
    IF NEW.writable OR NEW.owner<>OLD.owner OR NEW.writer_epoch<>OLD.writer_epoch
      OR NEW.checkpoint_id IS DISTINCT FROM OLD.checkpoint_id
      OR NEW.checkpoint->>'id' IS DISTINCT FROM NEW.checkpoint_id::text
      OR NEW.checkpoint->>'workspaceID' IS DISTINCT FROM NEW.workspace_id::text
      OR NEW.checkpoint->>'actorUID' IS DISTINCT FROM NEW.actor_uid::text
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
    IF NEW.actor_uid=OLD.actor_uid AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt a JOIN factory.substrate_binding b ON b.runtime_attempt_id=a.id
      WHERE a.workspace_id=NEW.workspace_id AND a.state='paused' AND b.actor_uid=NEW.actor_uid
        AND b.checkpoint->>'actorUID'=NEW.actor_uid::text
        AND b.checkpoint->>'fidelity'='SNAPSHOT_FIDELITY_ROOTFS'
        AND b.checkpoint#>>'{durableSnapshot,state}'='SNAPSHOT_STORAGE_STATE_COMPLETED'
        AND b.observation#>>'{status,state}'='ACTOR_STATE_SUSPENDED'
        AND b.checkpoint->>'generation'=b.observation#>>'{status,lastAssignedGeneration}')
      THEN RAISE EXCEPTION 'Source transfer requires the original durable paused ROOTFS'; END IF;
  ELSIF NEW.writable IS DISTINCT FROM OLD.writable THEN
    IF NOT OLD.writable OR NEW.writable OR NEW.writer_epoch<>OLD.writer_epoch+1 OR NEW.checkpoint_id IS NULL
      THEN RAISE EXCEPTION 'Source freeze must advance the writer epoch'; END IF;
  ELSIF ROW(NEW.writer_epoch,NEW.checkpoint_id,NEW.service_base) IS DISTINCT FROM ROW(OLD.writer_epoch,OLD.checkpoint_id,OLD.service_base) THEN
    RAISE EXCEPTION 'Source lease facts cannot change outside freeze/transfer';
  END IF;
  IF NEW.owner=OLD.owner AND NEW.service_base IS DISTINCT FROM OLD.service_base THEN
    RAISE EXCEPTION 'Source service base is immutable for its ownership interval'; END IF;
  RETURN NEW;
END $$;


--
-- Name: protect_substrate_verification(); Type: FUNCTION; Schema: factory; Owner: -
--

CREATE FUNCTION factory.protect_substrate_verification() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE raw bytea;
  predecessor factory.substrate_verification;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Native Verification provisioning names cannot be reused'; END IF;
  IF TG_OP='INSERT' THEN
    raw:=digest(NEW.verification_id::text||':'||NEW.generation::text,'sha256');
    raw:=set_byte(raw,6,(get_byte(raw,6)&15)|80);
    raw:=set_byte(raw,8,(get_byte(raw,8)&63)|128);
    SELECT * INTO predecessor FROM factory.substrate_verification
      WHERE verification_id=NEW.verification_id ORDER BY generation DESC LIMIT 1;
    IF (predecessor.runtime_attempt_id IS NULL AND NEW.generation<>1)
      OR (predecessor.runtime_attempt_id IS NOT NULL AND (
        NEW.generation<>predecessor.generation+1 OR NOT EXISTS(
          SELECT 1 FROM factory.runtime_attempt a JOIN factory.substrate_binding b ON b.runtime_attempt_id=a.id
          JOIN factory.verification v ON v.id=NEW.verification_id
          JOIN factory.execution_policy_command decision ON decision.scope='checks-bootstrap-retry:'||v.change_id::text
          WHERE a.id=predecessor.runtime_attempt_id AND a.verification_id=v.id AND a.substrate
            AND a.state='stopped' AND b.deleted_at IS NOT NULL
            AND decision.input->>'verificationID'=v.id::text
            AND decision.input->>'runtimeAttemptID'=a.id::text
            AND decision.result->>'runtimeAttemptID'=a.id::text
            AND decision.result->>'state'='failed')))
      THEN RAISE EXCEPTION 'Native Verification successor requires exact cleanup and an explicit bootstrap retry decision'; END IF;
    IF NEW.runtime_attempt_id<>encode(substring(raw from 1 for 16),'hex')::uuid
      OR NOT EXISTS(SELECT 1 FROM factory.verification v JOIN factory.change c ON c.id=v.change_id
        JOIN factory.ticket t ON t.id=c.ticket_id
        WHERE v.id=NEW.verification_id AND v.runtime_attempt_id IS NULL
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
  ELSIF ROW(NEW.verification_id,NEW.runtime_attempt_id,NEW.generation,NEW.intent)
      IS DISTINCT FROM ROW(OLD.verification_id,OLD.runtime_attempt_id,OLD.generation,OLD.intent)
    OR (OLD.atespace_attempted_at IS NOT NULL AND NEW.atespace_attempted_at IS DISTINCT FROM OLD.atespace_attempted_at)
    OR (OLD.policy_attempted_at IS NOT NULL AND NEW.policy_attempted_at IS DISTINCT FROM OLD.policy_attempted_at)
    OR (OLD.template_attempted_at IS NOT NULL AND NEW.template_attempted_at IS DISTINCT FROM OLD.template_attempted_at)
    OR (OLD.atespace IS NOT NULL AND NEW.atespace IS DISTINCT FROM OLD.atespace)
    OR (OLD.policy IS NOT NULL AND NEW.policy IS DISTINCT FROM OLD.policy)
    OR (OLD.template IS NOT NULL AND NEW.template IS DISTINCT FROM OLD.template)
    OR (OLD.atespace_rejected AND NOT NEW.atespace_rejected)
    OR (OLD.policy_rejected AND NOT NEW.policy_rejected)
    OR (OLD.template_rejected AND NOT NEW.template_rejected)
    THEN RAISE EXCEPTION 'Native Verification provisioning identity and dispatch facts are immutable';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: protect_substrate_worker_capacity(); Type: FUNCTION; Schema: factory; Owner: -
--

CREATE FUNCTION factory.protect_substrate_worker_capacity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Native worker capacity names cannot be reused'; END IF;
  IF TG_OP='INSERT' AND (
    NEW.intent->>'database' IS DISTINCT FROM current_database()
    OR NEW.intent#>>'{node,uid}' IS DISTINCT FROM NEW.node_uid::text
    OR NEW.intent#>>'{pool,metadata,name}' IS DISTINCT FROM 'factory-native-'||substring(encode(digest(NEW.owner||':'||NEW.node_uid::text,'sha256'),'hex') from 1 for 32)
    OR NEW.intent#>>'{pool,metadata,labels,factory.dev/native-capacity}' IS DISTINCT FROM NEW.owner
    OR NEW.intent#>>'{pool,metadata,annotations,factory.dev/creation-intent}' IS NULL)
    THEN RAISE EXCEPTION 'Native worker capacity requires deterministic installation and node intent'; END IF;
  IF TG_OP='UPDATE' AND (
    ROW(NEW.owner,NEW.node_uid,NEW.intent) IS DISTINCT FROM ROW(OLD.owner,OLD.node_uid,OLD.intent)
    OR (OLD.attempted_at IS NOT NULL AND NEW.attempted_at IS DISTINCT FROM OLD.attempted_at)
    OR (OLD.rejected AND NOT NEW.rejected)
    OR (OLD.pool IS NOT NULL AND NEW.pool IS DISTINCT FROM OLD.pool))
    THEN RAISE EXCEPTION 'Native worker capacity intent and creation facts are immutable'; END IF;
  RETURN NEW;
END $$;


--
-- Name: protect_substrate_workspace(); Type: FUNCTION; Schema: factory; Owner: -
--

CREATE FUNCTION factory.protect_substrate_workspace() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE previous_generation bigint;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Native Workspace provisioning names cannot be reused'; END IF;
  IF TG_OP='INSERT' THEN
    SELECT max(generation) INTO previous_generation FROM factory.substrate_workspace
      WHERE workspace_id=NEW.workspace_id;
    IF (previous_generation IS NULL AND NEW.generation<>1)
      OR (previous_generation IS NOT NULL AND (
        NEW.generation<>previous_generation+1 OR NOT EXISTS(
          SELECT 1 FROM factory.runtime_attempt a JOIN factory.substrate_binding b ON b.runtime_attempt_id=a.id
          JOIN factory.substrate_source s ON s.workspace_id=a.workspace_id AND s.actor_uid=b.actor_uid
          WHERE a.workspace_id=NEW.workspace_id AND a.generation=previous_generation
            AND a.substrate AND a.state='stopped' AND b.deleted_at IS NOT NULL
            AND s.owner='service' AND s.writable AND s.checkpoint IS NOT NULL)))
      THEN RAISE EXCEPTION 'Native Workspace successor requires exact cleanup and independent Source'; END IF;
    IF NOT EXISTS(SELECT 1 FROM factory.development_workspace w WHERE w.id=NEW.workspace_id
      AND w.substrate
      AND (w.kind='personal' OR EXISTS (
        SELECT 1 FROM factory.change c JOIN factory.ticket t ON t.id=c.ticket_id
        JOIN factory.branch_create_operation b ON b.change_id=c.id
        WHERE c.id=w.change_id AND c.ticket_id=w.ticket_id AND c.project_id=w.project_id
          AND c.cancel_requested_at IS NULL AND c.state IN ('starting','active','failed')
          AND t.trashed_at IS NULL AND b.state='succeeded' AND b.observed_head_sha=c.base_sha
          AND w.source_revision=c.base_sha AND w.source_branch=c.branch_name))
      AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt a WHERE a.workspace_id=w.id AND a.generation>=NEW.generation))
      THEN RAISE EXCEPTION 'Native provisioning requires a fresh personal or approved Ticket Workspace'; END IF;
  ELSIF ROW(NEW.workspace_id,NEW.generation,NEW.intent) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.generation,OLD.intent)
    OR (OLD.atespace_attempted_at IS NOT NULL AND NEW.atespace_attempted_at IS DISTINCT FROM OLD.atespace_attempted_at)
    OR (OLD.policy_attempted_at IS NOT NULL AND NEW.policy_attempted_at IS DISTINCT FROM OLD.policy_attempted_at)
    OR (OLD.template_attempted_at IS NOT NULL AND NEW.template_attempted_at IS DISTINCT FROM OLD.template_attempted_at)
    OR (OLD.atespace IS NOT NULL AND NEW.atespace IS DISTINCT FROM OLD.atespace)
    OR (OLD.policy IS NOT NULL AND NEW.policy IS DISTINCT FROM OLD.policy)
    OR (OLD.template IS NOT NULL AND NEW.template IS DISTINCT FROM OLD.template)
    OR (OLD.atespace_rejected AND NOT NEW.atespace_rejected)
    OR (OLD.policy_rejected AND NOT NEW.policy_rejected)
    OR (OLD.template_rejected AND NOT NEW.template_rejected)
    THEN RAISE EXCEPTION 'Native provisioning identity and dispatch facts are immutable';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: protect_verification_job_binding(); Type: FUNCTION; Schema: factory; Owner: -
--

CREATE FUNCTION factory.protect_verification_job_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.runner_job_handle IS NOT NULL AND
    (NEW.runner_job_handle IS DISTINCT FROM OLD.runner_job_handle OR
      NEW.action_run_id IS DISTINCT FROM OLD.action_run_id OR NEW.commit_sha<>OLD.commit_sha)
    THEN RAISE EXCEPTION 'Verification native job binding is immutable'; END IF;
  IF OLD.runner_job_handle IS NULL AND NEW.runner_job_handle IS NOT NULL AND EXISTS(
    SELECT 1 FROM factory.substrate_binding b
    WHERE b.runtime_attempt_id=OLD.runtime_attempt_id AND b.create_attempted_at IS NOT NULL)
    THEN RAISE EXCEPTION 'Cannot change a dispatched Verification runner'; END IF;
  RETURN NEW;
END $$;


--
-- Name: protect_workspace_runtime_binding(); Type: FUNCTION; Schema: factory; Owner: -
--

CREATE FUNCTION factory.protect_workspace_runtime_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.substrate IS DISTINCT FROM OLD.substrate THEN
    RAISE EXCEPTION 'Workspace runtime identity is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION factory.protect_workspace_submission() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS(
      SELECT 1 FROM factory.change_commit_operation operation
      JOIN factory.runtime_attempt attempt ON attempt.id=operation.runtime_attempt_id
      JOIN factory.development_workspace workspace ON workspace.id=attempt.workspace_id
      JOIN factory.change_writer writer ON writer.change_id=operation.change_id
      JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=attempt.id
      WHERE operation.id=NEW.id AND operation.source='workspace' AND operation.state='commit-intended'
        AND operation.created_by=NEW.actor_id AND workspace.id=NEW.workspace_id
        AND workspace.kind='ticket' AND workspace.change_id=operation.change_id
        AND writer.state='unassigned' AND writer.epoch=NEW.writer_epoch
        AND attempt.state='ready' AND attempt.stop_intended_at IS NULL
        AND binding.delete_intended_at IS NULL AND binding.deleted_at IS NULL)
      THEN RAISE EXCEPTION 'Workspace submission requires its matching ready native commit intent'; END IF;
  ELSIF ROW(NEW.id,NEW.workspace_id,NEW.actor_id,NEW.writer_epoch,NEW.remote_head,NEW.repository_url,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.actor_id,OLD.writer_epoch,OLD.remote_head,OLD.repository_url,OLD.created_at)
    OR (OLD.prepare_attempted_at IS NOT NULL AND NEW.prepare_attempted_at IS DISTINCT FROM OLD.prepare_attempted_at)
    THEN RAISE EXCEPTION 'Workspace submission identity and dispatch facts are immutable';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: reject_mutation(); Type: FUNCTION; Schema: factory; Owner: -
--

CREATE FUNCTION factory.reject_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME;
END;
$$;


--
-- Name: require_installation_admission(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: require_substrate_binding(); Type: FUNCTION; Schema: factory; Owner: -
--

CREATE FUNCTION factory.require_substrate_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.substrate IS DISTINCT FROM OLD.substrate
    THEN RAISE EXCEPTION 'Runtime engine identity is immutable'; END IF;
  IF NEW.substrate AND NOT EXISTS(SELECT 1 FROM factory.substrate_binding b WHERE b.runtime_attempt_id=NEW.id AND (
    EXISTS(SELECT 1 FROM factory.development_workspace w WHERE w.id=NEW.workspace_id AND w.substrate
      AND w.project_id=NEW.project_id AND w.change_id IS NOT DISTINCT FROM NEW.change_id)
    OR EXISTS(SELECT 1 FROM factory.substrate_verification p JOIN factory.verification v ON v.id=p.verification_id
      JOIN factory.change c ON c.id=v.change_id
      WHERE p.runtime_attempt_id=NEW.id AND p.verification_id=NEW.verification_id
        AND p.generation=NEW.generation AND c.project_id=NEW.project_id AND v.commit_sha=NEW.revision
        AND NEW.workspace_id IS NULL AND NEW.change_id IS NULL AND NEW.isolated_kind='verification'
        AND b.intent->>'verificationID'=p.verification_id::text)
    OR EXISTS(SELECT 1 FROM factory.substrate_prebuild p JOIN factory.project_image_preparation preparation ON preparation.id=p.preparation_id
      WHERE p.runtime_attempt_id=NEW.id AND p.generation=NEW.generation AND preparation.runtime_attempt_id=NEW.id
        AND preparation.project_id=NEW.project_id AND preparation.revision=NEW.revision
        AND NEW.workspace_id IS NULL AND NEW.change_id IS NULL AND NEW.isolated_kind='prebuild'
        AND b.intent->>'preparationID'=p.preparation_id::text)
    OR EXISTS(SELECT 1 FROM factory.substrate_isolated p
      WHERE p.runtime_attempt_id=NEW.id AND p.project_id=NEW.project_id AND p.generation=NEW.generation
        AND NEW.workspace_id IS NULL AND NEW.change_id IS NULL AND NEW.verification_id IS NULL
        AND p.kind=NEW.isolated_kind::text AND p.intent->>'revision'=NEW.revision
        AND b.intent->>'isolatedID'=p.owner_id::text AND b.intent->>'isolatedKind'=p.kind)))
    THEN RAISE EXCEPTION 'Native Attempt requires its persisted matching owner binding'; END IF;
  RETURN NULL;
END $$;


--
-- Name: require_ticket_execution_revision(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: require_untrashed_ticket(); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: research_vector(text, text); Type: FUNCTION; Schema: factory; Owner: -
--

CREATE FUNCTION factory.research_vector(title text, body text) RETURNS tsvector
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
    SELECT setweight(to_tsvector('simple',coalesce(title,'')),'A') ||
      setweight(to_tsvector('simple',coalesce(body,'')),'B');
  $$;


--
-- Name: ticket_prerequisites(uuid, uuid); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: touch_read_version(uuid, text, uuid, text); Type: FUNCTION; Schema: factory; Owner: -
--

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


--
-- Name: validate_ticket_conversation_project(); Type: FUNCTION; Schema: factory; Owner: -
--

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


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account; Type: TABLE; Schema: auth; Owner: -
--

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


--
-- Name: jwks; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.jwks (
    id text NOT NULL,
    "publicKey" text NOT NULL,
    "privateKey" text NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "expiresAt" timestamp with time zone,
    alg text,
    crv text
);


--
-- Name: oauthAccessToken; Type: TABLE; Schema: auth; Owner: -
--

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


--
-- Name: oauthClient; Type: TABLE; Schema: auth; Owner: -
--

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


--
-- Name: oauthClientAssertion; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth."oauthClientAssertion" (
    id text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL
);


--
-- Name: oauthClientResource; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth."oauthClientResource" (
    id text NOT NULL,
    "clientId" text NOT NULL,
    "resourceId" text NOT NULL,
    metadata jsonb,
    "createdAt" timestamp with time zone
);


--
-- Name: oauthConsent; Type: TABLE; Schema: auth; Owner: -
--

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


--
-- Name: oauthRefreshToken; Type: TABLE; Schema: auth; Owner: -
--

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


--
-- Name: oauthResource; Type: TABLE; Schema: auth; Owner: -
--

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


--
-- Name: scimConnectionBinding; Type: TABLE; Schema: auth; Owner: -
--

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


--
-- Name: scimGroup; Type: TABLE; Schema: auth; Owner: -
--

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


--
-- Name: scimGroupMember; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth."scimGroupMember" (
    id text NOT NULL,
    "connectionId" text NOT NULL,
    "groupId" text NOT NULL,
    "scimUserId" text NOT NULL,
    "membershipKey" text NOT NULL,
    "createdAt" timestamp with time zone NOT NULL
);


--
-- Name: scimIdentityTombstone; Type: TABLE; Schema: auth; Owner: -
--

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


--
-- Name: scimProjectionGrant; Type: TABLE; Schema: auth; Owner: -
--

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


--
-- Name: scimSubject; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth."scimSubject" (
    id text NOT NULL,
    "userId" uuid NOT NULL,
    "profileSourceId" text,
    revision integer NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


--
-- Name: scimUser; Type: TABLE; Schema: auth; Owner: -
--

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


--
-- Name: session; Type: TABLE; Schema: auth; Owner: -
--

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


--
-- Name: ssoProvider; Type: TABLE; Schema: auth; Owner: -
--

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


--
-- Name: user; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth."user" (
    id uuid NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    image text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: verification; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.verification (
    id uuid NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: access_revocation; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.access_revocation (
    user_id uuid NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    processed_version bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT access_revocation_check CHECK (((processed_version >= 0) AND (processed_version <= version)))
);


--
-- Name: account_access; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.account_access (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    disabled_at timestamp with time zone,
    directory_disabled_at timestamp with time zone,
    disabled_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: administrator; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.administrator (
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_turn; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: agent_turn_mcp; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.agent_turn_mcp (
    turn_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    credential_epoch uuid NOT NULL,
    revision_id uuid NOT NULL,
    policy_version bigint NOT NULL,
    tools jsonb NOT NULL,
    required boolean NOT NULL
);


--
-- Name: agent_turn_skill; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.agent_turn_skill (
    turn_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    loaded_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: attachment; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: attachment_draft; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.attachment_draft (
    id uuid NOT NULL,
    owner_id uuid NOT NULL,
    project_id uuid NOT NULL,
    sequence bigint NOT NULL,
    attachment_ids uuid[] NOT NULL,
    CONSTRAINT attachment_draft_sequence_check CHECK ((sequence >= 0))
);


--
-- Name: attachment_reference; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.attachment_reference (
    attachment_id uuid NOT NULL,
    kind text NOT NULL,
    reference_id uuid NOT NULL,
    shared boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT attachment_reference_kind_check CHECK ((kind = ANY (ARRAY['ticket'::text, 'requirement'::text, 'knowledge'::text, 'conversation'::text, 'feedback'::text, 'turn'::text])))
);


--
-- Name: attachment_storage; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.attachment_storage (
    singleton boolean DEFAULT true NOT NULL,
    id uuid NOT NULL,
    CONSTRAINT attachment_storage_singleton_check CHECK (singleton)
);


--
-- Name: attachment_turn_context; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.attachment_turn_context (
    turn_id uuid NOT NULL,
    source text DEFAULT 'admission'::text NOT NULL,
    content text NOT NULL
);


--
-- Name: branch_create_operation; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: build_browser_session; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: candidate_review; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.candidate_review (
    id uuid NOT NULL,
    verification_id uuid NOT NULL,
    ordinal integer DEFAULT 1 NOT NULL,
    supersedes_id uuid,
    finding_source_id uuid,
    focus_review_id uuid,
    finding_checks jsonb,
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
    CONSTRAINT candidate_review_finding_checks_check CHECK (((finding_checks IS NULL) OR ((finding_source_id IS NOT NULL) AND (jsonb_typeof(finding_checks) = 'object'::text) AND (octet_length((finding_checks)::text) <= 32768)))),
    CONSTRAINT candidate_review_ordinal_check CHECK ((ordinal > 0)),
    CONSTRAINT candidate_review_result_check CHECK (((result IS NULL) OR ((jsonb_typeof(result) = 'object'::text) AND (octet_length((result)::text) <= 32768)))),
    CONSTRAINT candidate_review_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'running'::text, 'passed'::text, 'changes-requested'::text, 'incomplete'::text])))
);


--
-- Name: change; Type: TABLE; Schema: factory; Owner: -
--

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
    delivery_waiting_sha text,
    delivery_waiting_policy_id uuid,
    CONSTRAINT change_base_sha_check CHECK ((base_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text)),
    CONSTRAINT change_branch_name_check CHECK ((branch_name ~ '^factory/change-[0-9a-f]{12}$'::text)),
    CONSTRAINT change_check CHECK (((state = 'cancelled'::factory.change_state) = (cancelled_at IS NOT NULL))),
    CONSTRAINT change_version_check CHECK ((version > 0))
);


--
-- Name: change_agent_session; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: change_agent_turn_intent; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: change_commit_operation; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.change_commit_operation (
    id uuid NOT NULL,
    change_id uuid NOT NULL,
    runtime_attempt_id uuid,
    sequence integer NOT NULL,
    branch_name text NOT NULL,
    expected_parent_sha text NOT NULL,
    integration_base_sha text,
    merge_parent_sha text,
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
    CONSTRAINT change_commit_integration_base CHECK (((integration_base_sha IS NULL) OR (integration_base_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text))),
    CONSTRAINT change_commit_merge_parent CHECK (((merge_parent_sha IS NULL) OR ((merge_parent_sha = integration_base_sha) AND (merge_parent_sha <> expected_parent_sha)))),
    CONSTRAINT change_commit_operation_check CHECK (((state = ANY (ARRAY['succeeded'::factory.change_commit_state, 'failed'::factory.change_commit_state])) = (completed_at IS NOT NULL))),
    CONSTRAINT change_commit_operation_check2 CHECK (((state <> 'succeeded'::factory.change_commit_state) OR (observed_remote_sha = commit_sha))),
    CONSTRAINT change_commit_operation_commit_message_check CHECK (((length(btrim(commit_message)) >= 1) AND (length(btrim(commit_message)) <= 240))),
    CONSTRAINT change_commit_operation_commit_presence_check CHECK (((state <> ALL (ARRAY['committed'::factory.change_commit_state, 'push-intended'::factory.change_commit_state, 'succeeded'::factory.change_commit_state])) OR (commit_sha IS NOT NULL) OR ((source = 'repository-document'::factory.change_commit_source) AND (state = 'push-intended'::factory.change_commit_state)))),
    CONSTRAINT change_commit_operation_commit_sha_check CHECK (((commit_sha IS NULL) OR (commit_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text))),
    CONSTRAINT change_commit_operation_expected_parent_sha_check CHECK ((expected_parent_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text)),
    CONSTRAINT change_commit_operation_observed_remote_sha_check CHECK (((observed_remote_sha IS NULL) OR (observed_remote_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text))),
    CONSTRAINT change_commit_operation_sequence_check CHECK ((sequence > 0)),
    CONSTRAINT change_commit_operation_source_check CHECK (((((source)::text = ANY (ARRAY['agent'::text, 'integration'::text, 'workspace'::text])) AND (runtime_attempt_id IS NOT NULL) AND (repository_path IS NULL) AND (repository_blob_sha IS NULL) AND (repository_content IS NULL) AND (content_digest IS NULL)) OR (((source)::text = 'repository-document'::text) AND (runtime_attempt_id IS NULL) AND (repository_path IS NOT NULL) AND (repository_blob_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text) AND (repository_content IS NOT NULL) AND (content_digest ~ '^[0-9a-f]{64}$'::text))))
);


--
-- Name: change_editing_decision; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: change_editing_request; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: change_writer; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: coding_pause; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.coding_pause (
    turn_id uuid NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resumed_by_turn_id uuid,
    CONSTRAINT coding_pause_reason_check CHECK ((reason = ANY (ARRAY['accounting-incomplete'::text, 'coding-budget-used'::text, 'finish-reserve-used'::text])))
);


--
-- Name: conversation_context; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: conversation_entry; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: promotion_operation; Type: TABLE; Schema: factory; Owner: -
--

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
    ordinal integer DEFAULT 1 NOT NULL,
    supersedes_id uuid,
    retry_command_id uuid,
    CONSTRAINT promotion_operation_check CHECK (((state = ANY (ARRAY['succeeded'::factory.promotion_operation_state, 'failed'::factory.promotion_operation_state])) = (completed_at IS NOT NULL))),
    CONSTRAINT promotion_operation_commit_sha_check CHECK ((commit_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text)),
    CONSTRAINT promotion_operation_ordinal_check CHECK ((ordinal > 0)),
    CONSTRAINT promotion_operation_retry_identity CHECK ((((ordinal = 1) AND (supersedes_id IS NULL) AND (retry_command_id IS NULL)) OR ((ordinal > 1) AND (supersedes_id IS NOT NULL) AND (retry_command_id = id))))
);


--
-- Name: current_promotion; Type: VIEW; Schema: factory; Owner: -
--

CREATE VIEW factory.current_promotion WITH (security_invoker='true') AS
 SELECT DISTINCT ON (change_id) id,
    change_id,
    project_id,
    commit_sha,
    previous_runtime_attempt_id,
    replacement_runtime_attempt_id,
    state,
    last_error,
    requested_at,
    updated_at,
    completed_at,
    ordinal,
    supersedes_id,
    retry_command_id
   FROM factory.promotion_operation
  ORDER BY change_id, ordinal DESC;


--
-- Name: delivery_approval; Type: TABLE; Schema: factory; Owner: -
--

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
    delivery_policy_id uuid,
    CONSTRAINT delivery_approval_commit_sha_check CHECK ((commit_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text)),
    CONSTRAINT delivery_monitoring_basis CHECK (((monitoring_incident_id IS NULL) = (monitoring_policy_id IS NULL))),
    CONSTRAINT delivery_one_delegation CHECK (((delivery_policy_id IS NULL) OR (monitoring_policy_id IS NULL)))
);


--
-- Name: developer_ide; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: development_workspace; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.development_workspace (
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    kind factory.development_workspace_kind NOT NULL,
    owner_user_id uuid,
    ticket_id uuid,
    change_id uuid,
    source_branch text NOT NULL,
    source_revision text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    substrate boolean DEFAULT true NOT NULL,
    collaboration_enabled boolean DEFAULT false NOT NULL,
    CONSTRAINT development_workspace_check CHECK ((((kind = 'personal'::factory.development_workspace_kind) AND (owner_user_id IS NOT NULL) AND (ticket_id IS NULL) AND (change_id IS NULL)) OR ((kind = 'ticket'::factory.development_workspace_kind) AND (owner_user_id IS NULL) AND (ticket_id IS NOT NULL) AND (change_id IS NOT NULL)))),
    CONSTRAINT development_workspace_native_only CHECK (substrate),
    CONSTRAINT development_workspace_source_branch_check CHECK (((length(source_branch) >= 1) AND (length(source_branch) <= 200))),
    CONSTRAINT development_workspace_source_revision_check CHECK ((source_revision ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text))
);


--
-- Name: environment_write; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: epic; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: epic_confirmation; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: execution_policy; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: execution_policy_command; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.execution_policy_command (
    command_id uuid NOT NULL,
    scope text NOT NULL,
    actor_id uuid NOT NULL,
    input jsonb NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: external_identity; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.external_identity (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    issuer text NOT NULL,
    subject text NOT NULL,
    user_id uuid NOT NULL,
    directory_subject text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: forge_account_intent; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: forge_branch_intent; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.forge_branch_intent (
    project_id uuid NOT NULL,
    branch text NOT NULL,
    writers text[] NOT NULL,
    merger text NOT NULL,
    confirmed boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: forge_connection; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: forge_grant_intent; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.forge_grant_intent (
    project_id uuid NOT NULL,
    user_id uuid NOT NULL,
    desired boolean NOT NULL,
    confirmed boolean,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: forge_identity_intent; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.forge_identity_intent (
    client_id text NOT NULL,
    redirect_uri text NOT NULL,
    intended_by uuid NOT NULL,
    state text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    observed_at timestamp with time zone,
    CONSTRAINT forge_identity_intent_state_check CHECK ((state = ANY (ARRAY['create-intended'::text, 'ready'::text])))
);


--
-- Name: identity_configuration; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.identity_configuration (
    singleton boolean DEFAULT true NOT NULL,
    version bigint NOT NULL,
    setup_id uuid NOT NULL,
    activated_by uuid NOT NULL,
    activated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT identity_configuration_singleton_check CHECK (singleton)
);


--
-- Name: identity_setup; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: implementation_order; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.implementation_order (
    command_id uuid NOT NULL,
    project_id uuid NOT NULL,
    ticket_id uuid NOT NULL,
    created_by uuid NOT NULL,
    requirement_revision_id uuid NOT NULL,
    technical_design_revision_id uuid,
    coding_reasoning text,
    source_sha text NOT NULL,
    state text DEFAULT 'waiting'::text NOT NULL,
    change_id uuid,
    cancelled_by uuid,
    cancelled_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT implementation_order_source_sha_check CHECK ((source_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text)),
    CONSTRAINT implementation_order_state_check CHECK ((state = ANY (ARRAY['waiting'::text, 'started'::text, 'blocked'::text, 'cancelled'::text])))
);


--
-- Name: inbox_receipt; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.inbox_receipt (
    user_id uuid NOT NULL,
    item_id text NOT NULL,
    seen_event_id text,
    archived boolean DEFAULT false NOT NULL
);


--
-- Name: installation_maintenance; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.installation_maintenance (
    singleton boolean DEFAULT true NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    requested_at timestamp with time zone,
    CONSTRAINT installation_maintenance_singleton_check CHECK (singleton)
);


--
-- Name: knowledge_generation; Type: TABLE; Schema: factory; Owner: -
--

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
    progress jsonb,
    CONSTRAINT knowledge_generation_check CHECK (((state = ANY (ARRAY['succeeded'::factory.knowledge_generation_state, 'failed'::factory.knowledge_generation_state])) = (completed_at IS NOT NULL))),
    CONSTRAINT knowledge_generation_conflict_count_check CHECK (((conflict_count IS NULL) OR (conflict_count >= 0))),
    CONSTRAINT knowledge_generation_failure_check CHECK (((failure IS NULL) OR (length(failure) <= 4000))),
    CONSTRAINT knowledge_generation_model_id_check CHECK (((model_id IS NULL) OR ((length(model_id) >= 1) AND (length(model_id) <= 200)))),
    CONSTRAINT knowledge_generation_page_count_check CHECK (((page_count IS NULL) OR (page_count >= 0))),
    CONSTRAINT knowledge_generation_progress_shape CHECK (((progress IS NULL) OR ((jsonb_typeof(progress) = 'object'::text) AND ((progress ->> 'phase'::text) = ANY (ARRAY['planning'::text, 'writing'::text, 'publishing'::text, 'done'::text])) AND (jsonb_typeof((progress -> 'topicsTotal'::text)) = 'number'::text) AND (jsonb_typeof((progress -> 'topicsDone'::text)) = 'number'::text) AND ((((progress ->> 'topicsTotal'::text))::numeric >= (0)::numeric) AND (((progress ->> 'topicsTotal'::text))::numeric <= (100)::numeric)) AND ((((progress ->> 'topicsDone'::text))::numeric >= (0)::numeric) AND (((progress ->> 'topicsDone'::text))::numeric <= (100)::numeric)) AND (jsonb_typeof((progress -> 'currentTopic'::text)) = ANY (ARRAY['string'::text, 'null'::text])) AND (octet_length((progress)::text) <= 1000)))),
    CONSTRAINT knowledge_generation_source_commit_sha_check CHECK ((source_commit_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text)),
    CONSTRAINT knowledge_model_connection_pair CHECK (((model_connection_id IS NULL) = (model_connection_version IS NULL)))
);


--
-- Name: knowledge_page; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: knowledge_page_alias; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.knowledge_page_alias (
    project_id uuid NOT NULL,
    slug text NOT NULL,
    page_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_page_alias_slug_check CHECK ((slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text))
);


--
-- Name: knowledge_page_outline; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.knowledge_page_outline (
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    parent_id uuid,
    sort_order integer NOT NULL,
    icon text NOT NULL,
    metadata_version bigint NOT NULL,
    state factory.knowledge_page_state NOT NULL,
    version bigint NOT NULL,
    current_revision_id uuid,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: knowledge_revision; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: learning_application; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.learning_application (
    id uuid NOT NULL,
    proposal_id uuid NOT NULL,
    target jsonb NOT NULL,
    edit_digest text NOT NULL,
    activation jsonb DEFAULT '[]'::jsonb NOT NULL,
    applied_revision_id uuid NOT NULL,
    applied_version integer NOT NULL,
    applied_by uuid NOT NULL,
    comparison_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    state text DEFAULT 'applied'::text NOT NULL,
    reverted_revision_id uuid,
    reverted_version integer,
    reverted_by uuid,
    reverted_comparison_id uuid,
    reverted_at timestamp with time zone,
    CONSTRAINT learning_application_activation_check CHECK (((jsonb_typeof(activation) = 'array'::text) AND (jsonb_array_length(activation) <= 2))),
    CONSTRAINT learning_application_applied_version_check CHECK ((applied_version > 0)),
    CONSTRAINT learning_application_check CHECK ((((state = 'applied'::text) AND (reverted_revision_id IS NULL) AND (reverted_version IS NULL) AND (reverted_by IS NULL) AND (reverted_at IS NULL) AND (reverted_comparison_id IS NULL)) OR ((state = 'reverted'::text) AND (reverted_revision_id IS NOT NULL) AND (reverted_version = (applied_version + 1)) AND (reverted_by IS NOT NULL) AND (reverted_at IS NOT NULL)))),
    CONSTRAINT learning_application_edit_digest_check CHECK ((edit_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT learning_application_state_check CHECK ((state = ANY (ARRAY['applied'::text, 'reverted'::text])))
);


--
-- Name: learning_case; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.learning_case (
    id text NOT NULL,
    project_id uuid NOT NULL,
    owner_id uuid,
    reviewer_id uuid NOT NULL,
    developer_only boolean NOT NULL,
    activity text NOT NULL,
    outcome text NOT NULL,
    settled_at timestamp with time zone NOT NULL,
    snapshot jsonb NOT NULL,
    selected boolean NOT NULL,
    batch_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_case_outcome_check CHECK ((outcome = ANY (ARRAY['completed'::text, 'failed'::text, 'interrupted'::text, 'unknown'::text]))),
    CONSTRAINT learning_case_snapshot_check CHECK ((octet_length((snapshot)::text) <= 65536))
);


--
-- Name: learning_command; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.learning_command (
    id uuid NOT NULL,
    actor_id uuid NOT NULL,
    input jsonb NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: learning_policy; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.learning_policy (
    scope_key text NOT NULL,
    project_id uuid NOT NULL,
    owner_id uuid,
    enabled boolean NOT NULL,
    automatic_skills boolean DEFAULT false NOT NULL,
    version integer NOT NULL,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_policy_check CHECK ((scope_key = (((project_id)::text || ':'::text) || COALESCE((owner_id)::text, 'project'::text)))),
    CONSTRAINT learning_policy_version_check CHECK ((version > 0))
);


--
-- Name: learning_proposal; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.learning_proposal (
    id uuid NOT NULL,
    review_id uuid NOT NULL,
    ordinal integer NOT NULL,
    content jsonb NOT NULL,
    state text DEFAULT 'proposed'::text NOT NULL,
    decision_id uuid,
    decided_by uuid,
    decided_at timestamp with time zone,
    ticket_id uuid,
    CONSTRAINT learning_proposal_content_check CHECK ((octet_length((content)::text) <= 32000)),
    CONSTRAINT learning_proposal_ordinal_check CHECK ((ordinal >= 0)),
    CONSTRAINT learning_proposal_state_check CHECK ((state = ANY (ARRAY['proposed'::text, 'dismissed'::text, 'ticket-created'::text, 'applied'::text])))
);


--
-- Name: learning_review; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.learning_review (
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    owner_id uuid,
    developer_only boolean NOT NULL,
    reviewer_id uuid NOT NULL,
    kind text NOT NULL,
    rubric text NOT NULL,
    model_id text NOT NULL,
    model_connection jsonb,
    judge_key text NOT NULL,
    state text NOT NULL,
    input jsonb NOT NULL,
    input_digest text NOT NULL,
    result jsonb,
    calibrated boolean,
    reason text,
    owner_token uuid NOT NULL,
    owner_expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT learning_review_input_check CHECK ((octet_length((input)::text) <= 262144)),
    CONSTRAINT learning_review_input_digest_check CHECK ((input_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT learning_review_kind_check CHECK ((kind = ANY (ARRAY['calibration'::text, 'work'::text]))),
    CONSTRAINT learning_review_result_check CHECK ((octet_length((result)::text) <= 65536)),
    CONSTRAINT learning_review_state_check CHECK ((state = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text, 'uncertain'::text])))
);


--
-- Name: learning_source_artifact; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.learning_source_artifact (
    turn_id uuid NOT NULL,
    ordinal integer NOT NULL,
    reference text NOT NULL,
    body text NOT NULL,
    truncated boolean NOT NULL,
    CONSTRAINT learning_source_artifact_body_check CHECK (((length(body) >= 1) AND (length(body) <= 2000))),
    CONSTRAINT learning_source_artifact_ordinal_check CHECK (((ordinal >= 0) AND (ordinal <= 2))),
    CONSTRAINT learning_source_artifact_reference_check CHECK (((length(reference) >= 1) AND (length(reference) <= 400)))
);


--
-- Name: learning_trial; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.learning_trial (
    id uuid NOT NULL,
    proposal_id uuid NOT NULL,
    phase text NOT NULL,
    actor_id uuid NOT NULL,
    policy_version integer NOT NULL,
    model_id text NOT NULL,
    model_connection jsonb,
    judge_key text NOT NULL,
    rubric text NOT NULL,
    input jsonb NOT NULL,
    input_digest text NOT NULL,
    state text DEFAULT 'running'::text NOT NULL,
    result jsonb,
    reason text,
    owner_token uuid NOT NULL,
    owner_expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT learning_trial_input_check CHECK ((octet_length((input)::text) <= 196608)),
    CONSTRAINT learning_trial_input_digest_check CHECK ((input_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT learning_trial_phase_check CHECK ((phase = ANY (ARRAY['adopt'::text, 'recover'::text]))),
    CONSTRAINT learning_trial_policy_version_check CHECK ((policy_version > 0)),
    CONSTRAINT learning_trial_result_check CHECK ((octet_length((result)::text) <= 65536)),
    CONSTRAINT learning_trial_state_check CHECK ((state = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text, 'uncertain'::text])))
);


--
-- Name: learning_trial_step; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.learning_trial_step (
    trial_id uuid NOT NULL,
    stage integer NOT NULL,
    input jsonb NOT NULL,
    input_digest text NOT NULL,
    state text DEFAULT 'running'::text NOT NULL,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT learning_trial_step_input_check CHECK ((octet_length((input)::text) <= 196608)),
    CONSTRAINT learning_trial_step_input_digest_check CHECK ((input_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT learning_trial_step_result_check CHECK ((octet_length((result)::text) <= 65536)),
    CONSTRAINT learning_trial_step_stage_check CHECK (((stage >= 0) AND (stage <= 2))),
    CONSTRAINT learning_trial_step_state_check CHECK ((state = ANY (ARRAY['running'::text, 'completed'::text, 'uncertain'::text])))
);


--
-- Name: mcp_access_decision; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: mcp_choice; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: mcp_connect_intent; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: mcp_connection; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: mcp_library; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.mcp_library (
    id uuid NOT NULL,
    scope text NOT NULL,
    owner_id uuid,
    project_id uuid,
    CONSTRAINT mcp_library_check CHECK ((((scope = 'personal'::text) AND (owner_id IS NOT NULL) AND (project_id IS NULL)) OR ((scope = 'project'::text) AND (owner_id IS NULL) AND (project_id IS NOT NULL)) OR ((scope = 'system'::text) AND (owner_id IS NULL) AND (project_id IS NULL)))),
    CONSTRAINT mcp_library_scope_check CHECK ((scope = ANY (ARRAY['personal'::text, 'project'::text, 'system'::text])))
);


--
-- Name: mcp_library_cover; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.mcp_library_cover (
    library_id uuid NOT NULL,
    cover_key text NOT NULL,
    version bigint NOT NULL,
    updated_by uuid NOT NULL,
    CONSTRAINT mcp_library_cover_cover_key_check CHECK ((cover_key ~ '^[a-z][a-z-]{1,63}$'::text)),
    CONSTRAINT mcp_library_cover_version_check CHECK ((version > 0))
);


--
-- Name: mcp_oauth_flow; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: mcp_observation; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: mcp_policy_approval; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: mcp_project_grant; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.mcp_project_grant (
    connection_id uuid NOT NULL,
    credential_epoch uuid NOT NULL,
    project_id uuid NOT NULL,
    granted_by uuid NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mcp_revision; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: mcp_secret_write; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: mcp_share_proposal; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: mcp_token_refresh; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.mcp_token_refresh (
    id uuid NOT NULL,
    connection_id uuid NOT NULL,
    credential_epoch uuid NOT NULL,
    state text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_token_refresh_state_check CHECK ((state = ANY (ARRAY['intended'::text, 'committed'::text, 'uncertain'::text])))
);


--
-- Name: merge_operation; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: model_connection_version; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: model_connection_write; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: model_defaults; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: model_role_connection; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.model_role_connection (
    role text NOT NULL,
    connection_id uuid NOT NULL,
    connection_version bigint NOT NULL,
    model_id text NOT NULL,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT model_role_connection_role_check CHECK ((role = ANY (ARRAY['planning'::text, 'build'::text])))
);


--
-- Name: model_role_probe; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: monitoring_command; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: monitoring_evidence; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: monitoring_hook; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: monitoring_incident; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: monitoring_policy; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: personal_git_operation; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.personal_git_operation (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    runtime_attempt_id uuid NOT NULL,
    user_id uuid NOT NULL,
    action text NOT NULL,
    expected_head text NOT NULL,
    branch text NOT NULL,
    message text NOT NULL,
    state text DEFAULT 'intended'::text NOT NULL,
    result jsonb,
    failure text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    attempted_at timestamp with time zone,
    completed_at timestamp with time zone,
    CONSTRAINT personal_git_operation_action_check CHECK ((action = ANY (ARRAY['commit'::text, 'fetch'::text, 'pull'::text]))),
    CONSTRAINT personal_git_operation_branch_check CHECK (((length(branch) >= 1) AND (length(branch) <= 200))),
    CONSTRAINT personal_git_operation_check CHECK (((state = ANY (ARRAY['succeeded'::text, 'failed'::text])) = (completed_at IS NOT NULL))),
    CONSTRAINT personal_git_operation_check1 CHECK (((state <> 'succeeded'::text) OR ((result IS NOT NULL) AND (jsonb_typeof(result) = 'object'::text)))),
    CONSTRAINT personal_git_operation_expected_head_check CHECK ((expected_head ~ '^[a-f0-9]{40}([a-f0-9]{24})?$'::text)),
    CONSTRAINT personal_git_operation_message_check CHECK ((length(message) <= 240)),
    CONSTRAINT personal_git_operation_state_check CHECK ((state = ANY (ARRAY['intended'::text, 'attempted'::text, 'succeeded'::text, 'failed'::text, 'uncertain'::text])))
);


--
-- Name: personal_model_settings; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: personal_skill_settings; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: project; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: project_delivery_policy; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.project_delivery_policy (
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    delegated_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    revoked_command_id uuid,
    revoked_by uuid
);


--
-- Name: project_delivery_queue; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.project_delivery_queue (
    project_id uuid NOT NULL,
    change_id uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: project_environment; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: project_image_preparation; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: project_membership; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.project_membership (
    project_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    manage_project boolean DEFAULT false NOT NULL,
    CONSTRAINT project_membership_role_check CHECK ((role = ANY (ARRAY['product-contributor'::text, 'developer'::text])))
);


--
-- Name: project_model_settings; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: project_release; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: project_repository_intent; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: project_setup_confirmation; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.project_setup_confirmation (
    inspection_id uuid NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: project_setup_draft; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: project_setup_inspection; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: project_setup_readiness; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: project_skill_settings; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: pull_request_operation; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: read_version; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.read_version (
    project_id uuid NOT NULL,
    audience text NOT NULL,
    scope text NOT NULL,
    resource_id uuid NOT NULL,
    revision uuid DEFAULT gen_random_uuid() NOT NULL,
    CONSTRAINT read_version_audience_check CHECK (((audience = ANY (ARRAY['shared'::text, 'developer'::text])) OR (audience ~ '^[0-9a-f-]{36}$'::text))),
    CONSTRAINT read_version_scope_check CHECK ((scope = ANY (ARRAY['lifecycle'::text, 'ticket'::text, 'conversation'::text, 'review'::text, 'inbox'::text, 'knowledge'::text, 'inputs'::text, 'sources'::text, 'releases'::text])))
);


--
-- Name: release_access; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: release_attempt; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: repository_mirror_command; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.repository_mirror_command (
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    created_by uuid NOT NULL,
    action text NOT NULL,
    target_url text,
    remote_name text,
    fingerprint text NOT NULL,
    before_state jsonb NOT NULL,
    state text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT repository_mirror_command_action_check CHECK ((action = ANY (ARRAY['create'::text, 'remove'::text, 'sync'::text]))),
    CONSTRAINT repository_mirror_command_state_check CHECK ((state = ANY (ARRAY['executing'::text, 'completed'::text, 'failed'::text, 'uncertain'::text, 'acknowledged'::text])))
);


--
-- Name: requirement_approval; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.requirement_approval (
    id uuid NOT NULL,
    ticket_id uuid NOT NULL,
    requirement_revision_id uuid NOT NULL,
    technical_design_revision_id uuid,
    approved_by uuid NOT NULL,
    approved_at timestamp with time zone DEFAULT now() NOT NULL,
    monitoring_incident_id uuid,
    monitoring_policy_id uuid,
    CONSTRAINT requirement_monitoring_basis CHECK (((monitoring_incident_id IS NULL) = (monitoring_policy_id IS NULL)))
);


--
-- Name: requirement_revision; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: requirements_entry_intent; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.requirements_entry_intent (
    ticket_id uuid NOT NULL,
    command_id uuid NOT NULL,
    created_by uuid NOT NULL,
    admitted_at timestamp with time zone,
    failure text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: review_feedback; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: review_feedback_command; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.review_feedback_command (
    id uuid NOT NULL,
    change_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    input jsonb NOT NULL,
    feedback_id uuid,
    turn_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: review_feedback_message; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.review_feedback_message (
    id uuid NOT NULL,
    feedback_id uuid NOT NULL,
    author_id uuid NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT review_feedback_message_body_check CHECK (((length(body) >= 1) AND (length(body) <= 2000)))
);


--
-- Name: review_media; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: review_scenario; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: runtime_attempt; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.runtime_attempt (
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    change_id uuid,
    workspace_id uuid,
    generation bigint NOT NULL,
    revision text NOT NULL,
    state factory.runtime_attempt_state NOT NULL,
    parent_connector_token_hash text NOT NULL,
    child_connector_token_hash text NOT NULL,
    create_intended_at timestamp with time zone NOT NULL,
    create_observed_at timestamp with time zone,
    stop_intended_at timestamp with time zone,
    stopped_at timestamp with time zone,
    failure text,
    declared_apps jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    isolated_kind factory.isolated_runtime_kind,
    verification_id uuid,
    ready_at timestamp with time zone,
    app_ready_at jsonb DEFAULT '{}'::jsonb NOT NULL,
    resume_failed_at timestamp with time zone,
    substrate boolean DEFAULT true NOT NULL,
    CONSTRAINT runtime_attempt_app_ready_shape CHECK (((jsonb_typeof(app_ready_at) = 'object'::text) AND (octet_length((app_ready_at)::text) <= 4096))),
    CONSTRAINT runtime_attempt_declared_apps_check CHECK ((jsonb_typeof(declared_apps) = 'array'::text)),
    CONSTRAINT runtime_attempt_generation_check CHECK ((generation > 0)),
    CONSTRAINT runtime_attempt_native_only CHECK (substrate),
    CONSTRAINT runtime_attempt_native_owner CHECK ((((workspace_id IS NOT NULL) AND (isolated_kind IS NULL) AND (verification_id IS NULL)) OR ((workspace_id IS NULL) AND (change_id IS NULL) AND (isolated_kind = 'verification'::factory.isolated_runtime_kind) AND (verification_id IS NOT NULL)) OR ((workspace_id IS NULL) AND (change_id IS NULL) AND (isolated_kind = ANY (ARRAY['prebuild'::factory.isolated_runtime_kind, 'staging'::factory.isolated_runtime_kind, 'publication'::factory.isolated_runtime_kind])) AND (verification_id IS NULL)))),
    CONSTRAINT runtime_attempt_owner_shape_check CHECK ((((workspace_id IS NOT NULL) AND (isolated_kind IS NULL)) OR ((change_id IS NOT NULL) AND (workspace_id IS NOT NULL) AND (isolated_kind IS NULL)) OR ((change_id IS NULL) AND (workspace_id IS NULL) AND (isolated_kind IS NOT NULL)))),
    CONSTRAINT runtime_attempt_verification_shape_check CHECK (((isolated_kind = 'verification'::factory.isolated_runtime_kind) = (verification_id IS NOT NULL)))
);


--
-- Name: runtime_compute_wait; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.runtime_compute_wait (
    attempt_id uuid NOT NULL,
    reason text DEFAULT 'compute-capacity'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT runtime_compute_wait_reason_check CHECK ((reason = ANY (ARRAY['compute-capacity'::text, 'accounting-incomplete'::text, 'coding-budget-used'::text, 'finish-reserve-used'::text])))
);


--
-- Name: runtime_environment_intent; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.runtime_environment_intent (
    runtime_attempt_id uuid NOT NULL,
    environment text NOT NULL,
    version bigint NOT NULL,
    secret_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT runtime_environment_intent_environment_check CHECK ((environment = ANY (ARRAY['development'::text, 'main-preview'::text]))),
    CONSTRAINT runtime_environment_intent_version_check CHECK ((version >= 0))
);


--
-- Name: schema_migration; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.schema_migration (
    version integer NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL,
    source_digest text NOT NULL,
    CONSTRAINT schema_migration_source_digest_check CHECK ((source_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT schema_migration_version_check CHECK ((version = 1))
);


--
-- Name: session_archive; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.session_archive (
    turn_id uuid NOT NULL,
    runtime_attempt_id uuid NOT NULL,
    session_id text NOT NULL,
    prompt_id text NOT NULL,
    source_refs jsonb NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    manifest_key text,
    manifest_sha256 text,
    through_message_id text,
    producer_version text,
    summary jsonb,
    last_error text,
    retry_after timestamp with time zone DEFAULT now() NOT NULL,
    saved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT session_archive_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT session_archive_check CHECK (((state = 'saved'::text) = (saved_at IS NOT NULL))),
    CONSTRAINT session_archive_check1 CHECK (((state <> 'saved'::text) OR ((manifest_key IS NOT NULL) AND (manifest_sha256 IS NOT NULL) AND (through_message_id IS NOT NULL) AND (producer_version IS NOT NULL) AND (summary IS NOT NULL)))),
    CONSTRAINT session_archive_last_error_check CHECK ((length(last_error) <= 2000)),
    CONSTRAINT session_archive_manifest_sha256_check CHECK ((manifest_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT session_archive_prompt_id_check CHECK (((length(prompt_id) >= 1) AND (length(prompt_id) <= 200))),
    CONSTRAINT session_archive_session_id_check CHECK (((length(session_id) >= 1) AND (length(session_id) <= 200))),
    CONSTRAINT session_archive_source_refs_check CHECK (((jsonb_typeof(source_refs) = 'object'::text) AND (octet_length((source_refs)::text) <= 16384))),
    CONSTRAINT session_archive_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'failed'::text, 'saved'::text]))),
    CONSTRAINT session_archive_summary_check CHECK (((jsonb_typeof(summary) = 'object'::text) AND (octet_length((summary)::text) <= 16384)))
);


--
-- Name: shared_document_resolution; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.shared_document_resolution (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    path text NOT NULL,
    actor_id uuid NOT NULL,
    choice text NOT NULL,
    document_revision text NOT NULL,
    disk_version text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT shared_document_resolution_choice_check CHECK ((choice = ANY (ARRAY['keep-shared'::text, 'use-saved'::text])))
);


--
-- Name: skill_library; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.skill_library (
    id uuid NOT NULL,
    storage_key text NOT NULL,
    scope text NOT NULL,
    owner_id uuid,
    project_id uuid,
    CONSTRAINT skill_library_check CHECK ((((scope = 'personal'::text) AND (owner_id IS NOT NULL) AND (project_id IS NULL)) OR ((scope = 'project'::text) AND (owner_id IS NULL) AND (project_id IS NOT NULL)) OR ((scope = 'system'::text) AND (owner_id IS NULL) AND (project_id IS NULL)))),
    CONSTRAINT skill_library_scope_check CHECK ((scope = ANY (ARRAY['system'::text, 'project'::text, 'personal'::text])))
);


--
-- Name: skill_library_choice; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: skill_library_cover; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.skill_library_cover (
    library_id uuid NOT NULL,
    cover_key text NOT NULL,
    version bigint NOT NULL,
    updated_by uuid NOT NULL,
    CONSTRAINT skill_library_cover_cover_key_check CHECK ((cover_key ~ '^[a-z][a-z-]{1,63}$'::text)),
    CONSTRAINT skill_library_cover_version_check CHECK ((version > 0))
);


--
-- Name: skill_library_revision; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.skill_library_revision (
    library_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    copied_from uuid
);


--
-- Name: skill_publication; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.skill_publication (
    revision_id uuid NOT NULL,
    published boolean NOT NULL,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: skill_revision; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: skill_share_proposal; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: staging_configuration; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.staging_configuration (
    runtime_attempt_id uuid NOT NULL,
    declaration jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT staging_configuration_declaration_check CHECK ((jsonb_typeof(declaration) = 'object'::text))
);


--
-- Name: staging_preview; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.staging_preview (
    project_id uuid NOT NULL,
    revision text NOT NULL,
    runtime_attempt_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT staging_preview_revision_check CHECK ((revision ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text))
);


--
-- Name: substrate_binding; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.substrate_binding (
    runtime_attempt_id uuid NOT NULL,
    atespace text NOT NULL,
    actor_name text NOT NULL,
    intent jsonb NOT NULL,
    actor_uid uuid,
    create_attempted_at timestamp with time zone,
    create_rejected boolean DEFAULT false NOT NULL,
    delete_intended_at timestamp with time zone,
    deleted_at timestamp with time zone,
    observation jsonb,
    checkpoint jsonb,
    CONSTRAINT substrate_binding_check CHECK (((actor_uid IS NULL) OR (create_attempted_at IS NOT NULL))),
    CONSTRAINT substrate_binding_check1 CHECK (((deleted_at IS NULL) OR (delete_intended_at IS NOT NULL))),
    CONSTRAINT substrate_binding_intent_check CHECK ((jsonb_typeof(intent) = 'object'::text))
);


--
-- Name: substrate_isolated; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.substrate_isolated (
    owner_id uuid NOT NULL,
    kind text NOT NULL,
    project_id uuid NOT NULL,
    generation bigint NOT NULL,
    runtime_attempt_id uuid NOT NULL,
    intent jsonb NOT NULL,
    atespace_attempted_at timestamp with time zone,
    atespace_rejected boolean DEFAULT false NOT NULL,
    atespace jsonb,
    policy_attempted_at timestamp with time zone,
    policy_rejected boolean DEFAULT false NOT NULL,
    policy jsonb,
    template_attempted_at timestamp with time zone,
    template_rejected boolean DEFAULT false NOT NULL,
    template jsonb,
    CONSTRAINT substrate_isolated_check CHECK (((atespace IS NULL) OR ((atespace_attempted_at IS NOT NULL) AND (jsonb_typeof(atespace) = 'object'::text)))),
    CONSTRAINT substrate_isolated_check1 CHECK (((policy IS NULL) OR ((policy_attempted_at IS NOT NULL) AND (jsonb_typeof(policy) = 'object'::text)))),
    CONSTRAINT substrate_isolated_check2 CHECK (((template IS NULL) OR ((template_attempted_at IS NOT NULL) AND (jsonb_typeof(template) = 'object'::text)))),
    CONSTRAINT substrate_isolated_check3 CHECK (((kind = 'staging'::text) OR (generation = 1))),
    CONSTRAINT substrate_isolated_check4 CHECK ((((intent ->> 'promotionID'::text) IS NULL) OR ((kind = 'staging'::text) AND (generation = 1)))),
    CONSTRAINT substrate_isolated_check5 CHECK (((kind = 'staging'::text) = (jsonb_typeof((intent -> 'declaration'::text)) = 'object'::text))),
    CONSTRAINT substrate_isolated_generation_check CHECK ((generation > 0)),
    CONSTRAINT substrate_isolated_intent_check CHECK ((jsonb_typeof(intent) = 'object'::text)),
    CONSTRAINT substrate_isolated_kind_check CHECK ((kind = ANY (ARRAY['staging'::text, 'publication'::text])))
);


--
-- Name: substrate_prebuild; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.substrate_prebuild (
    preparation_id uuid NOT NULL,
    runtime_attempt_id uuid NOT NULL,
    generation bigint NOT NULL,
    intent jsonb NOT NULL,
    atespace_attempted_at timestamp with time zone,
    atespace_rejected boolean DEFAULT false NOT NULL,
    atespace jsonb,
    policy_attempted_at timestamp with time zone,
    policy_rejected boolean DEFAULT false NOT NULL,
    policy jsonb,
    template_attempted_at timestamp with time zone,
    template_rejected boolean DEFAULT false NOT NULL,
    template jsonb,
    CONSTRAINT substrate_prebuild_check CHECK (((atespace IS NULL) OR ((atespace_attempted_at IS NOT NULL) AND (jsonb_typeof(atespace) = 'object'::text)))),
    CONSTRAINT substrate_prebuild_check1 CHECK (((policy IS NULL) OR ((policy_attempted_at IS NOT NULL) AND (jsonb_typeof(policy) = 'object'::text)))),
    CONSTRAINT substrate_prebuild_check2 CHECK (((template IS NULL) OR ((template_attempted_at IS NOT NULL) AND (jsonb_typeof(template) = 'object'::text)))),
    CONSTRAINT substrate_prebuild_generation_check CHECK ((generation = 1)),
    CONSTRAINT substrate_prebuild_intent_check CHECK ((jsonb_typeof(intent) = 'object'::text))
);


--
-- Name: substrate_source; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.substrate_source (
    workspace_id uuid NOT NULL,
    actor_uid uuid NOT NULL,
    owner text DEFAULT 'actor'::text NOT NULL,
    writer_epoch bigint DEFAULT 1 NOT NULL,
    writable boolean DEFAULT true NOT NULL,
    generation bigint DEFAULT 0 NOT NULL,
    checkpoint_id uuid,
    checkpoint jsonb,
    service_base uuid,
    CONSTRAINT substrate_source_check CHECK (((generation = 0) = (checkpoint IS NULL))),
    CONSTRAINT substrate_source_check1 CHECK ((writable = (checkpoint_id IS NULL))),
    CONSTRAINT substrate_source_check2 CHECK (((owner <> 'service'::text) OR (service_base IS NOT NULL))),
    CONSTRAINT substrate_source_generation_check CHECK ((generation >= 0)),
    CONSTRAINT substrate_source_owner_check CHECK ((owner = ANY (ARRAY['actor'::text, 'service'::text]))),
    CONSTRAINT substrate_source_writer_epoch_check CHECK ((writer_epoch > 0))
);


--
-- Name: substrate_verification; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.substrate_verification (
    verification_id uuid NOT NULL,
    runtime_attempt_id uuid NOT NULL,
    generation bigint NOT NULL,
    intent jsonb NOT NULL,
    atespace_attempted_at timestamp with time zone,
    atespace_rejected boolean DEFAULT false NOT NULL,
    atespace jsonb,
    policy_attempted_at timestamp with time zone,
    policy_rejected boolean DEFAULT false NOT NULL,
    policy jsonb,
    template_attempted_at timestamp with time zone,
    template_rejected boolean DEFAULT false NOT NULL,
    template jsonb,
    CONSTRAINT substrate_verification_atespace_check CHECK (((atespace IS NULL) OR (jsonb_typeof(atespace) = 'object'::text))),
    CONSTRAINT substrate_verification_check CHECK (((atespace IS NULL) OR (atespace_attempted_at IS NOT NULL))),
    CONSTRAINT substrate_verification_check1 CHECK (((policy IS NULL) OR (policy_attempted_at IS NOT NULL))),
    CONSTRAINT substrate_verification_check2 CHECK (((template IS NULL) OR (template_attempted_at IS NOT NULL))),
    CONSTRAINT substrate_verification_generation_check CHECK ((generation > 0)),
    CONSTRAINT substrate_verification_intent_check CHECK ((jsonb_typeof(intent) = 'object'::text)),
    CONSTRAINT substrate_verification_policy_check CHECK (((policy IS NULL) OR (jsonb_typeof(policy) = 'object'::text))),
    CONSTRAINT substrate_verification_template_check CHECK (((template IS NULL) OR (jsonb_typeof(template) = 'object'::text)))
);


--
-- Name: substrate_worker_capacity; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.substrate_worker_capacity (
    owner text NOT NULL,
    node_uid uuid NOT NULL,
    intent jsonb NOT NULL,
    attempted_at timestamp with time zone,
    rejected boolean DEFAULT false NOT NULL,
    pool jsonb,
    CONSTRAINT substrate_worker_capacity_check CHECK (((pool IS NULL) OR (attempted_at IS NOT NULL))),
    CONSTRAINT substrate_worker_capacity_intent_check CHECK ((jsonb_typeof(intent) = 'object'::text)),
    CONSTRAINT substrate_worker_capacity_owner_check CHECK ((owner ~ '^[a-f0-9]{32}$'::text)),
    CONSTRAINT substrate_worker_capacity_pool_check CHECK (((pool IS NULL) OR (jsonb_typeof(pool) = 'object'::text)))
);


--
-- Name: substrate_workspace; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.substrate_workspace (
    workspace_id uuid NOT NULL,
    generation bigint DEFAULT 1 NOT NULL,
    intent jsonb NOT NULL,
    atespace_attempted_at timestamp with time zone,
    atespace_rejected boolean DEFAULT false NOT NULL,
    atespace jsonb,
    policy_attempted_at timestamp with time zone,
    policy_rejected boolean DEFAULT false NOT NULL,
    policy jsonb,
    template_attempted_at timestamp with time zone,
    template_rejected boolean DEFAULT false NOT NULL,
    template jsonb,
    CONSTRAINT substrate_workspace_check CHECK (((atespace IS NULL) OR (atespace_attempted_at IS NOT NULL))),
    CONSTRAINT substrate_workspace_check1 CHECK (((policy IS NULL) OR (policy_attempted_at IS NOT NULL))),
    CONSTRAINT substrate_workspace_check2 CHECK (((template IS NULL) OR (template_attempted_at IS NOT NULL))),
    CONSTRAINT substrate_workspace_generation_check CHECK (((generation > 0) AND (generation <= '9007199254740991'::bigint))),
    CONSTRAINT substrate_workspace_intent_check CHECK ((jsonb_typeof(intent) = 'object'::text))
);


--
-- Name: system_skill_settings; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: technical_design_revision; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.technical_design_revision (
    id uuid NOT NULL,
    ticket_id uuid NOT NULL,
    requirement_revision_id uuid NOT NULL,
    previous_revision_id uuid,
    ordinal integer NOT NULL,
    source_commit text NOT NULL,
    canonical_content text NOT NULL,
    content_digest text NOT NULL,
    citations jsonb DEFAULT '[]'::jsonb NOT NULL,
    diagram_renders jsonb DEFAULT '[]'::jsonb NOT NULL,
    renderer_version text NOT NULL,
    created_by uuid NOT NULL,
    author_kind text NOT NULL,
    turn_id uuid,
    planning_turn_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT technical_design_revision_author_kind_check CHECK ((author_kind = ANY (ARRAY['human'::text, 'ai'::text]))),
    CONSTRAINT technical_design_revision_canonical_content_check CHECK (((length(canonical_content) >= 1) AND (length(canonical_content) <= 100000))),
    CONSTRAINT technical_design_revision_check CHECK ((content_digest = encode(factory.digest(convert_to(canonical_content, 'UTF8'::name), 'sha256'::text), 'hex'::text))),
    CONSTRAINT technical_design_revision_citations_check CHECK ((jsonb_typeof(citations) = 'array'::text)),
    CONSTRAINT technical_design_revision_diagram_renders_check CHECK ((jsonb_typeof(diagram_renders) = 'array'::text)),
    CONSTRAINT technical_design_revision_ordinal_check CHECK ((ordinal > 0)),
    CONSTRAINT technical_design_revision_source_commit_check CHECK ((source_commit ~ '^[a-f0-9]{40}$'::text))
);


--
-- Name: ticket; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: ticket_conversation; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: ticket_dependency; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.ticket_dependency (
    project_id uuid NOT NULL,
    ticket_id uuid NOT NULL,
    prerequisite_id uuid NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ticket_dependency_check CHECK ((ticket_id <> prerequisite_id))
);


--
-- Name: ticket_document_revision; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: ticket_follow; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.ticket_follow (
    ticket_id uuid NOT NULL,
    user_id uuid NOT NULL,
    following boolean NOT NULL
);


--
-- Name: ticket_follow_up; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.ticket_follow_up (
    ticket_id uuid NOT NULL,
    source_ticket_id uuid NOT NULL,
    source_document_id uuid,
    source_revision_id uuid NOT NULL,
    CONSTRAINT ticket_follow_up_check CHECK ((ticket_id <> source_ticket_id))
);


--
-- Name: ticket_responsibility; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.ticket_responsibility (
    ticket_id uuid NOT NULL,
    user_id uuid,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT ticket_responsibility_version_check CHECK ((version > 0))
);


--
-- Name: ticket_responsibility_event; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.ticket_responsibility_event (
    id uuid NOT NULL,
    ticket_id uuid NOT NULL,
    user_id uuid,
    actor_id uuid NOT NULL,
    expected_version integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: usage_entry; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: usage_operation; Type: TABLE; Schema: factory; Owner: -
--

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
    CONSTRAINT usage_operation_purpose_check CHECK ((purpose = ANY (ARRAY['coding'::text, 'research'::text, 'requirements'::text, 'wiki'::text, 'setup'::text, 'probe'::text, 'learning'::text])))
);


--
-- Name: usage_rate_override; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.usage_rate_override (
    provider text NOT NULL,
    model text NOT NULL,
    version bigint NOT NULL,
    rate jsonb,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT usage_rate_override_version_check CHECK ((version > 0))
);


--
-- Name: usage_replay_cursor; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.usage_replay_cursor (
    operation_id text NOT NULL,
    session_id text NOT NULL,
    sequence bigint NOT NULL,
    start_sequence bigint DEFAULT 0 NOT NULL,
    CONSTRAINT usage_replay_cursor_sequence_check CHECK ((sequence >= 0)),
    CONSTRAINT usage_replay_cursor_start_sequence_check CHECK ((start_sequence >= 0))
);


--
-- Name: user_ui_preference; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.user_ui_preference (
    user_id uuid NOT NULL,
    desktop_background_key text DEFAULT 'river-landscape'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_ui_preference_desktop_background_key_check CHECK ((desktop_background_key = ANY (ARRAY['river-landscape'::text, 'the-harvesters'::text, 'mountainous-landscape'::text])))
);


--
-- Name: verification; Type: TABLE; Schema: factory; Owner: -
--

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
    diagnosis jsonb,
    repair_prompted_at timestamp with time zone,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    runner_job_handle text,
    CONSTRAINT verification_check CHECK (((state = ANY (ARRAY['succeeded'::factory.verification_state, 'failed'::factory.verification_state, 'cancelled'::factory.verification_state])) = (completed_at IS NOT NULL))),
    CONSTRAINT verification_check1 CHECK (((state <> ALL (ARRAY['runner-starting'::factory.verification_state, 'running'::factory.verification_state, 'succeeded'::factory.verification_state, 'failed'::factory.verification_state])) OR (action_run_id IS NOT NULL))),
    CONSTRAINT verification_check2 CHECK (((runtime_attempt_id IS NULL) OR (runner_token IS NOT NULL))),
    CONSTRAINT verification_check3 CHECK (((runner_job_handle IS NULL) OR ((action_run_id IS NOT NULL) AND (runner_job_handle ~ '^[A-Za-z0-9_-]{1,200}$'::text)))),
    CONSTRAINT verification_commit_sha_check CHECK ((commit_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$'::text)),
    CONSTRAINT verification_diagnosis_check CHECK (((diagnosis IS NULL) OR ((jsonb_typeof(diagnosis) = 'object'::text) AND (octet_length((diagnosis)::text) <= 24000)))),
    CONSTRAINT verification_summary_check CHECK (((summary IS NULL) OR (length(summary) <= 2000)))
);


--
-- Name: wiki_source_update; Type: TABLE; Schema: factory; Owner: -
--

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


--
-- Name: workspace_collaboration_decision; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.workspace_collaboration_decision (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_command; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.workspace_command (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    runtime_attempt_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    kind text DEFAULT 'shell'::text NOT NULL,
    input_digest text NOT NULL,
    state text DEFAULT 'start-intended'::text NOT NULL,
    dispatch_attempted_at timestamp with time zone,
    result jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_command_input_digest_check CHECK ((input_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT workspace_command_kind_check CHECK ((kind = ANY (ARRAY['shell'::text, 'terminal'::text]))),
    CONSTRAINT workspace_command_state_check CHECK ((state = ANY (ARRAY['start-intended'::text, 'dispatching'::text, 'starting'::text, 'running'::text, 'exited'::text, 'cancelled'::text, 'failed'::text, 'uncertain'::text, 'interrupted'::text])))
);


--
-- Name: workspace_file_operation; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.workspace_file_operation (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    runtime_attempt_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    action text NOT NULL,
    input_digest text NOT NULL,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT workspace_file_operation_action_check CHECK ((action = ANY (ARRAY['mkdir'::text, 'delete'::text, 'rename'::text]))),
    CONSTRAINT workspace_file_operation_input_digest_check CHECK ((input_digest ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: workspace_file_transfer; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.workspace_file_transfer (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    runtime_attempt_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    direction text NOT NULL,
    input_digest text NOT NULL,
    path text NOT NULL,
    state text NOT NULL,
    result jsonb,
    commit_attempted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '00:30:00'::interval) NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_file_transfer_direction_check CHECK ((direction = ANY (ARRAY['upload'::text, 'download'::text]))),
    CONSTRAINT workspace_file_transfer_input_digest_check CHECK ((input_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT workspace_file_transfer_state_check CHECK ((state = ANY (ARRAY['preparing'::text, 'active'::text, 'committing'::text, 'committed'::text, 'releasing'::text, 'released'::text, 'uncertain'::text])))
);


--
-- Name: workspace_lifecycle_command; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.workspace_lifecycle_command (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    runtime_attempt_id uuid,
    actor_id uuid NOT NULL,
    action text NOT NULL,
    dispatch_attempted_at timestamp with time zone,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT workspace_lifecycle_command_action_check CHECK ((action = ANY (ARRAY['start'::text, 'pause'::text, 'stop'::text])))
);


--
-- Name: workspace_share; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.workspace_share (
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    permission text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    granted_by uuid NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT workspace_share_permission_check CHECK ((permission = ANY (ARRAY['observe'::text, 'collaborate'::text]))),
    CONSTRAINT workspace_share_version_check CHECK ((version > 0))
);


--
-- Name: workspace_share_decision; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.workspace_share_decision (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    permission text,
    expected_version bigint NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    access_reconciled_at timestamp with time zone,
    CONSTRAINT workspace_share_decision_expected_version_check CHECK ((expected_version >= 0)),
    CONSTRAINT workspace_share_decision_permission_check CHECK ((permission = ANY (ARRAY['observe'::text, 'collaborate'::text])))
);


--
-- Name: workspace_shared_document; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.workspace_shared_document (
    workspace_id uuid NOT NULL,
    path text NOT NULL,
    y_state bytea NOT NULL,
    disk_version text NOT NULL,
    dirty boolean DEFAULT false NOT NULL,
    conflict boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_shared_document_y_state_check CHECK ((octet_length(y_state) <= 8388608))
);


--
-- Name: workspace_submission; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.workspace_submission (
    id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    writer_epoch bigint NOT NULL,
    remote_head text NOT NULL,
    repository_url text NOT NULL,
    prepare_attempted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_submission_repository_url_check CHECK (repository_url ~ '^https://[^/@?#]+/[^/?#]+/[^/?#]+$'),
    CONSTRAINT workspace_submission_remote_head_check CHECK (remote_head ~ '^[a-f0-9]{40}([a-f0-9]{24})?$'),
    CONSTRAINT workspace_submission_writer_epoch_check CHECK (writer_epoch > 0)
);

CREATE TRIGGER workspace_submission_intent BEFORE INSERT OR UPDATE ON factory.workspace_submission
    FOR EACH ROW EXECUTE FUNCTION factory.protect_workspace_submission();


--
-- Name: workspace_terminal_operation; Type: TABLE; Schema: factory; Owner: -
--

CREATE TABLE factory.workspace_terminal_operation (
    id uuid NOT NULL,
    command_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    action text NOT NULL,
    input_digest text NOT NULL,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT workspace_terminal_operation_action_check CHECK ((action = ANY (ARRAY['input'::text, 'resize'::text]))),
    CONSTRAINT workspace_terminal_operation_input_digest_check CHECK ((input_digest ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: account account_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);


--
-- Name: account account_provider_id_account_id_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.account
    ADD CONSTRAINT account_provider_id_account_id_key UNIQUE (provider_id, account_id);


--
-- Name: jwks jwks_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.jwks
    ADD CONSTRAINT jwks_pkey PRIMARY KEY (id);


--
-- Name: oauthAccessToken oauthAccessToken_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_pkey" PRIMARY KEY (id);


--
-- Name: oauthAccessToken oauthAccessToken_token_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_token_key" UNIQUE (token);


--
-- Name: oauthClientAssertion oauthClientAssertion_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthClientAssertion"
    ADD CONSTRAINT "oauthClientAssertion_pkey" PRIMARY KEY (id);


--
-- Name: oauthClientResource oauthClientResource_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthClientResource"
    ADD CONSTRAINT "oauthClientResource_pkey" PRIMARY KEY (id);


--
-- Name: oauthClient oauthClient_clientId_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthClient"
    ADD CONSTRAINT "oauthClient_clientId_key" UNIQUE ("clientId");


--
-- Name: oauthClient oauthClient_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthClient"
    ADD CONSTRAINT "oauthClient_pkey" PRIMARY KEY (id);


--
-- Name: oauthConsent oauthConsent_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthConsent"
    ADD CONSTRAINT "oauthConsent_pkey" PRIMARY KEY (id);


--
-- Name: oauthRefreshToken oauthRefreshToken_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_pkey" PRIMARY KEY (id);


--
-- Name: oauthRefreshToken oauthRefreshToken_token_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_token_key" UNIQUE (token);


--
-- Name: oauthResource oauthResource_identifier_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthResource"
    ADD CONSTRAINT "oauthResource_identifier_key" UNIQUE (identifier);


--
-- Name: oauthResource oauthResource_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthResource"
    ADD CONSTRAINT "oauthResource_pkey" PRIMARY KEY (id);


--
-- Name: scimConnectionBinding scimConnectionBinding_connectionKey_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."scimConnectionBinding"
    ADD CONSTRAINT "scimConnectionBinding_connectionKey_key" UNIQUE ("connectionKey");


--
-- Name: scimConnectionBinding scimConnectionBinding_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."scimConnectionBinding"
    ADD CONSTRAINT "scimConnectionBinding_pkey" PRIMARY KEY (id);


--
-- Name: scimGroupMember scimGroupMember_membershipKey_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."scimGroupMember"
    ADD CONSTRAINT "scimGroupMember_membershipKey_key" UNIQUE ("membershipKey");


--
-- Name: scimGroupMember scimGroupMember_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."scimGroupMember"
    ADD CONSTRAINT "scimGroupMember_pkey" PRIMARY KEY (id);


--
-- Name: scimGroup scimGroup_displayNameKey_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."scimGroup"
    ADD CONSTRAINT "scimGroup_displayNameKey_key" UNIQUE ("displayNameKey");


--
-- Name: scimGroup scimGroup_externalIdKey_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."scimGroup"
    ADD CONSTRAINT "scimGroup_externalIdKey_key" UNIQUE ("externalIdKey");


--
-- Name: scimGroup scimGroup_orderKey_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."scimGroup"
    ADD CONSTRAINT "scimGroup_orderKey_key" UNIQUE ("orderKey");


--
-- Name: scimGroup scimGroup_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."scimGroup"
    ADD CONSTRAINT "scimGroup_pkey" PRIMARY KEY (id);


--
-- Name: scimIdentityTombstone scimIdentityTombstone_externalIdKey_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."scimIdentityTombstone"
    ADD CONSTRAINT "scimIdentityTombstone_externalIdKey_key" UNIQUE ("externalIdKey");


--
-- Name: scimIdentityTombstone scimIdentityTombstone_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."scimIdentityTombstone"
    ADD CONSTRAINT "scimIdentityTombstone_pkey" PRIMARY KEY (id);


--
-- Name: scimProjectionGrant scimProjectionGrant_grantKey_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."scimProjectionGrant"
    ADD CONSTRAINT "scimProjectionGrant_grantKey_key" UNIQUE ("grantKey");


--
-- Name: scimProjectionGrant scimProjectionGrant_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."scimProjectionGrant"
    ADD CONSTRAINT "scimProjectionGrant_pkey" PRIMARY KEY (id);


--
-- Name: scimSubject scimSubject_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."scimSubject"
    ADD CONSTRAINT "scimSubject_pkey" PRIMARY KEY (id);


--
-- Name: scimSubject scimSubject_userId_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."scimSubject"
    ADD CONSTRAINT "scimSubject_userId_key" UNIQUE ("userId");


--
-- Name: scimUser scimUser_connectionUserKey_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."scimUser"
    ADD CONSTRAINT "scimUser_connectionUserKey_key" UNIQUE ("connectionUserKey");


--
-- Name: scimUser scimUser_externalIdKey_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."scimUser"
    ADD CONSTRAINT "scimUser_externalIdKey_key" UNIQUE ("externalIdKey");


--
-- Name: scimUser scimUser_orderKey_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."scimUser"
    ADD CONSTRAINT "scimUser_orderKey_key" UNIQUE ("orderKey");


--
-- Name: scimUser scimUser_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."scimUser"
    ADD CONSTRAINT "scimUser_pkey" PRIMARY KEY (id);


--
-- Name: scimUser scimUser_userNameKey_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."scimUser"
    ADD CONSTRAINT "scimUser_userNameKey_key" UNIQUE ("userNameKey");


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);


--
-- Name: session session_token_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.session
    ADD CONSTRAINT session_token_key UNIQUE (token);


--
-- Name: ssoProvider ssoProvider_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."ssoProvider"
    ADD CONSTRAINT "ssoProvider_pkey" PRIMARY KEY (id);


--
-- Name: ssoProvider ssoProvider_providerId_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."ssoProvider"
    ADD CONSTRAINT "ssoProvider_providerId_key" UNIQUE ("providerId");


--
-- Name: user user_email_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."user"
    ADD CONSTRAINT user_email_key UNIQUE (email);


--
-- Name: user user_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);


--
-- Name: verification verification_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);


--
-- Name: access_revocation access_revocation_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.access_revocation
    ADD CONSTRAINT access_revocation_pkey PRIMARY KEY (user_id);


--
-- Name: account_access account_access_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.account_access
    ADD CONSTRAINT account_access_id_key UNIQUE (id);


--
-- Name: account_access account_access_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.account_access
    ADD CONSTRAINT account_access_pkey PRIMARY KEY (user_id);


--
-- Name: administrator administrator_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.administrator
    ADD CONSTRAINT administrator_pkey PRIMARY KEY (user_id);


--
-- Name: agent_turn agent_turn_command_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.agent_turn
    ADD CONSTRAINT agent_turn_command_id_key UNIQUE (command_id);


--
-- Name: agent_turn_mcp agent_turn_mcp_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.agent_turn_mcp
    ADD CONSTRAINT agent_turn_mcp_pkey PRIMARY KEY (turn_id, connection_id);


--
-- Name: agent_turn agent_turn_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.agent_turn
    ADD CONSTRAINT agent_turn_pkey PRIMARY KEY (id);


--
-- Name: agent_turn_skill agent_turn_skill_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.agent_turn_skill
    ADD CONSTRAINT agent_turn_skill_pkey PRIMARY KEY (turn_id, revision_id);


--
-- Name: attachment_draft attachment_draft_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.attachment_draft
    ADD CONSTRAINT attachment_draft_pkey PRIMARY KEY (id, owner_id);


--
-- Name: attachment attachment_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.attachment
    ADD CONSTRAINT attachment_pkey PRIMARY KEY (id);


--
-- Name: attachment_reference attachment_reference_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.attachment_reference
    ADD CONSTRAINT attachment_reference_pkey PRIMARY KEY (attachment_id, kind, reference_id);


--
-- Name: attachment_storage attachment_storage_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.attachment_storage
    ADD CONSTRAINT attachment_storage_id_key UNIQUE (id);


--
-- Name: attachment_storage attachment_storage_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.attachment_storage
    ADD CONSTRAINT attachment_storage_pkey PRIMARY KEY (singleton);


--
-- Name: attachment_turn_context attachment_turn_context_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.attachment_turn_context
    ADD CONSTRAINT attachment_turn_context_pkey PRIMARY KEY (turn_id, source);


--
-- Name: branch_create_operation branch_create_operation_change_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.branch_create_operation
    ADD CONSTRAINT branch_create_operation_change_id_key UNIQUE (change_id);


--
-- Name: branch_create_operation branch_create_operation_idempotency_key_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.branch_create_operation
    ADD CONSTRAINT branch_create_operation_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: branch_create_operation branch_create_operation_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.branch_create_operation
    ADD CONSTRAINT branch_create_operation_pkey PRIMARY KEY (id);


--
-- Name: branch_create_operation branch_create_operation_repository_owner_repository_name_br_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.branch_create_operation
    ADD CONSTRAINT branch_create_operation_repository_owner_repository_name_br_key UNIQUE (repository_owner, repository_name, branch_name);


--
-- Name: build_browser_session build_browser_session_owner_ordinal_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.build_browser_session
    ADD CONSTRAINT build_browser_session_owner_ordinal_key UNIQUE (turn_id, owner_id, ordinal);


--
-- Name: build_browser_session build_browser_session_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.build_browser_session
    ADD CONSTRAINT build_browser_session_pkey PRIMARY KEY (id);


--
-- Name: candidate_review candidate_review_id_change_id_verification_id_commit_sha_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.candidate_review
    ADD CONSTRAINT candidate_review_id_change_id_verification_id_commit_sha_key UNIQUE (id, change_id, verification_id, commit_sha);


--
-- Name: candidate_review candidate_review_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.candidate_review
    ADD CONSTRAINT candidate_review_pkey PRIMARY KEY (id);


--
-- Name: candidate_review candidate_review_repair_command_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.candidate_review
    ADD CONSTRAINT candidate_review_repair_command_id_key UNIQUE (repair_command_id);


--
-- Name: candidate_review candidate_review_supersedes_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.candidate_review
    ADD CONSTRAINT candidate_review_supersedes_id_key UNIQUE (supersedes_id);


--
-- Name: candidate_review candidate_review_turn_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.candidate_review
    ADD CONSTRAINT candidate_review_turn_id_key UNIQUE (turn_id);


--
-- Name: candidate_review candidate_review_verification_id_ordinal_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.candidate_review
    ADD CONSTRAINT candidate_review_verification_id_ordinal_key UNIQUE (verification_id, ordinal);


--
-- Name: change_agent_session change_agent_session_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_agent_session
    ADD CONSTRAINT change_agent_session_pkey PRIMARY KEY (change_id);


--
-- Name: change_agent_turn_intent change_agent_turn_intent_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_agent_turn_intent
    ADD CONSTRAINT change_agent_turn_intent_pkey PRIMARY KEY (turn_id);


--
-- Name: change_agent_turn_intent change_agent_turn_intent_prompt_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_agent_turn_intent
    ADD CONSTRAINT change_agent_turn_intent_prompt_id_key UNIQUE (prompt_id);


--
-- Name: change_commit_operation change_commit_operation_change_id_sequence_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_commit_operation
    ADD CONSTRAINT change_commit_operation_change_id_sequence_key UNIQUE (change_id, sequence);


--
-- Name: change_commit_operation change_commit_operation_idempotency_key_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_commit_operation
    ADD CONSTRAINT change_commit_operation_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: change_commit_operation change_commit_operation_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_commit_operation
    ADD CONSTRAINT change_commit_operation_pkey PRIMARY KEY (id);


--
-- Name: change_editing_decision change_editing_decision_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_editing_decision
    ADD CONSTRAINT change_editing_decision_pkey PRIMARY KEY (command_id);


--
-- Name: change_editing_request change_editing_request_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_editing_request
    ADD CONSTRAINT change_editing_request_pkey PRIMARY KEY (id);


--
-- Name: change change_id_branch_name_base_sha_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_id_branch_name_base_sha_key UNIQUE (id, branch_name, base_sha);


--
-- Name: change change_id_project_id_base_sha_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_id_project_id_base_sha_key UNIQUE (id, project_id, base_sha);


--
-- Name: change change_id_project_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_id_project_id_key UNIQUE (id, project_id);


--
-- Name: change change_id_ticket_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_id_ticket_id_key UNIQUE (id, ticket_id);


--
-- Name: change change_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_pkey PRIMARY KEY (id);


--
-- Name: change change_project_id_branch_name_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_project_id_branch_name_key UNIQUE (project_id, branch_name);


--
-- Name: change change_requirement_approval_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_requirement_approval_id_key UNIQUE (requirement_approval_id);


--
-- Name: change change_runtime_attempt_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_runtime_attempt_id_key UNIQUE (runtime_attempt_id);


--
-- Name: change_writer change_writer_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_writer
    ADD CONSTRAINT change_writer_pkey PRIMARY KEY (change_id);


--
-- Name: coding_pause coding_pause_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.coding_pause
    ADD CONSTRAINT coding_pause_pkey PRIMARY KEY (turn_id);


--
-- Name: conversation_context conversation_context_command_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.conversation_context
    ADD CONSTRAINT conversation_context_command_id_key UNIQUE (command_id);


--
-- Name: conversation_context conversation_context_conversation_id_ordinal_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.conversation_context
    ADD CONSTRAINT conversation_context_conversation_id_ordinal_key UNIQUE (conversation_id, ordinal);


--
-- Name: conversation_context conversation_context_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.conversation_context
    ADD CONSTRAINT conversation_context_pkey PRIMARY KEY (id);


--
-- Name: conversation_entry conversation_entry_conversation_id_ordinal_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.conversation_entry
    ADD CONSTRAINT conversation_entry_conversation_id_ordinal_key UNIQUE (conversation_id, ordinal);


--
-- Name: conversation_entry conversation_entry_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.conversation_entry
    ADD CONSTRAINT conversation_entry_pkey PRIMARY KEY (id);


--
-- Name: delivery_approval delivery_approval_exact_basis_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.delivery_approval
    ADD CONSTRAINT delivery_approval_exact_basis_key UNIQUE NULLS NOT DISTINCT (verification_id, candidate_review_id, approved_by, monitoring_policy_id, delivery_policy_id);


--
-- Name: delivery_approval delivery_approval_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.delivery_approval
    ADD CONSTRAINT delivery_approval_pkey PRIMARY KEY (id);


--
-- Name: developer_ide developer_ide_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.developer_ide
    ADD CONSTRAINT developer_ide_pkey PRIMARY KEY (user_id);


--
-- Name: developer_ide developer_ide_resource_id_unique; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.developer_ide
    ADD CONSTRAINT developer_ide_resource_id_unique UNIQUE (resource_id);


--
-- Name: development_workspace development_workspace_id_change_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.development_workspace
    ADD CONSTRAINT development_workspace_id_change_id_key UNIQUE (id, change_id);


--
-- Name: development_workspace development_workspace_id_project_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.development_workspace
    ADD CONSTRAINT development_workspace_id_project_id_key UNIQUE (id, project_id);


--
-- Name: development_workspace development_workspace_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.development_workspace
    ADD CONSTRAINT development_workspace_pkey PRIMARY KEY (id);


--
-- Name: environment_write environment_write_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.environment_write
    ADD CONSTRAINT environment_write_pkey PRIMARY KEY (command_id);


--
-- Name: environment_write environment_write_secret_key_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.environment_write
    ADD CONSTRAINT environment_write_secret_key_key UNIQUE (secret_key);


--
-- Name: epic_confirmation epic_confirmation_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.epic_confirmation
    ADD CONSTRAINT epic_confirmation_pkey PRIMARY KEY (id);


--
-- Name: epic_confirmation epic_confirmation_proposal_entry_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.epic_confirmation
    ADD CONSTRAINT epic_confirmation_proposal_entry_id_key UNIQUE (proposal_entry_id);


--
-- Name: epic epic_id_project_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.epic
    ADD CONSTRAINT epic_id_project_id_key UNIQUE (id, project_id);


--
-- Name: epic epic_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.epic
    ADD CONSTRAINT epic_pkey PRIMARY KEY (id);


--
-- Name: execution_policy_command execution_policy_command_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.execution_policy_command
    ADD CONSTRAINT execution_policy_command_pkey PRIMARY KEY (command_id);


--
-- Name: execution_policy execution_policy_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.execution_policy
    ADD CONSTRAINT execution_policy_pkey PRIMARY KEY (scope);


--
-- Name: external_identity external_identity_issuer_subject_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.external_identity
    ADD CONSTRAINT external_identity_issuer_subject_key UNIQUE (issuer, subject);


--
-- Name: external_identity external_identity_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.external_identity
    ADD CONSTRAINT external_identity_pkey PRIMARY KEY (id);


--
-- Name: forge_account_intent forge_account_intent_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.forge_account_intent
    ADD CONSTRAINT forge_account_intent_pkey PRIMARY KEY (user_id);


--
-- Name: forge_account_intent forge_account_intent_username_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.forge_account_intent
    ADD CONSTRAINT forge_account_intent_username_key UNIQUE (username);


--
-- Name: forge_branch_intent forge_branch_intent_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.forge_branch_intent
    ADD CONSTRAINT forge_branch_intent_pkey PRIMARY KEY (project_id, branch);


--
-- Name: forge_connection forge_connection_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.forge_connection
    ADD CONSTRAINT forge_connection_pkey PRIMARY KEY (id);


--
-- Name: forge_grant_intent forge_grant_intent_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.forge_grant_intent
    ADD CONSTRAINT forge_grant_intent_pkey PRIMARY KEY (project_id, user_id);


--
-- Name: forge_identity_intent forge_identity_intent_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.forge_identity_intent
    ADD CONSTRAINT forge_identity_intent_pkey PRIMARY KEY (client_id);


--
-- Name: identity_configuration identity_configuration_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.identity_configuration
    ADD CONSTRAINT identity_configuration_pkey PRIMARY KEY (singleton);


--
-- Name: identity_setup identity_setup_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.identity_setup
    ADD CONSTRAINT identity_setup_pkey PRIMARY KEY (id);


--
-- Name: identity_setup identity_setup_secret_key_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.identity_setup
    ADD CONSTRAINT identity_setup_secret_key_key UNIQUE (secret_key);


--
-- Name: implementation_order implementation_order_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.implementation_order
    ADD CONSTRAINT implementation_order_pkey PRIMARY KEY (command_id);


--
-- Name: inbox_receipt inbox_receipt_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.inbox_receipt
    ADD CONSTRAINT inbox_receipt_pkey PRIMARY KEY (user_id, item_id);


--
-- Name: installation_maintenance installation_maintenance_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.installation_maintenance
    ADD CONSTRAINT installation_maintenance_pkey PRIMARY KEY (singleton);


--
-- Name: knowledge_generation knowledge_generation_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.knowledge_generation
    ADD CONSTRAINT knowledge_generation_pkey PRIMARY KEY (id);


--
-- Name: knowledge_page_alias knowledge_page_alias_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.knowledge_page_alias
    ADD CONSTRAINT knowledge_page_alias_pkey PRIMARY KEY (project_id, slug);


--
-- Name: knowledge_page knowledge_page_id_project_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.knowledge_page
    ADD CONSTRAINT knowledge_page_id_project_id_key UNIQUE (id, project_id);


--
-- Name: knowledge_page_outline knowledge_page_outline_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.knowledge_page_outline
    ADD CONSTRAINT knowledge_page_outline_pkey PRIMARY KEY (id);


--
-- Name: knowledge_page knowledge_page_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.knowledge_page
    ADD CONSTRAINT knowledge_page_pkey PRIMARY KEY (id);


--
-- Name: knowledge_page knowledge_page_project_id_slug_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.knowledge_page
    ADD CONSTRAINT knowledge_page_project_id_slug_key UNIQUE (project_id, slug);


--
-- Name: knowledge_page knowledge_page_project_identity; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.knowledge_page
    ADD CONSTRAINT knowledge_page_project_identity UNIQUE (project_id, id);


--
-- Name: knowledge_revision knowledge_revision_id_page_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.knowledge_revision
    ADD CONSTRAINT knowledge_revision_id_page_id_key UNIQUE (id, page_id);


--
-- Name: knowledge_revision knowledge_revision_page_id_ordinal_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.knowledge_revision
    ADD CONSTRAINT knowledge_revision_page_id_ordinal_key UNIQUE (page_id, ordinal);


--
-- Name: knowledge_revision knowledge_revision_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.knowledge_revision
    ADD CONSTRAINT knowledge_revision_pkey PRIMARY KEY (id);


--
-- Name: learning_application learning_application_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_application
    ADD CONSTRAINT learning_application_pkey PRIMARY KEY (id);


--
-- Name: learning_application learning_application_proposal_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_application
    ADD CONSTRAINT learning_application_proposal_id_key UNIQUE (proposal_id);


--
-- Name: learning_case learning_case_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_case
    ADD CONSTRAINT learning_case_pkey PRIMARY KEY (id);


--
-- Name: learning_command learning_command_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_command
    ADD CONSTRAINT learning_command_pkey PRIMARY KEY (id);


--
-- Name: learning_policy learning_policy_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_policy
    ADD CONSTRAINT learning_policy_pkey PRIMARY KEY (scope_key);


--
-- Name: learning_proposal learning_proposal_decision_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_proposal
    ADD CONSTRAINT learning_proposal_decision_id_key UNIQUE (decision_id);


--
-- Name: learning_proposal learning_proposal_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_proposal
    ADD CONSTRAINT learning_proposal_pkey PRIMARY KEY (id);


--
-- Name: learning_proposal learning_proposal_review_id_ordinal_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_proposal
    ADD CONSTRAINT learning_proposal_review_id_ordinal_key UNIQUE (review_id, ordinal);


--
-- Name: learning_review learning_review_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_review
    ADD CONSTRAINT learning_review_pkey PRIMARY KEY (id);


--
-- Name: learning_source_artifact learning_source_artifact_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_source_artifact
    ADD CONSTRAINT learning_source_artifact_pkey PRIMARY KEY (turn_id, ordinal);


--
-- Name: learning_trial learning_trial_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_trial
    ADD CONSTRAINT learning_trial_pkey PRIMARY KEY (id);


--
-- Name: learning_trial learning_trial_proposal_id_phase_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_trial
    ADD CONSTRAINT learning_trial_proposal_id_phase_key UNIQUE (proposal_id, phase);


--
-- Name: learning_trial_step learning_trial_step_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_trial_step
    ADD CONSTRAINT learning_trial_step_pkey PRIMARY KEY (trial_id, stage);


--
-- Name: mcp_access_decision mcp_access_decision_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_access_decision
    ADD CONSTRAINT mcp_access_decision_pkey PRIMARY KEY (id);


--
-- Name: mcp_choice mcp_choice_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_choice
    ADD CONSTRAINT mcp_choice_pkey PRIMARY KEY (library_id, scope, context_id, user_id, role);


--
-- Name: mcp_connect_intent mcp_connect_intent_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_connect_intent
    ADD CONSTRAINT mcp_connect_intent_pkey PRIMARY KEY (id);


--
-- Name: mcp_connection mcp_connection_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_connection
    ADD CONSTRAINT mcp_connection_pkey PRIMARY KEY (id);


--
-- Name: mcp_library_cover mcp_library_cover_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_library_cover
    ADD CONSTRAINT mcp_library_cover_pkey PRIMARY KEY (library_id);


--
-- Name: mcp_library mcp_library_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_library
    ADD CONSTRAINT mcp_library_pkey PRIMARY KEY (id);


--
-- Name: mcp_oauth_flow mcp_oauth_flow_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_oauth_flow
    ADD CONSTRAINT mcp_oauth_flow_pkey PRIMARY KEY (id);


--
-- Name: mcp_oauth_flow mcp_oauth_flow_state_digest_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_oauth_flow
    ADD CONSTRAINT mcp_oauth_flow_state_digest_key UNIQUE (state_digest);


--
-- Name: mcp_observation mcp_observation_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_observation
    ADD CONSTRAINT mcp_observation_pkey PRIMARY KEY (id);


--
-- Name: mcp_policy_approval mcp_policy_approval_connection_id_version_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_policy_approval
    ADD CONSTRAINT mcp_policy_approval_connection_id_version_key UNIQUE (connection_id, version);


--
-- Name: mcp_policy_approval mcp_policy_approval_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_policy_approval
    ADD CONSTRAINT mcp_policy_approval_pkey PRIMARY KEY (id);


--
-- Name: mcp_project_grant mcp_project_grant_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_project_grant
    ADD CONSTRAINT mcp_project_grant_pkey PRIMARY KEY (connection_id, project_id);


--
-- Name: mcp_revision mcp_revision_library_id_revision_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_revision
    ADD CONSTRAINT mcp_revision_library_id_revision_key UNIQUE (library_id, revision);


--
-- Name: mcp_revision mcp_revision_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_revision
    ADD CONSTRAINT mcp_revision_pkey PRIMARY KEY (id);


--
-- Name: mcp_secret_write mcp_secret_write_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_secret_write
    ADD CONSTRAINT mcp_secret_write_pkey PRIMARY KEY (id);


--
-- Name: mcp_secret_write mcp_secret_write_secret_key_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_secret_write
    ADD CONSTRAINT mcp_secret_write_secret_key_key UNIQUE (secret_key);


--
-- Name: mcp_share_proposal mcp_share_proposal_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_share_proposal
    ADD CONSTRAINT mcp_share_proposal_pkey PRIMARY KEY (id);


--
-- Name: mcp_token_refresh mcp_token_refresh_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_token_refresh
    ADD CONSTRAINT mcp_token_refresh_pkey PRIMARY KEY (id);


--
-- Name: merge_operation merge_operation_delivery_approval_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.merge_operation
    ADD CONSTRAINT merge_operation_delivery_approval_id_key UNIQUE (delivery_approval_id);


--
-- Name: merge_operation merge_operation_idempotency_key_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.merge_operation
    ADD CONSTRAINT merge_operation_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: merge_operation merge_operation_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.merge_operation
    ADD CONSTRAINT merge_operation_pkey PRIMARY KEY (id);


--
-- Name: model_connection_version model_connection_version_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.model_connection_version
    ADD CONSTRAINT model_connection_version_pkey PRIMARY KEY (connection_id, version);


--
-- Name: model_connection_version model_connection_version_secret_key_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.model_connection_version
    ADD CONSTRAINT model_connection_version_secret_key_key UNIQUE (secret_key);


--
-- Name: model_connection_write model_connection_write_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.model_connection_write
    ADD CONSTRAINT model_connection_write_pkey PRIMARY KEY (command_id);


--
-- Name: model_connection_write model_connection_write_secret_key_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.model_connection_write
    ADD CONSTRAINT model_connection_write_secret_key_key UNIQUE (secret_key);


--
-- Name: model_defaults model_defaults_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.model_defaults
    ADD CONSTRAINT model_defaults_pkey PRIMARY KEY (singleton);


--
-- Name: model_role_connection model_role_connection_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.model_role_connection
    ADD CONSTRAINT model_role_connection_pkey PRIMARY KEY (role);


--
-- Name: model_role_probe model_role_probe_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.model_role_probe
    ADD CONSTRAINT model_role_probe_pkey PRIMARY KEY (command_id);


--
-- Name: monitoring_command monitoring_command_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.monitoring_command
    ADD CONSTRAINT monitoring_command_pkey PRIMARY KEY (id);


--
-- Name: monitoring_evidence monitoring_evidence_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.monitoring_evidence
    ADD CONSTRAINT monitoring_evidence_pkey PRIMARY KEY (id);


--
-- Name: monitoring_hook monitoring_hook_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.monitoring_hook
    ADD CONSTRAINT monitoring_hook_pkey PRIMARY KEY (id);


--
-- Name: monitoring_incident monitoring_incident_hook_id_fingerprint_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.monitoring_incident
    ADD CONSTRAINT monitoring_incident_hook_id_fingerprint_key UNIQUE (hook_id, fingerprint);


--
-- Name: monitoring_incident monitoring_incident_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.monitoring_incident
    ADD CONSTRAINT monitoring_incident_pkey PRIMARY KEY (id);


--
-- Name: monitoring_policy monitoring_policy_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.monitoring_policy
    ADD CONSTRAINT monitoring_policy_pkey PRIMARY KEY (id);


--
-- Name: personal_git_operation personal_git_operation_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.personal_git_operation
    ADD CONSTRAINT personal_git_operation_pkey PRIMARY KEY (id);


--
-- Name: personal_model_settings personal_model_settings_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.personal_model_settings
    ADD CONSTRAINT personal_model_settings_pkey PRIMARY KEY (project_id, user_id);


--
-- Name: personal_skill_settings personal_skill_settings_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.personal_skill_settings
    ADD CONSTRAINT personal_skill_settings_pkey PRIMARY KEY (project_id, user_id);


--
-- Name: project_delivery_policy project_delivery_policy_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_delivery_policy
    ADD CONSTRAINT project_delivery_policy_pkey PRIMARY KEY (id);


--
-- Name: project_delivery_queue project_delivery_queue_change_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_delivery_queue
    ADD CONSTRAINT project_delivery_queue_change_id_key UNIQUE (change_id);


--
-- Name: project_delivery_queue project_delivery_queue_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_delivery_queue
    ADD CONSTRAINT project_delivery_queue_pkey PRIMARY KEY (project_id);


--
-- Name: project_environment project_environment_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_environment
    ADD CONSTRAINT project_environment_pkey PRIMARY KEY (project_id, environment);


--
-- Name: project_image_preparation project_image_preparation_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_image_preparation
    ADD CONSTRAINT project_image_preparation_pkey PRIMARY KEY (id);


--
-- Name: project_image_preparation project_image_preparation_project_id_environment_revision_e_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_image_preparation
    ADD CONSTRAINT project_image_preparation_project_id_environment_revision_e_key UNIQUE (project_id, environment, revision, environment_version);


--
-- Name: project_image_preparation project_image_preparation_runtime_attempt_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_image_preparation
    ADD CONSTRAINT project_image_preparation_runtime_attempt_id_key UNIQUE (runtime_attempt_id);


--
-- Name: project_membership project_membership_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_membership
    ADD CONSTRAINT project_membership_pkey PRIMARY KEY (project_id, user_id);


--
-- Name: project_model_settings project_model_settings_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_model_settings
    ADD CONSTRAINT project_model_settings_pkey PRIMARY KEY (project_id);


--
-- Name: project project_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project
    ADD CONSTRAINT project_pkey PRIMARY KEY (id);


--
-- Name: project_release project_release_command_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_release
    ADD CONSTRAINT project_release_command_id_key UNIQUE (command_id);


--
-- Name: project_release project_release_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_release
    ADD CONSTRAINT project_release_pkey PRIMARY KEY (id);


--
-- Name: project_release project_release_project_id_version_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_release
    ADD CONSTRAINT project_release_project_id_version_key UNIQUE (project_id, version);


--
-- Name: project_repository_intent project_repository_intent_credential_key_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_repository_intent
    ADD CONSTRAINT project_repository_intent_credential_key_key UNIQUE (credential_key);


--
-- Name: project_repository_intent project_repository_intent_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_repository_intent
    ADD CONSTRAINT project_repository_intent_pkey PRIMARY KEY (command_id);


--
-- Name: project_repository_intent project_repository_intent_project_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_repository_intent
    ADD CONSTRAINT project_repository_intent_project_id_key UNIQUE (project_id);


--
-- Name: project_repository_intent project_repository_intent_setup_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_repository_intent
    ADD CONSTRAINT project_repository_intent_setup_id_key UNIQUE (setup_id);


--
-- Name: project_repository_intent project_repository_intent_slug_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_repository_intent
    ADD CONSTRAINT project_repository_intent_slug_key UNIQUE (slug);


--
-- Name: project_setup_confirmation project_setup_confirmation_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_setup_confirmation
    ADD CONSTRAINT project_setup_confirmation_pkey PRIMARY KEY (inspection_id);


--
-- Name: project_setup_draft project_setup_draft_command_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_setup_draft
    ADD CONSTRAINT project_setup_draft_command_id_key UNIQUE (command_id);


--
-- Name: project_setup_draft project_setup_draft_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_setup_draft
    ADD CONSTRAINT project_setup_draft_pkey PRIMARY KEY (id);


--
-- Name: project_setup_draft project_setup_draft_user_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_setup_draft
    ADD CONSTRAINT project_setup_draft_user_id_key UNIQUE (user_id);


--
-- Name: project_setup_inspection project_setup_inspection_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_setup_inspection
    ADD CONSTRAINT project_setup_inspection_pkey PRIMARY KEY (id);


--
-- Name: project_setup_readiness project_setup_readiness_command_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_setup_readiness
    ADD CONSTRAINT project_setup_readiness_command_id_key UNIQUE (command_id);


--
-- Name: project_setup_readiness project_setup_readiness_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_setup_readiness
    ADD CONSTRAINT project_setup_readiness_pkey PRIMARY KEY (project_id, task);


--
-- Name: project_skill_settings project_skill_settings_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_skill_settings
    ADD CONSTRAINT project_skill_settings_pkey PRIMARY KEY (project_id);


--
-- Name: project project_slug_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project
    ADD CONSTRAINT project_slug_key UNIQUE (slug);


--
-- Name: promotion_operation promotion_operation_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.promotion_operation
    ADD CONSTRAINT promotion_operation_pkey PRIMARY KEY (id);


--
-- Name: promotion_operation promotion_operation_replacement_runtime_attempt_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.promotion_operation
    ADD CONSTRAINT promotion_operation_replacement_runtime_attempt_id_key UNIQUE (replacement_runtime_attempt_id);


--
-- Name: promotion_operation promotion_operation_retry_command_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.promotion_operation
    ADD CONSTRAINT promotion_operation_retry_command_id_key UNIQUE (retry_command_id);


--
-- Name: promotion_operation promotion_operation_sequence; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.promotion_operation
    ADD CONSTRAINT promotion_operation_sequence UNIQUE (change_id, ordinal);


--
-- Name: promotion_operation promotion_operation_supersedes_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.promotion_operation
    ADD CONSTRAINT promotion_operation_supersedes_id_key UNIQUE (supersedes_id);


--
-- Name: pull_request_operation pull_request_operation_change_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.pull_request_operation
    ADD CONSTRAINT pull_request_operation_change_id_key UNIQUE (change_id);


--
-- Name: pull_request_operation pull_request_operation_idempotency_key_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.pull_request_operation
    ADD CONSTRAINT pull_request_operation_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: pull_request_operation pull_request_operation_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.pull_request_operation
    ADD CONSTRAINT pull_request_operation_pkey PRIMARY KEY (id);


--
-- Name: read_version read_version_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.read_version
    ADD CONSTRAINT read_version_pkey PRIMARY KEY (project_id, audience, scope, resource_id);


--
-- Name: release_access release_access_command_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.release_access
    ADD CONSTRAINT release_access_command_id_key UNIQUE (command_id);


--
-- Name: release_access release_access_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.release_access
    ADD CONSTRAINT release_access_pkey PRIMARY KEY (id);


--
-- Name: release_access release_access_username_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.release_access
    ADD CONSTRAINT release_access_username_key UNIQUE (username);


--
-- Name: release_attempt release_attempt_command_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.release_attempt
    ADD CONSTRAINT release_attempt_command_id_key UNIQUE (command_id);


--
-- Name: release_attempt release_attempt_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.release_attempt
    ADD CONSTRAINT release_attempt_pkey PRIMARY KEY (id);


--
-- Name: release_attempt release_attempt_release_id_ordinal_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.release_attempt
    ADD CONSTRAINT release_attempt_release_id_ordinal_key UNIQUE (release_id, ordinal);


--
-- Name: repository_mirror_command repository_mirror_command_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.repository_mirror_command
    ADD CONSTRAINT repository_mirror_command_pkey PRIMARY KEY (id);


--
-- Name: requirement_approval requirement_approval_id_ticket_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.requirement_approval
    ADD CONSTRAINT requirement_approval_id_ticket_id_key UNIQUE (id, ticket_id);


--
-- Name: requirement_approval requirement_approval_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.requirement_approval
    ADD CONSTRAINT requirement_approval_pkey PRIMARY KEY (id);


--
-- Name: requirement_approval requirement_approval_requirement_revision_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.requirement_approval
    ADD CONSTRAINT requirement_approval_requirement_revision_id_key UNIQUE (requirement_revision_id);


--
-- Name: requirement_approval requirement_approval_ticket_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.requirement_approval
    ADD CONSTRAINT requirement_approval_ticket_id_key UNIQUE (ticket_id);


--
-- Name: requirement_revision requirement_revision_id_ticket_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.requirement_revision
    ADD CONSTRAINT requirement_revision_id_ticket_id_key UNIQUE (id, ticket_id);


--
-- Name: requirement_revision requirement_revision_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.requirement_revision
    ADD CONSTRAINT requirement_revision_pkey PRIMARY KEY (id);


--
-- Name: requirement_revision requirement_revision_ticket_id_ordinal_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.requirement_revision
    ADD CONSTRAINT requirement_revision_ticket_id_ordinal_key UNIQUE (ticket_id, ordinal);


--
-- Name: requirements_entry_intent requirements_entry_intent_command_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.requirements_entry_intent
    ADD CONSTRAINT requirements_entry_intent_command_id_key UNIQUE (command_id);


--
-- Name: requirements_entry_intent requirements_entry_intent_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.requirements_entry_intent
    ADD CONSTRAINT requirements_entry_intent_pkey PRIMARY KEY (ticket_id);


--
-- Name: review_feedback_command review_feedback_command_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.review_feedback_command
    ADD CONSTRAINT review_feedback_command_pkey PRIMARY KEY (id);


--
-- Name: review_feedback_command review_feedback_command_turn_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.review_feedback_command
    ADD CONSTRAINT review_feedback_command_turn_id_key UNIQUE (turn_id);


--
-- Name: review_feedback_message review_feedback_message_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.review_feedback_message
    ADD CONSTRAINT review_feedback_message_pkey PRIMARY KEY (id);


--
-- Name: review_feedback review_feedback_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.review_feedback
    ADD CONSTRAINT review_feedback_pkey PRIMARY KEY (id);


--
-- Name: review_media review_media_browser_session_id_kind_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.review_media
    ADD CONSTRAINT review_media_browser_session_id_kind_key UNIQUE (browser_session_id, kind);


--
-- Name: review_media review_media_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.review_media
    ADD CONSTRAINT review_media_pkey PRIMARY KEY (id);


--
-- Name: review_scenario review_scenario_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.review_scenario
    ADD CONSTRAINT review_scenario_pkey PRIMARY KEY (review_id, id);


--
-- Name: runtime_attempt runtime_attempt_id_change_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.runtime_attempt
    ADD CONSTRAINT runtime_attempt_id_change_id_key UNIQUE (id, change_id);


--
-- Name: runtime_attempt runtime_attempt_id_project_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.runtime_attempt
    ADD CONSTRAINT runtime_attempt_id_project_id_key UNIQUE (id, project_id);


--
-- Name: runtime_attempt runtime_attempt_id_workspace_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.runtime_attempt
    ADD CONSTRAINT runtime_attempt_id_workspace_id_key UNIQUE (id, workspace_id);


--
-- Name: runtime_attempt runtime_attempt_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.runtime_attempt
    ADD CONSTRAINT runtime_attempt_pkey PRIMARY KEY (id);


--
-- Name: runtime_attempt runtime_attempt_verification_identity_unique; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.runtime_attempt
    ADD CONSTRAINT runtime_attempt_verification_identity_unique UNIQUE (id, verification_id);


--
-- Name: runtime_compute_wait runtime_compute_wait_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.runtime_compute_wait
    ADD CONSTRAINT runtime_compute_wait_pkey PRIMARY KEY (attempt_id);


--
-- Name: runtime_environment_intent runtime_environment_intent_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.runtime_environment_intent
    ADD CONSTRAINT runtime_environment_intent_pkey PRIMARY KEY (runtime_attempt_id);


--
-- Name: schema_migration schema_migration_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.schema_migration
    ADD CONSTRAINT schema_migration_pkey PRIMARY KEY (version);


--
-- Name: session_archive session_archive_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.session_archive
    ADD CONSTRAINT session_archive_pkey PRIMARY KEY (turn_id);


--
-- Name: shared_document_resolution shared_document_resolution_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.shared_document_resolution
    ADD CONSTRAINT shared_document_resolution_pkey PRIMARY KEY (id);


--
-- Name: skill_library_choice skill_library_choice_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.skill_library_choice
    ADD CONSTRAINT skill_library_choice_pkey PRIMARY KEY (library_id, scope, context_id, user_id, role);


--
-- Name: skill_library_cover skill_library_cover_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.skill_library_cover
    ADD CONSTRAINT skill_library_cover_pkey PRIMARY KEY (library_id);


--
-- Name: skill_library skill_library_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.skill_library
    ADD CONSTRAINT skill_library_pkey PRIMARY KEY (id);


--
-- Name: skill_library_revision skill_library_revision_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.skill_library_revision
    ADD CONSTRAINT skill_library_revision_pkey PRIMARY KEY (revision_id);


--
-- Name: skill_library skill_library_storage_key_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.skill_library
    ADD CONSTRAINT skill_library_storage_key_key UNIQUE (storage_key);


--
-- Name: skill_publication skill_publication_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.skill_publication
    ADD CONSTRAINT skill_publication_pkey PRIMARY KEY (revision_id);


--
-- Name: skill_revision skill_revision_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.skill_revision
    ADD CONSTRAINT skill_revision_pkey PRIMARY KEY (id);


--
-- Name: skill_revision skill_revision_skill_key_revision_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.skill_revision
    ADD CONSTRAINT skill_revision_skill_key_revision_key UNIQUE (skill_key, revision);


--
-- Name: skill_share_proposal skill_share_proposal_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.skill_share_proposal
    ADD CONSTRAINT skill_share_proposal_pkey PRIMARY KEY (id);


--
-- Name: staging_configuration staging_configuration_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.staging_configuration
    ADD CONSTRAINT staging_configuration_pkey PRIMARY KEY (runtime_attempt_id);


--
-- Name: staging_preview staging_preview_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.staging_preview
    ADD CONSTRAINT staging_preview_pkey PRIMARY KEY (project_id);


--
-- Name: staging_preview staging_preview_runtime_attempt_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.staging_preview
    ADD CONSTRAINT staging_preview_runtime_attempt_id_key UNIQUE (runtime_attempt_id);


--
-- Name: substrate_binding substrate_binding_actor_uid_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.substrate_binding
    ADD CONSTRAINT substrate_binding_actor_uid_key UNIQUE (actor_uid);


--
-- Name: substrate_binding substrate_binding_atespace_actor_name_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.substrate_binding
    ADD CONSTRAINT substrate_binding_atespace_actor_name_key UNIQUE (atespace, actor_name);


--
-- Name: substrate_binding substrate_binding_atespace_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.substrate_binding
    ADD CONSTRAINT substrate_binding_atespace_key UNIQUE (atespace);


--
-- Name: substrate_binding substrate_binding_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.substrate_binding
    ADD CONSTRAINT substrate_binding_pkey PRIMARY KEY (runtime_attempt_id);


--
-- Name: substrate_isolated substrate_isolated_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.substrate_isolated
    ADD CONSTRAINT substrate_isolated_pkey PRIMARY KEY (owner_id, kind, generation);


--
-- Name: substrate_isolated substrate_isolated_runtime_attempt_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.substrate_isolated
    ADD CONSTRAINT substrate_isolated_runtime_attempt_id_key UNIQUE (runtime_attempt_id);


--
-- Name: substrate_prebuild substrate_prebuild_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.substrate_prebuild
    ADD CONSTRAINT substrate_prebuild_pkey PRIMARY KEY (preparation_id);


--
-- Name: substrate_prebuild substrate_prebuild_runtime_attempt_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.substrate_prebuild
    ADD CONSTRAINT substrate_prebuild_runtime_attempt_id_key UNIQUE (runtime_attempt_id);


--
-- Name: substrate_source substrate_source_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.substrate_source
    ADD CONSTRAINT substrate_source_pkey PRIMARY KEY (workspace_id);


--
-- Name: substrate_verification substrate_verification_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.substrate_verification
    ADD CONSTRAINT substrate_verification_pkey PRIMARY KEY (runtime_attempt_id);


--
-- Name: substrate_verification substrate_verification_runtime_attempt_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.substrate_verification
    ADD CONSTRAINT substrate_verification_runtime_attempt_id_key UNIQUE (runtime_attempt_id);


--
-- Name: substrate_verification substrate_verification_verification_id_generation_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.substrate_verification
    ADD CONSTRAINT substrate_verification_verification_id_generation_key UNIQUE (verification_id, generation);


--
-- Name: substrate_worker_capacity substrate_worker_capacity_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.substrate_worker_capacity
    ADD CONSTRAINT substrate_worker_capacity_pkey PRIMARY KEY (owner, node_uid);


--
-- Name: substrate_workspace substrate_workspace_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.substrate_workspace
    ADD CONSTRAINT substrate_workspace_pkey PRIMARY KEY (workspace_id, generation);


--
-- Name: system_skill_settings system_skill_settings_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.system_skill_settings
    ADD CONSTRAINT system_skill_settings_pkey PRIMARY KEY (singleton);


--
-- Name: technical_design_revision technical_design_revision_id_ticket_id_requirement_revision_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.technical_design_revision
    ADD CONSTRAINT technical_design_revision_id_ticket_id_requirement_revision_key UNIQUE (id, ticket_id, requirement_revision_id);


--
-- Name: technical_design_revision technical_design_revision_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.technical_design_revision
    ADD CONSTRAINT technical_design_revision_pkey PRIMARY KEY (id);


--
-- Name: technical_design_revision technical_design_revision_ticket_id_ordinal_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.technical_design_revision
    ADD CONSTRAINT technical_design_revision_ticket_id_ordinal_key UNIQUE (ticket_id, ordinal);


--
-- Name: technical_design_revision technical_design_revision_turn_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.technical_design_revision
    ADD CONSTRAINT technical_design_revision_turn_id_key UNIQUE (turn_id);


--
-- Name: ticket_conversation ticket_conversation_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_conversation
    ADD CONSTRAINT ticket_conversation_pkey PRIMARY KEY (id);


--
-- Name: ticket_dependency ticket_dependency_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_dependency
    ADD CONSTRAINT ticket_dependency_pkey PRIMARY KEY (project_id, ticket_id, prerequisite_id);


--
-- Name: ticket_document_revision ticket_document_revision_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_document_revision
    ADD CONSTRAINT ticket_document_revision_pkey PRIMARY KEY (id);


--
-- Name: ticket_document_revision ticket_document_revision_proposal_entry_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_document_revision
    ADD CONSTRAINT ticket_document_revision_proposal_entry_id_key UNIQUE (proposal_entry_id);


--
-- Name: ticket_document_revision ticket_document_revision_ticket_id_ordinal_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_document_revision
    ADD CONSTRAINT ticket_document_revision_ticket_id_ordinal_key UNIQUE (ticket_id, ordinal);


--
-- Name: ticket_follow ticket_follow_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_follow
    ADD CONSTRAINT ticket_follow_pkey PRIMARY KEY (ticket_id, user_id);


--
-- Name: ticket_follow_up ticket_follow_up_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_follow_up
    ADD CONSTRAINT ticket_follow_up_pkey PRIMARY KEY (ticket_id);


--
-- Name: ticket ticket_id_project_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket
    ADD CONSTRAINT ticket_id_project_id_key UNIQUE (id, project_id);


--
-- Name: ticket ticket_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket
    ADD CONSTRAINT ticket_pkey PRIMARY KEY (id);


--
-- Name: ticket_responsibility_event ticket_responsibility_event_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_responsibility_event
    ADD CONSTRAINT ticket_responsibility_event_pkey PRIMARY KEY (id);


--
-- Name: ticket_responsibility ticket_responsibility_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_responsibility
    ADD CONSTRAINT ticket_responsibility_pkey PRIMARY KEY (ticket_id);


--
-- Name: usage_entry usage_entry_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.usage_entry
    ADD CONSTRAINT usage_entry_pkey PRIMARY KEY (operation_id, event_id);


--
-- Name: usage_operation usage_operation_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.usage_operation
    ADD CONSTRAINT usage_operation_pkey PRIMARY KEY (id);


--
-- Name: usage_rate_override usage_rate_override_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.usage_rate_override
    ADD CONSTRAINT usage_rate_override_pkey PRIMARY KEY (provider, model);


--
-- Name: usage_replay_cursor usage_replay_cursor_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.usage_replay_cursor
    ADD CONSTRAINT usage_replay_cursor_pkey PRIMARY KEY (operation_id, session_id);


--
-- Name: user_ui_preference user_ui_preference_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.user_ui_preference
    ADD CONSTRAINT user_ui_preference_pkey PRIMARY KEY (user_id);


--
-- Name: verification verification_change_id_commit_sha_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.verification
    ADD CONSTRAINT verification_change_id_commit_sha_key UNIQUE (change_id, commit_sha);


--
-- Name: verification verification_id_change_id_commit_sha_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.verification
    ADD CONSTRAINT verification_id_change_id_commit_sha_key UNIQUE (id, change_id, commit_sha);


--
-- Name: verification verification_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);


--
-- Name: verification verification_runtime_attempt_id_key; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.verification
    ADD CONSTRAINT verification_runtime_attempt_id_key UNIQUE (runtime_attempt_id);


--
-- Name: wiki_source_update wiki_source_update_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.wiki_source_update
    ADD CONSTRAINT wiki_source_update_pkey PRIMARY KEY (project_id);


--
-- Name: workspace_collaboration_decision workspace_collaboration_decision_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_collaboration_decision
    ADD CONSTRAINT workspace_collaboration_decision_pkey PRIMARY KEY (id);


--
-- Name: workspace_command workspace_command_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_command
    ADD CONSTRAINT workspace_command_pkey PRIMARY KEY (id);


--
-- Name: workspace_file_operation workspace_file_operation_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_file_operation
    ADD CONSTRAINT workspace_file_operation_pkey PRIMARY KEY (id);


--
-- Name: workspace_file_transfer workspace_file_transfer_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_file_transfer
    ADD CONSTRAINT workspace_file_transfer_pkey PRIMARY KEY (id);


--
-- Name: workspace_lifecycle_command workspace_lifecycle_command_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_lifecycle_command
    ADD CONSTRAINT workspace_lifecycle_command_pkey PRIMARY KEY (id);


--
-- Name: workspace_share_decision workspace_share_decision_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_share_decision
    ADD CONSTRAINT workspace_share_decision_pkey PRIMARY KEY (id);


--
-- Name: workspace_share workspace_share_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_share
    ADD CONSTRAINT workspace_share_pkey PRIMARY KEY (workspace_id, user_id);


--
-- Name: workspace_shared_document workspace_shared_document_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_shared_document
    ADD CONSTRAINT workspace_shared_document_pkey PRIMARY KEY (workspace_id, path);


--
-- Name: workspace_submission workspace_submission_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_submission
    ADD CONSTRAINT workspace_submission_pkey PRIMARY KEY (id);


--
-- Name: workspace_terminal_operation workspace_terminal_operation_pkey; Type: CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_terminal_operation
    ADD CONSTRAINT workspace_terminal_operation_pkey PRIMARY KEY (id);


--
-- Name: auth_account_user_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX auth_account_user_idx ON auth.account USING btree (user_id);


--
-- Name: auth_session_user_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX auth_session_user_idx ON auth.session USING btree (user_id);


--
-- Name: auth_verification_identifier_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX auth_verification_identifier_idx ON auth.verification USING btree (identifier);


--
-- Name: oauthAccessToken_authorizationCodeId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "oauthAccessToken_authorizationCodeId_idx" ON auth."oauthAccessToken" USING btree ("authorizationCodeId");


--
-- Name: oauthAccessToken_clientId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "oauthAccessToken_clientId_idx" ON auth."oauthAccessToken" USING btree ("clientId");


--
-- Name: oauthAccessToken_refreshId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "oauthAccessToken_refreshId_idx" ON auth."oauthAccessToken" USING btree ("refreshId");


--
-- Name: oauthAccessToken_sessionId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "oauthAccessToken_sessionId_idx" ON auth."oauthAccessToken" USING btree ("sessionId");


--
-- Name: oauthAccessToken_userId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "oauthAccessToken_userId_idx" ON auth."oauthAccessToken" USING btree ("userId");


--
-- Name: oauthClientResource_clientId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "oauthClientResource_clientId_idx" ON auth."oauthClientResource" USING btree ("clientId");


--
-- Name: oauthClientResource_clientId_resourceId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX "oauthClientResource_clientId_resourceId_idx" ON auth."oauthClientResource" USING btree ("clientId", "resourceId");


--
-- Name: oauthClientResource_resourceId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "oauthClientResource_resourceId_idx" ON auth."oauthClientResource" USING btree ("resourceId");


--
-- Name: oauthClient_userId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "oauthClient_userId_idx" ON auth."oauthClient" USING btree ("userId");


--
-- Name: oauthConsent_clientId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "oauthConsent_clientId_idx" ON auth."oauthConsent" USING btree ("clientId");


--
-- Name: oauthConsent_userId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "oauthConsent_userId_idx" ON auth."oauthConsent" USING btree ("userId");


--
-- Name: oauthRefreshToken_authorizationCodeId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "oauthRefreshToken_authorizationCodeId_idx" ON auth."oauthRefreshToken" USING btree ("authorizationCodeId");


--
-- Name: oauthRefreshToken_clientId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "oauthRefreshToken_clientId_idx" ON auth."oauthRefreshToken" USING btree ("clientId");


--
-- Name: oauthRefreshToken_sessionId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "oauthRefreshToken_sessionId_idx" ON auth."oauthRefreshToken" USING btree ("sessionId");


--
-- Name: oauthRefreshToken_userId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "oauthRefreshToken_userId_idx" ON auth."oauthRefreshToken" USING btree ("userId");


--
-- Name: scimConnectionBinding_connectionId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "scimConnectionBinding_connectionId_idx" ON auth."scimConnectionBinding" USING btree ("connectionId");


--
-- Name: scimGroupMember_connectionId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "scimGroupMember_connectionId_idx" ON auth."scimGroupMember" USING btree ("connectionId");


--
-- Name: scimGroupMember_groupId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "scimGroupMember_groupId_idx" ON auth."scimGroupMember" USING btree ("groupId");


--
-- Name: scimGroupMember_scimUserId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "scimGroupMember_scimUserId_idx" ON auth."scimGroupMember" USING btree ("scimUserId");


--
-- Name: scimGroup_connectionId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "scimGroup_connectionId_idx" ON auth."scimGroup" USING btree ("connectionId");


--
-- Name: scimGroup_provisioningDomainId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "scimGroup_provisioningDomainId_idx" ON auth."scimGroup" USING btree ("provisioningDomainId");


--
-- Name: scimIdentityTombstone_connectionId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "scimIdentityTombstone_connectionId_idx" ON auth."scimIdentityTombstone" USING btree ("connectionId");


--
-- Name: scimIdentityTombstone_provisioningDomainId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "scimIdentityTombstone_provisioningDomainId_idx" ON auth."scimIdentityTombstone" USING btree ("provisioningDomainId");


--
-- Name: scimIdentityTombstone_userId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "scimIdentityTombstone_userId_idx" ON auth."scimIdentityTombstone" USING btree ("userId");


--
-- Name: scimProjectionGrant_connectionId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "scimProjectionGrant_connectionId_idx" ON auth."scimProjectionGrant" USING btree ("connectionId");


--
-- Name: scimProjectionGrant_provisioningDomainId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "scimProjectionGrant_provisioningDomainId_idx" ON auth."scimProjectionGrant" USING btree ("provisioningDomainId");


--
-- Name: scimProjectionGrant_scimUserId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "scimProjectionGrant_scimUserId_idx" ON auth."scimProjectionGrant" USING btree ("scimUserId");


--
-- Name: scimProjectionGrant_userId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "scimProjectionGrant_userId_idx" ON auth."scimProjectionGrant" USING btree ("userId");


--
-- Name: scimSubject_profileSourceId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "scimSubject_profileSourceId_idx" ON auth."scimSubject" USING btree ("profileSourceId");


--
-- Name: scimUser_connectionId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "scimUser_connectionId_idx" ON auth."scimUser" USING btree ("connectionId");


--
-- Name: scimUser_provisioningDomainId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "scimUser_provisioningDomainId_idx" ON auth."scimUser" USING btree ("provisioningDomainId");


--
-- Name: scimUser_userId_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX "scimUser_userId_idx" ON auth."scimUser" USING btree ("userId");


--
-- Name: agent_turn_active_boundary_uidx; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX agent_turn_active_boundary_uidx ON factory.agent_turn USING btree (project_id, (
CASE
    WHEN ((change_id IS NULL) AND ((input ->> 'contextId'::text) IS NOT NULL)) THEN ('context:'::text || (input ->> 'contextId'::text))
    ELSE COALESCE((ticket_id)::text, ('draft:'::text || (created_by)::text))
END)) WHERE (state = ANY (ARRAY['pending'::factory.agent_turn_state, 'dispatching'::factory.agent_turn_state, 'running'::factory.agent_turn_state]));


--
-- Name: agent_turn_recovery_idx; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX agent_turn_recovery_idx ON factory.agent_turn USING btree (state, owner_expires_at) WHERE (state = ANY (ARRAY['pending'::factory.agent_turn_state, 'dispatching'::factory.agent_turn_state, 'running'::factory.agent_turn_state, 'uncertain'::factory.agent_turn_state]));


--
-- Name: agent_turn_unresolved_change_boundary_uidx; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX agent_turn_unresolved_change_boundary_uidx ON factory.agent_turn USING btree (project_id, ticket_id) WHERE ((change_id IS NOT NULL) AND (state = ANY (ARRAY['pending'::factory.agent_turn_state, 'dispatching'::factory.agent_turn_state, 'running'::factory.agent_turn_state, 'uncertain'::factory.agent_turn_state])));


--
-- Name: attachment_project_storage; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX attachment_project_storage ON factory.attachment USING btree (project_id, state);


--
-- Name: attachment_reference_target; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX attachment_reference_target ON factory.attachment_reference USING btree (kind, reference_id);


--
-- Name: branch_create_operation_due_idx; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX branch_create_operation_due_idx ON factory.branch_create_operation USING btree (state, reconcile_after, lease_expires_at);


--
-- Name: build_browser_one_unclosed_session; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX build_browser_one_unclosed_session ON factory.build_browser_session USING btree (turn_id, owner_id) WHERE (state <> 'closed'::text);


--
-- Name: build_browser_session_cleanup_idx; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX build_browser_session_cleanup_idx ON factory.build_browser_session USING btree (runtime_attempt_id) WHERE (state <> 'closed'::text);


--
-- Name: candidate_review_change_idx; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX candidate_review_change_idx ON factory.candidate_review USING btree (change_id);


--
-- Name: candidate_review_finding_source_idx; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX candidate_review_finding_source_idx ON factory.candidate_review USING btree (finding_source_id) WHERE ((finding_source_id IS NOT NULL) AND (supersedes_id IS NULL));


--
-- Name: change_agent_opencode_session_uidx; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX change_agent_opencode_session_uidx ON factory.change_agent_session USING btree (opencode_session_id) WHERE (opencode_session_id IS NOT NULL);


--
-- Name: change_commit_one_active_uidx; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX change_commit_one_active_uidx ON factory.change_commit_operation USING btree (change_id) WHERE (state <> ALL (ARRAY['succeeded'::factory.change_commit_state, 'failed'::factory.change_commit_state]));


--
-- Name: change_editing_request_pending; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX change_editing_request_pending ON factory.change_editing_request USING btree (change_id, requester_id, writer_epoch) WHERE (state = 'requested'::text);


--
-- Name: change_one_active_per_ticket; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX change_one_active_per_ticket ON factory.change USING btree (ticket_id) WHERE (state = ANY (ARRAY['branch-pending'::factory.change_state, 'starting'::factory.change_state, 'active'::factory.change_state, 'cancelling'::factory.change_state]));


--
-- Name: conversation_context_original; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX conversation_context_original ON factory.conversation_context USING btree (conversation_id) WHERE original;


--
-- Name: conversation_entry_question_answer_uidx; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX conversation_entry_question_answer_uidx ON factory.conversation_entry USING btree (in_reply_to_entry_id) WHERE ((kind = 'answer'::factory.conversation_entry_kind) AND (in_reply_to_entry_id IS NOT NULL));


--
-- Name: conversation_entry_requirement_uidx; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX conversation_entry_requirement_uidx ON factory.conversation_entry USING btree (requirement_revision_id) WHERE (requirement_revision_id IS NOT NULL);


--
-- Name: development_workspace_one_per_ticket; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX development_workspace_one_per_ticket ON factory.development_workspace USING btree (ticket_id) WHERE (kind = 'ticket'::factory.development_workspace_kind);


--
-- Name: development_workspace_one_personal_per_user_project; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX development_workspace_one_personal_per_user_project ON factory.development_workspace USING btree (project_id, owner_user_id) WHERE (kind = 'personal'::factory.development_workspace_kind);


--
-- Name: environment_one_pending; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX environment_one_pending ON factory.environment_write USING btree (project_id, environment) WHERE (state = 'write-intended'::text);


--
-- Name: epic_project_parent_idx; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX epic_project_parent_idx ON factory.epic USING btree (project_id, parent_id);


--
-- Name: epic_research_idx; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX epic_research_idx ON factory.epic USING gin (factory.research_vector(title, description));


--
-- Name: epic_title_trgm_idx; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX epic_title_trgm_idx ON factory.epic USING gin (lower(title) factory.gin_trgm_ops);


--
-- Name: implementation_order_one_waiting; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX implementation_order_one_waiting ON factory.implementation_order USING btree (ticket_id) WHERE (state = 'waiting'::text);


--
-- Name: knowledge_generation_one_active_per_project; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX knowledge_generation_one_active_per_project ON factory.knowledge_generation USING btree (project_id) WHERE (state = ANY (ARRAY['pending'::factory.knowledge_generation_state, 'running'::factory.knowledge_generation_state]));


--
-- Name: knowledge_page_outline_project; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX knowledge_page_outline_project ON factory.knowledge_page_outline USING btree (project_id, state);


--
-- Name: knowledge_page_parent_order; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX knowledge_page_parent_order ON factory.knowledge_page USING btree (project_id, parent_id, sort_order, id);


--
-- Name: knowledge_page_search_idx; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX knowledge_page_search_idx ON factory.knowledge_page USING gin (to_tsvector('simple'::regconfig, ((title || ' '::text) || current_body)));


--
-- Name: knowledge_research_idx; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX knowledge_research_idx ON factory.knowledge_page USING gin (factory.research_vector(title, current_body));


--
-- Name: knowledge_title_trgm_idx; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX knowledge_title_trgm_idx ON factory.knowledge_page USING gin (lower(title) factory.gin_trgm_ops);


--
-- Name: learning_case_observed; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX learning_case_observed ON factory.learning_case USING btree (project_id, owner_id, developer_only, settled_at) WHERE selected;


--
-- Name: learning_case_pending; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX learning_case_pending ON factory.learning_case USING btree (project_id, owner_id, developer_only, settled_at) WHERE (selected AND (batch_id IS NULL));


--
-- Name: learning_review_judge; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX learning_review_judge ON factory.learning_review USING btree (judge_key, kind, state);


--
-- Name: learning_trial_running; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX learning_trial_running ON factory.learning_trial USING btree (owner_expires_at) WHERE (state = 'running'::text);


--
-- Name: mcp_connect_running; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX mcp_connect_running ON factory.mcp_connect_intent USING btree (connection_id) WHERE (state = 'running'::text);


--
-- Name: mcp_refresh_pending; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX mcp_refresh_pending ON factory.mcp_token_refresh USING btree (connection_id) WHERE (state = 'intended'::text);


--
-- Name: mcp_secret_pending; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX mcp_secret_pending ON factory.mcp_secret_write USING btree (connection_id) WHERE (state = 'intended'::text);


--
-- Name: merge_operation_one_success; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX merge_operation_one_success ON factory.merge_operation USING btree (change_id) WHERE (state = 'succeeded'::factory.merge_operation_state);


--
-- Name: merge_operation_one_unfinished; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX merge_operation_one_unfinished ON factory.merge_operation USING btree (change_id) WHERE (state <> ALL (ARRAY['succeeded'::factory.merge_operation_state, 'failed'::factory.merge_operation_state]));


--
-- Name: model_connection_pending; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX model_connection_pending ON factory.model_connection_write USING btree (connection_id) WHERE (state = 'write-intended'::text);


--
-- Name: monitoring_pending; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX monitoring_pending ON factory.monitoring_incident USING btree (project_id, received_at, id) WHERE (state = ANY (ARRAY['queued'::text, 'diagnosing'::text, 'implementing'::text]));


--
-- Name: monitoring_ticket; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX monitoring_ticket ON factory.monitoring_incident USING btree (ticket_id) WHERE (ticket_id IS NOT NULL);


--
-- Name: personal_git_operation_workspace; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX personal_git_operation_workspace ON factory.personal_git_operation USING btree (workspace_id, created_at);


--
-- Name: project_delivery_one_active_policy; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX project_delivery_one_active_policy ON factory.project_delivery_policy USING btree (project_id) WHERE (revoked_at IS NULL);


--
-- Name: project_membership_user_idx; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX project_membership_user_idx ON factory.project_membership USING btree (user_id, project_id);


--
-- Name: project_release_one_active; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX project_release_one_active ON factory.project_release USING btree (project_id) WHERE ((state = ANY (ARRAY['pending'::text, 'dispatching'::text, 'running'::text, 'checking'::text, 'publishing'::text, 'uncertain'::text])) AND (ended_at IS NULL));


--
-- Name: project_setup_one_inspection; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX project_setup_one_inspection ON factory.project_setup_inspection USING btree (project_id) WHERE (state = ANY (ARRAY['inspecting'::text, 'proposal'::text, 'confirming'::text]));


--
-- Name: read_version_scope; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX read_version_scope ON factory.read_version USING btree (scope, project_id);


--
-- Name: release_access_publish_attempt; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX release_access_publish_attempt ON factory.release_access USING btree (release_id) WHERE ((scope = 'publish'::text) AND (state = ANY (ARRAY['pending'::text, 'active'::text, 'uncertain'::text])));


--
-- Name: repository_mirror_unconfirmed; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX repository_mirror_unconfirmed ON factory.repository_mirror_command USING btree (project_id) WHERE (state = ANY (ARRAY['executing'::text, 'uncertain'::text]));


--
-- Name: requirement_research_idx; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX requirement_research_idx ON factory.requirement_revision USING gin (factory.research_vector(''::text, canonical_content));


--
-- Name: review_feedback_delivery; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX review_feedback_delivery ON factory.review_feedback USING btree (change_id) WHERE ((kind = 'thread'::text) AND (state <> 'resolved'::text));


--
-- Name: review_media_retention; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX review_media_retention ON factory.review_media USING btree (change_id, kind, state);


--
-- Name: runtime_attempt_active_isolated_idx; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX runtime_attempt_active_isolated_idx ON factory.runtime_attempt USING btree (project_id, isolated_kind, state) WHERE ((isolated_kind IS NOT NULL) AND (state = ANY (ARRAY['create-intended'::factory.runtime_attempt_state, 'starting'::factory.runtime_attempt_state, 'ready'::factory.runtime_attempt_state, 'stop-intended'::factory.runtime_attempt_state, 'stopping'::factory.runtime_attempt_state, 'cleanup-failed'::factory.runtime_attempt_state])));


--
-- Name: runtime_attempt_change_generation_uidx; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX runtime_attempt_change_generation_uidx ON factory.runtime_attempt USING btree (change_id, generation) WHERE (change_id IS NOT NULL);


--
-- Name: runtime_attempt_one_active_per_change; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX runtime_attempt_one_active_per_change ON factory.runtime_attempt USING btree (change_id) WHERE ((change_id IS NOT NULL) AND (state <> ALL (ARRAY['stopped'::factory.runtime_attempt_state, 'failed'::factory.runtime_attempt_state])));


--
-- Name: runtime_attempt_one_active_per_workspace; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX runtime_attempt_one_active_per_workspace ON factory.runtime_attempt USING btree (workspace_id) WHERE ((workspace_id IS NOT NULL) AND (state <> ALL (ARRAY['stopped'::factory.runtime_attempt_state, 'failed'::factory.runtime_attempt_state])));


--
-- Name: runtime_attempt_workspace_generation_uidx; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX runtime_attempt_workspace_generation_uidx ON factory.runtime_attempt USING btree (workspace_id, generation) WHERE (workspace_id IS NOT NULL);


--
-- Name: session_archive_pending; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX session_archive_pending ON factory.session_archive USING btree (retry_after) WHERE (state <> 'saved'::text);


--
-- Name: ticket_conversation_project_draft_uidx; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX ticket_conversation_project_draft_uidx ON factory.ticket_conversation USING btree (project_id, created_by) WHERE (ticket_id IS NULL);


--
-- Name: ticket_conversation_ticket_uidx; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX ticket_conversation_ticket_uidx ON factory.ticket_conversation USING btree (ticket_id) WHERE (ticket_id IS NOT NULL);


--
-- Name: ticket_dependency_prerequisite_idx; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX ticket_dependency_prerequisite_idx ON factory.ticket_dependency USING btree (project_id, prerequisite_id);


--
-- Name: ticket_document_research_idx; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX ticket_document_research_idx ON factory.ticket_document_revision USING gin (factory.research_vector(title, canonical_content));


--
-- Name: ticket_epic_idx; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX ticket_epic_idx ON factory.ticket USING btree (project_id, epic_id);


--
-- Name: ticket_project_updated_idx; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX ticket_project_updated_idx ON factory.ticket USING btree (project_id, updated_at DESC, id DESC);


--
-- Name: ticket_research_idx; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX ticket_research_idx ON factory.ticket USING gin (factory.research_vector(title, description));


--
-- Name: ticket_responsibility_event_recipient; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX ticket_responsibility_event_recipient ON factory.ticket_responsibility_event USING btree (user_id, created_at);


--
-- Name: ticket_title_trgm_idx; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX ticket_title_trgm_idx ON factory.ticket USING gin (lower(title) factory.gin_trgm_ops);


--
-- Name: usage_entry_time_idx; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX usage_entry_time_idx ON factory.usage_entry USING btree (occurred_at);


--
-- Name: usage_operation_scope_time_idx; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX usage_operation_scope_time_idx ON factory.usage_operation USING btree (project_id, created_at);


--
-- Name: verification_one_active_per_change; Type: INDEX; Schema: factory; Owner: -
--

CREATE UNIQUE INDEX verification_one_active_per_change ON factory.verification USING btree (change_id) WHERE (state = ANY (ARRAY['pending'::factory.verification_state, 'runner-starting'::factory.verification_state, 'running'::factory.verification_state]));


--
-- Name: workspace_command_runtime_idx; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX workspace_command_runtime_idx ON factory.workspace_command USING btree (runtime_attempt_id, state);


--
-- Name: workspace_file_transfer_runtime_idx; Type: INDEX; Schema: factory; Owner: -
--

CREATE INDEX workspace_file_transfer_runtime_idx ON factory.workspace_file_transfer USING btree (runtime_attempt_id);


--
-- Name: session check_session_access; Type: TRIGGER; Schema: auth; Owner: -
--

CREATE TRIGGER check_session_access BEFORE INSERT OR UPDATE ON auth.session FOR EACH ROW EXECUTE FUNCTION factory.check_session_access();


--
-- Name: user initialize_account_access; Type: TRIGGER; Schema: auth; Owner: -
--

CREATE TRIGGER initialize_account_access AFTER INSERT ON auth."user" FOR EACH ROW EXECUTE FUNCTION factory.initialize_account_access();


--
-- Name: agent_turn agent_turn_guard; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER agent_turn_guard BEFORE INSERT OR UPDATE ON factory.agent_turn FOR EACH ROW EXECUTE FUNCTION factory.guard_agent_turn();


--
-- Name: agent_turn_mcp agent_turn_mcp_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER agent_turn_mcp_immutable BEFORE DELETE OR UPDATE ON factory.agent_turn_mcp FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();


--
-- Name: agent_turn_skill agent_turn_skill_guard; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER agent_turn_skill_guard BEFORE INSERT OR DELETE OR UPDATE ON factory.agent_turn_skill FOR EACH ROW EXECUTE FUNCTION factory.guard_loaded_skill();


--
-- Name: agent_turn agent_untrashed_ticket; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER agent_untrashed_ticket BEFORE INSERT ON factory.agent_turn FOR EACH ROW EXECUTE FUNCTION factory.require_untrashed_ticket();


--
-- Name: attachment attachment_identity; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER attachment_identity BEFORE UPDATE ON factory.attachment FOR EACH ROW EXECUTE FUNCTION factory.protect_attachment_identity();


--
-- Name: attachment_reference attachment_reference_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER attachment_reference_immutable BEFORE DELETE OR UPDATE ON factory.attachment_reference FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();


--
-- Name: attachment_storage attachment_storage_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER attachment_storage_immutable BEFORE DELETE OR UPDATE ON factory.attachment_storage FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();


--
-- Name: attachment_turn_context attachment_turn_context_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER attachment_turn_context_immutable BEFORE DELETE OR UPDATE ON factory.attachment_turn_context FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();


--
-- Name: branch_create_operation branch_operation_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER branch_operation_immutable BEFORE UPDATE ON factory.branch_create_operation FOR EACH ROW EXECUTE FUNCTION factory.protect_branch_operation();


--
-- Name: build_browser_session build_browser_ordinal_guard; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER build_browser_ordinal_guard BEFORE INSERT OR UPDATE ON factory.build_browser_session FOR EACH ROW EXECUTE FUNCTION factory.guard_build_browser_ordinal();


--
-- Name: build_browser_session build_browser_session_guard; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER build_browser_session_guard BEFORE INSERT OR UPDATE ON factory.build_browser_session FOR EACH ROW EXECUTE FUNCTION factory.guard_build_browser_session();


--
-- Name: candidate_review candidate_review_guard; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER candidate_review_guard BEFORE UPDATE ON factory.candidate_review FOR EACH ROW EXECUTE FUNCTION factory.guard_candidate_review();


--
-- Name: change_agent_turn_intent change_agent_turn_intent_guard; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER change_agent_turn_intent_guard BEFORE INSERT OR UPDATE ON factory.change_agent_turn_intent FOR EACH ROW EXECUTE FUNCTION factory.guard_change_agent_turn_intent();


--
-- Name: change_editing_decision change_editing_decision_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER change_editing_decision_immutable BEFORE DELETE OR UPDATE ON factory.change_editing_decision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();


--
-- Name: change change_identity_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER change_identity_immutable BEFORE UPDATE ON factory.change FOR EACH ROW EXECUTE FUNCTION factory.protect_change_identity();


--
-- Name: change change_prerequisites_guard; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER change_prerequisites_guard BEFORE INSERT ON factory.change FOR EACH ROW EXECUTE FUNCTION factory.guard_change_prerequisites();


--
-- Name: conversation_entry conversation_attachments; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER conversation_attachments AFTER INSERT ON factory.conversation_entry FOR EACH ROW EXECUTE FUNCTION factory.bind_authored_attachments();


--
-- Name: conversation_context conversation_context_identity; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER conversation_context_identity BEFORE UPDATE ON factory.conversation_context FOR EACH ROW EXECUTE FUNCTION factory.guard_conversation_context();


--
-- Name: conversation_entry conversation_entry_no_update; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER conversation_entry_no_update BEFORE DELETE OR UPDATE ON factory.conversation_entry FOR EACH ROW EXECUTE FUNCTION factory.prevent_conversation_entry_mutation();


--
-- Name: delivery_approval delivery_approval_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER delivery_approval_immutable BEFORE DELETE OR UPDATE ON factory.delivery_approval FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();


--
-- Name: project_delivery_policy delivery_policy_identity; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER delivery_policy_identity BEFORE UPDATE ON factory.project_delivery_policy FOR EACH ROW EXECUTE FUNCTION factory.protect_delivery_policy();


--
-- Name: developer_ide developer_ide_intent_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER developer_ide_intent_immutable BEFORE UPDATE ON factory.developer_ide FOR EACH ROW EXECUTE FUNCTION factory.protect_developer_ide_intent();


--
-- Name: development_workspace development_workspace_identity_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER development_workspace_identity_immutable BEFORE UPDATE ON factory.development_workspace FOR EACH ROW EXECUTE FUNCTION factory.protect_development_workspace_identity();


--
-- Name: account_access enqueue_account_revocation; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER enqueue_account_revocation AFTER UPDATE ON factory.account_access FOR EACH ROW EXECUTE FUNCTION factory.enqueue_access_revocation();


--
-- Name: project_membership enqueue_membership_revocation; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER enqueue_membership_revocation AFTER INSERT OR DELETE OR UPDATE ON factory.project_membership FOR EACH ROW EXECUTE FUNCTION factory.enqueue_access_revocation();


--
-- Name: project enqueue_project_access; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER enqueue_project_access AFTER INSERT ON factory.project FOR EACH ROW EXECUTE FUNCTION factory.enqueue_project_access();


--
-- Name: epic_confirmation epic_confirmation_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER epic_confirmation_immutable BEFORE DELETE OR UPDATE ON factory.epic_confirmation FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();


--
-- Name: epic epic_hierarchy_guard; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER epic_hierarchy_guard BEFORE INSERT OR UPDATE ON factory.epic FOR EACH ROW EXECUTE FUNCTION factory.guard_epic_hierarchy();


--
-- Name: execution_policy_command execution_policy_command_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER execution_policy_command_immutable BEFORE UPDATE ON factory.execution_policy_command FOR EACH ROW EXECUTE FUNCTION factory.guard_usage_entry();


--
-- Name: review_feedback_message feedback_attachments; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER feedback_attachments AFTER INSERT ON factory.review_feedback_message FOR EACH ROW EXECUTE FUNCTION factory.bind_authored_attachments();


--
-- Name: usage_entry guard_usage_entry; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER guard_usage_entry BEFORE UPDATE ON factory.usage_entry FOR EACH ROW EXECUTE FUNCTION factory.guard_usage_entry();


--
-- Name: usage_operation guard_usage_operation; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER guard_usage_operation BEFORE UPDATE ON factory.usage_operation FOR EACH ROW EXECUTE FUNCTION factory.guard_usage_operation();


--
-- Name: implementation_order implementation_scope; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER implementation_scope BEFORE UPDATE ON factory.implementation_order FOR EACH ROW EXECUTE FUNCTION factory.protect_implementation_order();


--
-- Name: change initialize_change_writer; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER initialize_change_writer AFTER INSERT ON factory.change FOR EACH ROW EXECUTE FUNCTION factory.initialize_change_writer();


--
-- Name: agent_turn installation_admission; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER installation_admission BEFORE INSERT ON factory.agent_turn FOR EACH ROW EXECUTE FUNCTION factory.require_installation_admission();


--
-- Name: knowledge_generation installation_admission; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER installation_admission BEFORE INSERT ON factory.knowledge_generation FOR EACH ROW EXECUTE FUNCTION factory.require_installation_admission();


--
-- Name: model_role_probe installation_admission; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER installation_admission BEFORE INSERT ON factory.model_role_probe FOR EACH ROW EXECUTE FUNCTION factory.require_installation_admission();


--
-- Name: project_setup_inspection installation_admission; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER installation_admission BEFORE INSERT ON factory.project_setup_inspection FOR EACH ROW EXECUTE FUNCTION factory.require_installation_admission();


--
-- Name: change_commit_operation integration_intent; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER integration_intent BEFORE UPDATE ON factory.change_commit_operation FOR EACH ROW EXECUTE FUNCTION factory.protect_integration_intent();


--
-- Name: knowledge_revision knowledge_attachments; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER knowledge_attachments AFTER INSERT ON factory.knowledge_revision FOR EACH ROW EXECUTE FUNCTION factory.bind_authored_attachments();


--
-- Name: knowledge_page knowledge_hierarchy_guard; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER knowledge_hierarchy_guard BEFORE INSERT OR UPDATE OF id, project_id, parent_id ON factory.knowledge_page FOR EACH ROW EXECUTE FUNCTION factory.guard_knowledge_hierarchy();


--
-- Name: knowledge_page knowledge_page_outline; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER knowledge_page_outline AFTER INSERT OR DELETE OR UPDATE ON factory.knowledge_page FOR EACH ROW EXECUTE FUNCTION factory.project_knowledge_page_outline();


--
-- Name: knowledge_revision knowledge_revision_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER knowledge_revision_immutable BEFORE DELETE OR UPDATE ON factory.knowledge_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();


--
-- Name: learning_application learning_application_guard; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER learning_application_guard BEFORE UPDATE ON factory.learning_application FOR EACH ROW EXECUTE FUNCTION factory.guard_learning_record();


--
-- Name: learning_case learning_case_guard; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER learning_case_guard BEFORE UPDATE ON factory.learning_case FOR EACH ROW EXECUTE FUNCTION factory.guard_learning_record();


--
-- Name: learning_command learning_command_guard; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER learning_command_guard BEFORE UPDATE ON factory.learning_command FOR EACH ROW EXECUTE FUNCTION factory.guard_learning_record();


--
-- Name: learning_proposal learning_proposal_guard; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER learning_proposal_guard BEFORE UPDATE ON factory.learning_proposal FOR EACH ROW EXECUTE FUNCTION factory.guard_learning_record();


--
-- Name: learning_review learning_review_guard; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER learning_review_guard BEFORE UPDATE ON factory.learning_review FOR EACH ROW EXECUTE FUNCTION factory.guard_learning_record();


--
-- Name: learning_source_artifact learning_source_artifact_guard; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER learning_source_artifact_guard BEFORE UPDATE ON factory.learning_source_artifact FOR EACH ROW EXECUTE FUNCTION factory.guard_learning_record();


--
-- Name: learning_trial learning_trial_guard; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER learning_trial_guard BEFORE UPDATE ON factory.learning_trial FOR EACH ROW EXECUTE FUNCTION factory.guard_learning_record();


--
-- Name: learning_trial_step learning_trial_step_guard; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER learning_trial_step_guard BEFORE UPDATE ON factory.learning_trial_step FOR EACH ROW EXECUTE FUNCTION factory.guard_learning_record();


--
-- Name: mcp_access_decision mcp_access_decision_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER mcp_access_decision_immutable BEFORE DELETE OR UPDATE ON factory.mcp_access_decision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();


--
-- Name: mcp_library mcp_library_identity_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER mcp_library_identity_immutable BEFORE DELETE OR UPDATE ON factory.mcp_library FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();


--
-- Name: mcp_observation mcp_observation_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER mcp_observation_immutable BEFORE DELETE OR UPDATE ON factory.mcp_observation FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();


--
-- Name: mcp_policy_approval mcp_policy_approval_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER mcp_policy_approval_immutable BEFORE DELETE OR UPDATE ON factory.mcp_policy_approval FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();


--
-- Name: mcp_revision mcp_revision_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER mcp_revision_immutable BEFORE DELETE OR UPDATE ON factory.mcp_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();


--
-- Name: model_connection_version model_connection_version_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER model_connection_version_immutable BEFORE INSERT OR DELETE OR UPDATE ON factory.model_connection_version FOR EACH ROW EXECUTE FUNCTION factory.protect_model_connection_version();


--
-- Name: model_connection_write model_connection_write_guard; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER model_connection_write_guard BEFORE DELETE OR UPDATE ON factory.model_connection_write FOR EACH ROW EXECUTE FUNCTION factory.protect_model_connection_write();


--
-- Name: model_role_probe model_role_probe_guard; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER model_role_probe_guard BEFORE DELETE OR UPDATE ON factory.model_role_probe FOR EACH ROW EXECUTE FUNCTION factory.protect_model_role_probe();


--
-- Name: monitoring_command monitoring_command_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER monitoring_command_immutable BEFORE DELETE OR UPDATE ON factory.monitoring_command FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();


--
-- Name: monitoring_evidence monitoring_evidence_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER monitoring_evidence_immutable BEFORE DELETE OR UPDATE ON factory.monitoring_evidence FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();


--
-- Name: monitoring_policy monitoring_policy_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER monitoring_policy_immutable BEFORE DELETE OR UPDATE ON factory.monitoring_policy FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();


--
-- Name: change_agent_turn_intent native_skill_intent_guard; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER native_skill_intent_guard BEFORE INSERT OR UPDATE ON factory.change_agent_turn_intent FOR EACH ROW EXECUTE FUNCTION factory.guard_native_skill_intent();


--
-- Name: personal_git_operation personal_git_operation_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER personal_git_operation_immutable BEFORE DELETE OR UPDATE ON factory.personal_git_operation FOR EACH ROW EXECUTE FUNCTION factory.protect_personal_git_operation();


--
-- Name: project project_background_assignment; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER project_background_assignment BEFORE INSERT ON factory.project FOR EACH ROW EXECUTE FUNCTION factory.assign_project_background();


--
-- Name: project_image_preparation project_image_preparation_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER project_image_preparation_immutable BEFORE UPDATE ON factory.project_image_preparation FOR EACH ROW EXECUTE FUNCTION factory.protect_project_image_preparation();


--
-- Name: project_release project_release_identity; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER project_release_identity BEFORE UPDATE ON factory.project_release FOR EACH ROW EXECUTE FUNCTION factory.protect_project_release_identity();


--
-- Name: project_repository_intent project_repository_intent_guard; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER project_repository_intent_guard BEFORE UPDATE ON factory.project_repository_intent FOR EACH ROW EXECUTE FUNCTION factory.guard_project_repository_intent();


--
-- Name: promotion_operation promotion_operation_protection; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER promotion_operation_protection BEFORE INSERT OR UPDATE ON factory.promotion_operation FOR EACH ROW EXECUTE FUNCTION factory.protect_promotion_operation();


--
-- Name: pull_request_operation pull_request_operation_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER pull_request_operation_immutable BEFORE UPDATE ON factory.pull_request_operation FOR EACH ROW EXECUTE FUNCTION factory.protect_pull_request_operation();


--
-- Name: account_access read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.account_access DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: administrator read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.administrator DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: agent_turn read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.agent_turn DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: candidate_review read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.candidate_review DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: change read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.change DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: change_agent_session read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.change_agent_session DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: change_editing_decision read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.change_editing_decision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: change_editing_request read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.change_editing_request DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: change_writer read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.change_writer DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: coding_pause read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.coding_pause DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: conversation_context read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.conversation_context DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: conversation_entry read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.conversation_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: delivery_approval read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.delivery_approval DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: implementation_order read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.implementation_order DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: inbox_receipt read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.inbox_receipt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: knowledge_generation read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.knowledge_generation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: knowledge_page read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.knowledge_page DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: merge_operation read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.merge_operation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: monitoring_hook read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.monitoring_hook DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: monitoring_incident read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.monitoring_incident DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: project read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.project DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: project_delivery_queue read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.project_delivery_queue DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: project_membership read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.project_membership DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: promotion_operation read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.promotion_operation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: pull_request_operation read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.pull_request_operation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: requirement_approval read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.requirement_approval DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: requirement_revision read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.requirement_revision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: review_feedback read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.review_feedback DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: review_feedback_message read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.review_feedback_message DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: review_media read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.review_media DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: review_scenario read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.review_scenario DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: runtime_attempt read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.runtime_attempt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: runtime_compute_wait read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.runtime_compute_wait DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: staging_preview read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.staging_preview DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: technical_design_revision read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.technical_design_revision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: ticket read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.ticket DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: ticket_conversation read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.ticket_conversation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: ticket_document_revision read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.ticket_document_revision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: ticket_follow read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.ticket_follow DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: ticket_responsibility read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.ticket_responsibility DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: ticket_responsibility_event read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.ticket_responsibility_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: verification read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER read_version AFTER INSERT OR DELETE OR UPDATE ON factory.verification DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_factory_reads();


--
-- Name: release_attempt release_attempt_identity; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER release_attempt_identity BEFORE UPDATE ON factory.release_attempt FOR EACH ROW EXECUTE FUNCTION factory.protect_release_attempt_identity();


--
-- Name: repository_mirror_command repository_mirror_command_identity; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER repository_mirror_command_identity BEFORE UPDATE ON factory.repository_mirror_command FOR EACH ROW EXECUTE FUNCTION factory.protect_repository_mirror_command();


--
-- Name: requirement_approval requirement_approval_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER requirement_approval_immutable BEFORE DELETE OR UPDATE ON factory.requirement_approval FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();


--
-- Name: requirement_revision requirement_attachments; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER requirement_attachments AFTER INSERT ON factory.requirement_revision FOR EACH ROW EXECUTE FUNCTION factory.bind_authored_attachments();


--
-- Name: requirement_revision requirement_revision_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER requirement_revision_immutable BEFORE DELETE OR UPDATE ON factory.requirement_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();


--
-- Name: review_media review_media_guard; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER review_media_guard BEFORE UPDATE ON factory.review_media FOR EACH ROW EXECUTE FUNCTION factory.guard_review_media();


--
-- Name: review_scenario review_scenario_guard; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER review_scenario_guard BEFORE INSERT OR UPDATE ON factory.review_scenario FOR EACH ROW EXECUTE FUNCTION factory.guard_review_scenario();


--
-- Name: runtime_attempt runtime_attempt_identity_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER runtime_attempt_identity_immutable BEFORE UPDATE ON factory.runtime_attempt FOR EACH ROW EXECUTE FUNCTION factory.protect_runtime_attempt_identity();


--
-- Name: runtime_environment_intent runtime_environment_intent_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER runtime_environment_intent_immutable BEFORE INSERT OR UPDATE ON factory.runtime_environment_intent FOR EACH ROW EXECUTE FUNCTION factory.protect_runtime_environment_intent();


--
-- Name: runtime_attempt runtime_untrashed_ticket; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER runtime_untrashed_ticket BEFORE INSERT ON factory.runtime_attempt FOR EACH ROW EXECUTE FUNCTION factory.require_untrashed_ticket();


--
-- Name: session_archive session_archive_identity; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER session_archive_identity BEFORE INSERT OR DELETE OR UPDATE ON factory.session_archive FOR EACH ROW EXECUTE FUNCTION factory.protect_session_archive();


--
-- Name: mcp_choice settings_read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER settings_read_version AFTER INSERT OR DELETE OR UPDATE ON factory.mcp_choice DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_settings_reads();


--
-- Name: mcp_connection settings_read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER settings_read_version AFTER INSERT OR DELETE OR UPDATE ON factory.mcp_connection DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_settings_reads();


--
-- Name: mcp_library settings_read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER settings_read_version AFTER INSERT OR DELETE OR UPDATE ON factory.mcp_library DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_settings_reads();


--
-- Name: mcp_library_cover settings_read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER settings_read_version AFTER INSERT OR DELETE OR UPDATE ON factory.mcp_library_cover DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_settings_reads();


--
-- Name: mcp_project_grant settings_read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER settings_read_version AFTER INSERT OR DELETE OR UPDATE ON factory.mcp_project_grant DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_settings_reads();


--
-- Name: mcp_revision settings_read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER settings_read_version AFTER INSERT OR DELETE OR UPDATE ON factory.mcp_revision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_settings_reads();


--
-- Name: monitoring_hook settings_read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER settings_read_version AFTER INSERT OR DELETE OR UPDATE ON factory.monitoring_hook DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_settings_reads();


--
-- Name: monitoring_incident settings_read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER settings_read_version AFTER INSERT OR DELETE OR UPDATE ON factory.monitoring_incident DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_settings_reads();


--
-- Name: project_membership settings_read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER settings_read_version AFTER INSERT OR DELETE OR UPDATE ON factory.project_membership DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_settings_reads();


--
-- Name: project_release settings_read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER settings_read_version AFTER INSERT OR DELETE OR UPDATE ON factory.project_release DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_settings_reads();


--
-- Name: release_access settings_read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER settings_read_version AFTER INSERT OR DELETE OR UPDATE ON factory.release_access DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_settings_reads();


--
-- Name: release_attempt settings_read_version; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER settings_read_version AFTER INSERT OR DELETE OR UPDATE ON factory.release_attempt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.invalidate_settings_reads();


--
-- Name: project_setup_confirmation setup_confirmation_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER setup_confirmation_immutable BEFORE DELETE OR UPDATE ON factory.project_setup_confirmation FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();


--
-- Name: project_setup_inspection setup_inspection_guard; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER setup_inspection_guard BEFORE UPDATE ON factory.project_setup_inspection FOR EACH ROW EXECUTE FUNCTION factory.guard_setup_inspection();


--
-- Name: skill_library skill_library_identity_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER skill_library_identity_immutable BEFORE DELETE OR UPDATE ON factory.skill_library FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();


--
-- Name: skill_library_revision skill_library_revision_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER skill_library_revision_immutable BEFORE DELETE OR UPDATE ON factory.skill_library_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();


--
-- Name: skill_revision skill_revision_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER skill_revision_immutable BEFORE DELETE OR UPDATE ON factory.skill_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();


--
-- Name: staging_configuration staging_configuration_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER staging_configuration_immutable BEFORE INSERT OR DELETE OR UPDATE ON factory.staging_configuration FOR EACH ROW EXECUTE FUNCTION factory.protect_staging_configuration();


--
-- Name: runtime_attempt substrate_attempt_binding; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE CONSTRAINT TRIGGER substrate_attempt_binding AFTER INSERT OR UPDATE ON factory.runtime_attempt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.require_substrate_binding();


--
-- Name: substrate_binding substrate_binding_identity; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER substrate_binding_identity BEFORE INSERT OR DELETE OR UPDATE ON factory.substrate_binding FOR EACH ROW EXECUTE FUNCTION factory.protect_substrate_binding();


--
-- Name: substrate_isolated substrate_isolated_identity; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER substrate_isolated_identity BEFORE INSERT OR DELETE OR UPDATE ON factory.substrate_isolated FOR EACH ROW EXECUTE FUNCTION factory.protect_substrate_isolated();


--
-- Name: substrate_prebuild substrate_prebuild_identity; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER substrate_prebuild_identity BEFORE INSERT OR DELETE OR UPDATE ON factory.substrate_prebuild FOR EACH ROW EXECUTE FUNCTION factory.protect_substrate_prebuild();


--
-- Name: substrate_source substrate_source_identity; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER substrate_source_identity BEFORE INSERT OR DELETE OR UPDATE ON factory.substrate_source FOR EACH ROW EXECUTE FUNCTION factory.protect_substrate_source();


--
-- Name: substrate_verification substrate_verification_identity; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER substrate_verification_identity BEFORE INSERT OR DELETE OR UPDATE ON factory.substrate_verification FOR EACH ROW EXECUTE FUNCTION factory.protect_substrate_verification();


--
-- Name: substrate_worker_capacity substrate_worker_capacity_identity; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER substrate_worker_capacity_identity BEFORE INSERT OR DELETE OR UPDATE ON factory.substrate_worker_capacity FOR EACH ROW EXECUTE FUNCTION factory.protect_substrate_worker_capacity();


--
-- Name: substrate_workspace substrate_workspace_identity; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER substrate_workspace_identity BEFORE INSERT OR DELETE OR UPDATE ON factory.substrate_workspace FOR EACH ROW EXECUTE FUNCTION factory.protect_substrate_workspace();


--
-- Name: technical_design_revision technical_design_revision_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER technical_design_revision_immutable BEFORE DELETE OR UPDATE ON factory.technical_design_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();


--
-- Name: ticket ticket_attachments; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER ticket_attachments AFTER INSERT ON factory.ticket FOR EACH ROW EXECUTE FUNCTION factory.bind_authored_attachments();


--
-- Name: ticket_conversation ticket_conversation_coding_context; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER ticket_conversation_coding_context BEFORE INSERT OR UPDATE OF active_coding_context_id ON factory.ticket_conversation FOR EACH ROW EXECUTE FUNCTION factory.guard_active_coding_context();


--
-- Name: ticket_conversation ticket_conversation_project_guard; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER ticket_conversation_project_guard BEFORE INSERT OR UPDATE OF project_id, ticket_id ON factory.ticket_conversation FOR EACH ROW EXECUTE FUNCTION factory.validate_ticket_conversation_project();


--
-- Name: ticket_dependency ticket_dependency_guard; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER ticket_dependency_guard BEFORE INSERT OR UPDATE ON factory.ticket_dependency FOR EACH ROW EXECUTE FUNCTION factory.guard_ticket_dependency();


--
-- Name: ticket_document_revision ticket_document_attachments; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER ticket_document_attachments AFTER INSERT ON factory.ticket_document_revision FOR EACH ROW EXECUTE FUNCTION factory.bind_authored_attachments();


--
-- Name: ticket_document_revision ticket_document_revision_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER ticket_document_revision_immutable BEFORE DELETE OR UPDATE ON factory.ticket_document_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();


--
-- Name: runtime_attempt ticket_execution_revision; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER ticket_execution_revision BEFORE INSERT ON factory.runtime_attempt FOR EACH ROW EXECUTE FUNCTION factory.require_ticket_execution_revision();


--
-- Name: ticket_follow_up ticket_follow_up_immutable; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER ticket_follow_up_immutable BEFORE DELETE OR UPDATE ON factory.ticket_follow_up FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();


--
-- Name: verification verification_job_binding; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER verification_job_binding BEFORE UPDATE ON factory.verification FOR EACH ROW EXECUTE FUNCTION factory.protect_verification_job_binding();


--
-- Name: development_workspace workspace_runtime_identity; Type: TRIGGER; Schema: factory; Owner: -
--

CREATE TRIGGER workspace_runtime_identity BEFORE UPDATE ON factory.development_workspace FOR EACH ROW EXECUTE FUNCTION factory.protect_workspace_runtime_binding();


--
-- Name: account account_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.account
    ADD CONSTRAINT account_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;


--
-- Name: oauthAccessToken oauthAccessToken_clientId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES auth."oauthClient"("clientId");


--
-- Name: oauthAccessToken oauthAccessToken_refreshId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_refreshId_fkey" FOREIGN KEY ("refreshId") REFERENCES auth."oauthRefreshToken"(id);


--
-- Name: oauthAccessToken oauthAccessToken_sessionId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES auth.session(id) ON DELETE SET NULL;


--
-- Name: oauthAccessToken oauthAccessToken_userId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id);


--
-- Name: oauthClientResource oauthClientResource_clientId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthClientResource"
    ADD CONSTRAINT "oauthClientResource_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES auth."oauthClient"("clientId") ON DELETE CASCADE;


--
-- Name: oauthClientResource oauthClientResource_resourceId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthClientResource"
    ADD CONSTRAINT "oauthClientResource_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES auth."oauthResource"(identifier) ON DELETE CASCADE;


--
-- Name: oauthClient oauthClient_userId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthClient"
    ADD CONSTRAINT "oauthClient_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id);


--
-- Name: oauthConsent oauthConsent_clientId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthConsent"
    ADD CONSTRAINT "oauthConsent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES auth."oauthClient"("clientId");


--
-- Name: oauthConsent oauthConsent_userId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthConsent"
    ADD CONSTRAINT "oauthConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id);


--
-- Name: oauthRefreshToken oauthRefreshToken_clientId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES auth."oauthClient"("clientId");


--
-- Name: oauthRefreshToken oauthRefreshToken_sessionId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES auth.session(id) ON DELETE SET NULL;


--
-- Name: oauthRefreshToken oauthRefreshToken_userId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id);


--
-- Name: scimGroupMember scimGroupMember_groupId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."scimGroupMember"
    ADD CONSTRAINT "scimGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES auth."scimGroup"(id);


--
-- Name: scimGroupMember scimGroupMember_scimUserId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."scimGroupMember"
    ADD CONSTRAINT "scimGroupMember_scimUserId_fkey" FOREIGN KEY ("scimUserId") REFERENCES auth."scimUser"(id);


--
-- Name: scimIdentityTombstone scimIdentityTombstone_userId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."scimIdentityTombstone"
    ADD CONSTRAINT "scimIdentityTombstone_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id);


--
-- Name: scimProjectionGrant scimProjectionGrant_scimUserId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."scimProjectionGrant"
    ADD CONSTRAINT "scimProjectionGrant_scimUserId_fkey" FOREIGN KEY ("scimUserId") REFERENCES auth."scimUser"(id);


--
-- Name: scimProjectionGrant scimProjectionGrant_userId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."scimProjectionGrant"
    ADD CONSTRAINT "scimProjectionGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id);


--
-- Name: scimSubject scimSubject_userId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."scimSubject"
    ADD CONSTRAINT "scimSubject_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id);


--
-- Name: scimUser scimUser_userId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."scimUser"
    ADD CONSTRAINT "scimUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id);


--
-- Name: session session_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.session
    ADD CONSTRAINT session_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;


--
-- Name: ssoProvider ssoProvider_userId_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth."ssoProvider"
    ADD CONSTRAINT "ssoProvider_userId_fkey" FOREIGN KEY ("userId") REFERENCES auth."user"(id);


--
-- Name: access_revocation access_revocation_user_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.access_revocation
    ADD CONSTRAINT access_revocation_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;


--
-- Name: account_access account_access_disabled_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.account_access
    ADD CONSTRAINT account_access_disabled_by_fkey FOREIGN KEY (disabled_by) REFERENCES auth."user"(id);


--
-- Name: account_access account_access_user_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.account_access
    ADD CONSTRAINT account_access_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;


--
-- Name: administrator administrator_user_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.administrator
    ADD CONSTRAINT administrator_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;


--
-- Name: agent_turn agent_turn_change_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.agent_turn
    ADD CONSTRAINT agent_turn_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id) ON DELETE CASCADE;


--
-- Name: agent_turn agent_turn_conversation_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.agent_turn
    ADD CONSTRAINT agent_turn_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES factory.ticket_conversation(id) ON DELETE CASCADE;


--
-- Name: agent_turn agent_turn_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.agent_turn
    ADD CONSTRAINT agent_turn_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: agent_turn_mcp agent_turn_mcp_connection_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.agent_turn_mcp
    ADD CONSTRAINT agent_turn_mcp_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES factory.mcp_connection(id);


--
-- Name: agent_turn_mcp agent_turn_mcp_revision_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.agent_turn_mcp
    ADD CONSTRAINT agent_turn_mcp_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES factory.mcp_revision(id);


--
-- Name: agent_turn_mcp agent_turn_mcp_turn_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.agent_turn_mcp
    ADD CONSTRAINT agent_turn_mcp_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES factory.agent_turn(id);


--
-- Name: agent_turn agent_turn_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.agent_turn
    ADD CONSTRAINT agent_turn_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id) ON DELETE CASCADE;


--
-- Name: agent_turn_skill agent_turn_skill_revision_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.agent_turn_skill
    ADD CONSTRAINT agent_turn_skill_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES factory.skill_revision(id);


--
-- Name: agent_turn_skill agent_turn_skill_turn_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.agent_turn_skill
    ADD CONSTRAINT agent_turn_skill_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES factory.agent_turn(id) ON DELETE CASCADE;


--
-- Name: agent_turn agent_turn_ticket_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.agent_turn
    ADD CONSTRAINT agent_turn_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES factory.ticket(id) ON DELETE CASCADE;


--
-- Name: attachment_draft attachment_draft_owner_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.attachment_draft
    ADD CONSTRAINT attachment_draft_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth."user"(id);


--
-- Name: attachment_draft attachment_draft_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.attachment_draft
    ADD CONSTRAINT attachment_draft_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: attachment attachment_owner_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.attachment
    ADD CONSTRAINT attachment_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth."user"(id);


--
-- Name: attachment attachment_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.attachment
    ADD CONSTRAINT attachment_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: attachment_reference attachment_reference_attachment_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.attachment_reference
    ADD CONSTRAINT attachment_reference_attachment_id_fkey FOREIGN KEY (attachment_id) REFERENCES factory.attachment(id);


--
-- Name: attachment_turn_context attachment_turn_context_turn_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.attachment_turn_context
    ADD CONSTRAINT attachment_turn_context_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES factory.agent_turn(id);


--
-- Name: branch_create_operation branch_create_operation_change_id_branch_name_start_sha_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.branch_create_operation
    ADD CONSTRAINT branch_create_operation_change_id_branch_name_start_sha_fkey FOREIGN KEY (change_id, branch_name, start_sha) REFERENCES factory.change(id, branch_name, base_sha);


--
-- Name: branch_create_operation branch_create_operation_change_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.branch_create_operation
    ADD CONSTRAINT branch_create_operation_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);


--
-- Name: build_browser_session build_browser_session_change_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.build_browser_session
    ADD CONSTRAINT build_browser_session_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);


--
-- Name: build_browser_session build_browser_session_runtime_attempt_id_change_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.build_browser_session
    ADD CONSTRAINT build_browser_session_runtime_attempt_id_change_id_fkey FOREIGN KEY (runtime_attempt_id, change_id) REFERENCES factory.runtime_attempt(id, change_id);


--
-- Name: build_browser_session build_browser_session_turn_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.build_browser_session
    ADD CONSTRAINT build_browser_session_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES factory.agent_turn(id) ON DELETE CASCADE;


--
-- Name: candidate_review candidate_review_change_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.candidate_review
    ADD CONSTRAINT candidate_review_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);


--
-- Name: candidate_review candidate_review_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.candidate_review
    ADD CONSTRAINT candidate_review_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: candidate_review candidate_review_finding_source_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.candidate_review
    ADD CONSTRAINT candidate_review_finding_source_fkey FOREIGN KEY (finding_source_id, change_id, verification_id, commit_sha) REFERENCES factory.candidate_review(id, change_id, verification_id, commit_sha);


--
-- Name: candidate_review candidate_review_focus_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.candidate_review
    ADD CONSTRAINT candidate_review_focus_fkey FOREIGN KEY (focus_review_id) REFERENCES factory.candidate_review(id);


--
-- Name: candidate_review candidate_review_supersedes_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.candidate_review
    ADD CONSTRAINT candidate_review_supersedes_id_fkey FOREIGN KEY (supersedes_id) REFERENCES factory.candidate_review(id);


--
-- Name: candidate_review candidate_review_turn_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.candidate_review
    ADD CONSTRAINT candidate_review_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES factory.agent_turn(id);


--
-- Name: candidate_review candidate_review_verification_id_change_id_commit_sha_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.candidate_review
    ADD CONSTRAINT candidate_review_verification_id_change_id_commit_sha_fkey FOREIGN KEY (verification_id, change_id, commit_sha) REFERENCES factory.verification(id, change_id, commit_sha);


--
-- Name: candidate_review candidate_review_verification_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.candidate_review
    ADD CONSTRAINT candidate_review_verification_id_fkey FOREIGN KEY (verification_id) REFERENCES factory.verification(id);


--
-- Name: change_agent_session change_agent_session_active_turn_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_agent_session
    ADD CONSTRAINT change_agent_session_active_turn_id_fkey FOREIGN KEY (active_turn_id) REFERENCES factory.agent_turn(id);


--
-- Name: change_agent_session change_agent_session_change_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_agent_session
    ADD CONSTRAINT change_agent_session_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);


--
-- Name: change_agent_session change_agent_session_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_agent_session
    ADD CONSTRAINT change_agent_session_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: change_agent_session change_agent_session_runtime_attempt_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_agent_session
    ADD CONSTRAINT change_agent_session_runtime_attempt_id_fkey FOREIGN KEY (runtime_attempt_id) REFERENCES factory.runtime_attempt(id);


--
-- Name: change_agent_session change_agent_session_runtime_change_fk; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_agent_session
    ADD CONSTRAINT change_agent_session_runtime_change_fk FOREIGN KEY (runtime_attempt_id, change_id) REFERENCES factory.runtime_attempt(id, change_id);


--
-- Name: change_agent_turn_intent change_agent_turn_intent_change_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_agent_turn_intent
    ADD CONSTRAINT change_agent_turn_intent_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);


--
-- Name: change_agent_turn_intent change_agent_turn_intent_runtime_attempt_id_change_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_agent_turn_intent
    ADD CONSTRAINT change_agent_turn_intent_runtime_attempt_id_change_id_fkey FOREIGN KEY (runtime_attempt_id, change_id) REFERENCES factory.runtime_attempt(id, change_id);


--
-- Name: change_agent_turn_intent change_agent_turn_intent_turn_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_agent_turn_intent
    ADD CONSTRAINT change_agent_turn_intent_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES factory.agent_turn(id) ON DELETE CASCADE;


--
-- Name: change_commit_operation change_commit_operation_change_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_commit_operation
    ADD CONSTRAINT change_commit_operation_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);


--
-- Name: change_commit_operation change_commit_operation_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_commit_operation
    ADD CONSTRAINT change_commit_operation_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: change_commit_operation change_commit_operation_runtime_attempt_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_commit_operation
    ADD CONSTRAINT change_commit_operation_runtime_attempt_id_fkey FOREIGN KEY (runtime_attempt_id) REFERENCES factory.runtime_attempt(id);


--
-- Name: change_commit_operation change_commit_operation_runtime_change_fk; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_commit_operation
    ADD CONSTRAINT change_commit_operation_runtime_change_fk FOREIGN KEY (runtime_attempt_id, change_id) REFERENCES factory.runtime_attempt(id, change_id);


--
-- Name: change change_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: change change_delivery_waiting_policy_fk; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_delivery_waiting_policy_fk FOREIGN KEY (delivery_waiting_policy_id) REFERENCES factory.project_delivery_policy(id);


--
-- Name: change_editing_decision change_editing_decision_actor_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_editing_decision
    ADD CONSTRAINT change_editing_decision_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth."user"(id);


--
-- Name: change_editing_decision change_editing_decision_change_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_editing_decision
    ADD CONSTRAINT change_editing_decision_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);


--
-- Name: change_editing_decision change_editing_decision_request_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_editing_decision
    ADD CONSTRAINT change_editing_decision_request_id_fkey FOREIGN KEY (request_id) REFERENCES factory.change_editing_request(id);


--
-- Name: change_editing_decision change_editing_decision_target_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_editing_decision
    ADD CONSTRAINT change_editing_decision_target_id_fkey FOREIGN KEY (target_id) REFERENCES auth."user"(id);


--
-- Name: change_editing_request change_editing_request_change_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_editing_request
    ADD CONSTRAINT change_editing_request_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);


--
-- Name: change_editing_request change_editing_request_decided_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_editing_request
    ADD CONSTRAINT change_editing_request_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES auth."user"(id);


--
-- Name: change_editing_request change_editing_request_owner_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_editing_request
    ADD CONSTRAINT change_editing_request_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth."user"(id);


--
-- Name: change_editing_request change_editing_request_requester_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_editing_request
    ADD CONSTRAINT change_editing_request_requester_id_fkey FOREIGN KEY (requester_id) REFERENCES auth."user"(id);


--
-- Name: change change_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: change change_requirement_approval_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_requirement_approval_id_fkey FOREIGN KEY (requirement_approval_id) REFERENCES factory.requirement_approval(id);


--
-- Name: change change_requirement_approval_id_ticket_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_requirement_approval_id_ticket_id_fkey FOREIGN KEY (requirement_approval_id, ticket_id) REFERENCES factory.requirement_approval(id, ticket_id);


--
-- Name: change change_runtime_attempt_fk; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_runtime_attempt_fk FOREIGN KEY (runtime_attempt_id, id) REFERENCES factory.runtime_attempt(id, change_id);


--
-- Name: change change_ticket_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES factory.ticket(id);


--
-- Name: change change_ticket_id_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change
    ADD CONSTRAINT change_ticket_id_project_id_fkey FOREIGN KEY (ticket_id, project_id) REFERENCES factory.ticket(id, project_id);


--
-- Name: change_writer change_writer_change_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_writer
    ADD CONSTRAINT change_writer_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id) ON DELETE CASCADE;


--
-- Name: change_writer change_writer_fence_attempt_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_writer
    ADD CONSTRAINT change_writer_fence_attempt_id_fkey FOREIGN KEY (fence_attempt_id) REFERENCES factory.runtime_attempt(id);


--
-- Name: change_writer change_writer_requested_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_writer
    ADD CONSTRAINT change_writer_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES auth."user"(id);


--
-- Name: change_writer change_writer_user_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.change_writer
    ADD CONSTRAINT change_writer_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id);


--
-- Name: coding_pause coding_pause_resumed_by_turn_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.coding_pause
    ADD CONSTRAINT coding_pause_resumed_by_turn_id_fkey FOREIGN KEY (resumed_by_turn_id) REFERENCES factory.agent_turn(id);


--
-- Name: coding_pause coding_pause_turn_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.coding_pause
    ADD CONSTRAINT coding_pause_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES factory.agent_turn(id) ON DELETE CASCADE;


--
-- Name: conversation_context conversation_context_change_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.conversation_context
    ADD CONSTRAINT conversation_context_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);


--
-- Name: conversation_context conversation_context_conversation_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.conversation_context
    ADD CONSTRAINT conversation_context_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES factory.ticket_conversation(id) ON DELETE CASCADE;


--
-- Name: conversation_context conversation_context_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.conversation_context
    ADD CONSTRAINT conversation_context_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: conversation_context conversation_context_previous_context_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.conversation_context
    ADD CONSTRAINT conversation_context_previous_context_id_fkey FOREIGN KEY (previous_context_id) REFERENCES factory.conversation_context(id);


--
-- Name: conversation_entry conversation_entry_conversation_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.conversation_entry
    ADD CONSTRAINT conversation_entry_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES factory.ticket_conversation(id) ON DELETE CASCADE;


--
-- Name: conversation_entry conversation_entry_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.conversation_entry
    ADD CONSTRAINT conversation_entry_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: conversation_entry conversation_entry_in_reply_to_entry_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.conversation_entry
    ADD CONSTRAINT conversation_entry_in_reply_to_entry_id_fkey FOREIGN KEY (in_reply_to_entry_id) REFERENCES factory.conversation_entry(id) ON DELETE RESTRICT;


--
-- Name: conversation_entry conversation_entry_requirement_revision_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.conversation_entry
    ADD CONSTRAINT conversation_entry_requirement_revision_id_fkey FOREIGN KEY (requirement_revision_id) REFERENCES factory.requirement_revision(id) ON DELETE RESTRICT;


--
-- Name: delivery_approval delivery_approval_approved_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.delivery_approval
    ADD CONSTRAINT delivery_approval_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES auth."user"(id);


--
-- Name: delivery_approval delivery_approval_candidate_review_identity; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.delivery_approval
    ADD CONSTRAINT delivery_approval_candidate_review_identity FOREIGN KEY (candidate_review_id, change_id, verification_id, commit_sha) REFERENCES factory.candidate_review(id, change_id, verification_id, commit_sha);


--
-- Name: delivery_approval delivery_approval_change_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.delivery_approval
    ADD CONSTRAINT delivery_approval_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);


--
-- Name: delivery_approval delivery_approval_monitoring_incident_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.delivery_approval
    ADD CONSTRAINT delivery_approval_monitoring_incident_id_fkey FOREIGN KEY (monitoring_incident_id) REFERENCES factory.monitoring_incident(id);


--
-- Name: delivery_approval delivery_approval_monitoring_policy_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.delivery_approval
    ADD CONSTRAINT delivery_approval_monitoring_policy_id_fkey FOREIGN KEY (monitoring_policy_id) REFERENCES factory.monitoring_policy(id);


--
-- Name: delivery_approval delivery_approval_verification_id_change_id_commit_sha_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.delivery_approval
    ADD CONSTRAINT delivery_approval_verification_id_change_id_commit_sha_fkey FOREIGN KEY (verification_id, change_id, commit_sha) REFERENCES factory.verification(id, change_id, commit_sha);


--
-- Name: delivery_approval delivery_policy_basis_fk; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.delivery_approval
    ADD CONSTRAINT delivery_policy_basis_fk FOREIGN KEY (delivery_policy_id) REFERENCES factory.project_delivery_policy(id);


--
-- Name: developer_ide developer_ide_user_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.developer_ide
    ADD CONSTRAINT developer_ide_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id);


--
-- Name: development_workspace development_workspace_change_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.development_workspace
    ADD CONSTRAINT development_workspace_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);


--
-- Name: development_workspace development_workspace_change_id_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.development_workspace
    ADD CONSTRAINT development_workspace_change_id_project_id_fkey FOREIGN KEY (change_id, project_id) REFERENCES factory.change(id, project_id);


--
-- Name: development_workspace development_workspace_change_id_ticket_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.development_workspace
    ADD CONSTRAINT development_workspace_change_id_ticket_id_fkey FOREIGN KEY (change_id, ticket_id) REFERENCES factory.change(id, ticket_id);


--
-- Name: development_workspace development_workspace_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.development_workspace
    ADD CONSTRAINT development_workspace_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: development_workspace development_workspace_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.development_workspace
    ADD CONSTRAINT development_workspace_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES auth."user"(id);


--
-- Name: development_workspace development_workspace_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.development_workspace
    ADD CONSTRAINT development_workspace_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: development_workspace development_workspace_ticket_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.development_workspace
    ADD CONSTRAINT development_workspace_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES factory.ticket(id);


--
-- Name: development_workspace development_workspace_ticket_id_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.development_workspace
    ADD CONSTRAINT development_workspace_ticket_id_project_id_fkey FOREIGN KEY (ticket_id, project_id) REFERENCES factory.ticket(id, project_id);


--
-- Name: environment_write environment_write_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.environment_write
    ADD CONSTRAINT environment_write_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: environment_write environment_write_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.environment_write
    ADD CONSTRAINT environment_write_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: epic_confirmation epic_confirmation_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.epic_confirmation
    ADD CONSTRAINT epic_confirmation_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: epic_confirmation epic_confirmation_epic_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.epic_confirmation
    ADD CONSTRAINT epic_confirmation_epic_id_fkey FOREIGN KEY (epic_id) REFERENCES factory.epic(id);


--
-- Name: epic_confirmation epic_confirmation_origin_ticket_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.epic_confirmation
    ADD CONSTRAINT epic_confirmation_origin_ticket_id_fkey FOREIGN KEY (origin_ticket_id) REFERENCES factory.ticket(id);


--
-- Name: epic_confirmation epic_confirmation_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.epic_confirmation
    ADD CONSTRAINT epic_confirmation_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: epic_confirmation epic_confirmation_proposal_entry_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.epic_confirmation
    ADD CONSTRAINT epic_confirmation_proposal_entry_id_fkey FOREIGN KEY (proposal_entry_id) REFERENCES factory.conversation_entry(id);


--
-- Name: epic epic_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.epic
    ADD CONSTRAINT epic_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: epic epic_parent_id_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.epic
    ADD CONSTRAINT epic_parent_id_project_id_fkey FOREIGN KEY (parent_id, project_id) REFERENCES factory.epic(id, project_id);


--
-- Name: epic epic_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.epic
    ADD CONSTRAINT epic_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id) ON DELETE CASCADE;


--
-- Name: execution_policy_command execution_policy_command_actor_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.execution_policy_command
    ADD CONSTRAINT execution_policy_command_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth."user"(id);


--
-- Name: execution_policy execution_policy_updated_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.execution_policy
    ADD CONSTRAINT execution_policy_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth."user"(id);


--
-- Name: external_identity external_identity_user_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.external_identity
    ADD CONSTRAINT external_identity_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;


--
-- Name: forge_account_intent forge_account_intent_user_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.forge_account_intent
    ADD CONSTRAINT forge_account_intent_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id);


--
-- Name: forge_branch_intent forge_branch_intent_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.forge_branch_intent
    ADD CONSTRAINT forge_branch_intent_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: forge_connection forge_connection_intended_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.forge_connection
    ADD CONSTRAINT forge_connection_intended_by_fkey FOREIGN KEY (intended_by) REFERENCES auth."user"(id);


--
-- Name: forge_grant_intent forge_grant_intent_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.forge_grant_intent
    ADD CONSTRAINT forge_grant_intent_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: forge_grant_intent forge_grant_intent_user_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.forge_grant_intent
    ADD CONSTRAINT forge_grant_intent_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id);


--
-- Name: forge_identity_intent forge_identity_intent_intended_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.forge_identity_intent
    ADD CONSTRAINT forge_identity_intent_intended_by_fkey FOREIGN KEY (intended_by) REFERENCES auth."user"(id);


--
-- Name: identity_configuration identity_configuration_activated_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.identity_configuration
    ADD CONSTRAINT identity_configuration_activated_by_fkey FOREIGN KEY (activated_by) REFERENCES auth."user"(id);


--
-- Name: identity_configuration identity_configuration_setup_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.identity_configuration
    ADD CONSTRAINT identity_configuration_setup_id_fkey FOREIGN KEY (setup_id) REFERENCES factory.identity_setup(id);


--
-- Name: identity_setup identity_setup_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.identity_setup
    ADD CONSTRAINT identity_setup_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: identity_setup identity_setup_tested_user_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.identity_setup
    ADD CONSTRAINT identity_setup_tested_user_id_fkey FOREIGN KEY (tested_user_id) REFERENCES auth."user"(id);


--
-- Name: implementation_order implementation_order_cancelled_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.implementation_order
    ADD CONSTRAINT implementation_order_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES auth."user"(id);


--
-- Name: implementation_order implementation_order_change_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.implementation_order
    ADD CONSTRAINT implementation_order_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);


--
-- Name: implementation_order implementation_order_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.implementation_order
    ADD CONSTRAINT implementation_order_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: implementation_order implementation_order_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.implementation_order
    ADD CONSTRAINT implementation_order_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: implementation_order implementation_order_requirement_revision_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.implementation_order
    ADD CONSTRAINT implementation_order_requirement_revision_id_fkey FOREIGN KEY (requirement_revision_id) REFERENCES factory.requirement_revision(id);


--
-- Name: implementation_order implementation_order_technical_design_revision_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.implementation_order
    ADD CONSTRAINT implementation_order_technical_design_revision_id_fkey FOREIGN KEY (technical_design_revision_id) REFERENCES factory.technical_design_revision(id);


--
-- Name: implementation_order implementation_order_ticket_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.implementation_order
    ADD CONSTRAINT implementation_order_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES factory.ticket(id);


--
-- Name: inbox_receipt inbox_receipt_user_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.inbox_receipt
    ADD CONSTRAINT inbox_receipt_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;


--
-- Name: knowledge_generation knowledge_generation_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.knowledge_generation
    ADD CONSTRAINT knowledge_generation_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: knowledge_generation knowledge_generation_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.knowledge_generation
    ADD CONSTRAINT knowledge_generation_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: knowledge_generation knowledge_model_connection; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.knowledge_generation
    ADD CONSTRAINT knowledge_model_connection FOREIGN KEY (model_connection_id, model_connection_version) REFERENCES factory.model_connection_version(connection_id, version);


--
-- Name: knowledge_page_alias knowledge_page_alias_page_id_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.knowledge_page_alias
    ADD CONSTRAINT knowledge_page_alias_page_id_project_id_fkey FOREIGN KEY (page_id, project_id) REFERENCES factory.knowledge_page(id, project_id);


--
-- Name: knowledge_page_alias knowledge_page_alias_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.knowledge_page_alias
    ADD CONSTRAINT knowledge_page_alias_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: knowledge_page knowledge_page_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.knowledge_page
    ADD CONSTRAINT knowledge_page_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: knowledge_page knowledge_page_current_revision_fk; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.knowledge_page
    ADD CONSTRAINT knowledge_page_current_revision_fk FOREIGN KEY (current_revision_id, id) REFERENCES factory.knowledge_revision(id, page_id);


--
-- Name: knowledge_page_outline knowledge_page_outline_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.knowledge_page_outline
    ADD CONSTRAINT knowledge_page_outline_id_fkey FOREIGN KEY (id) REFERENCES factory.knowledge_page(id) ON DELETE CASCADE;


--
-- Name: knowledge_page_outline knowledge_page_outline_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.knowledge_page_outline
    ADD CONSTRAINT knowledge_page_outline_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id) ON DELETE CASCADE;


--
-- Name: knowledge_page knowledge_page_parent_project; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.knowledge_page
    ADD CONSTRAINT knowledge_page_parent_project FOREIGN KEY (project_id, parent_id) REFERENCES factory.knowledge_page(project_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: knowledge_page knowledge_page_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.knowledge_page
    ADD CONSTRAINT knowledge_page_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: knowledge_revision knowledge_revision_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.knowledge_revision
    ADD CONSTRAINT knowledge_revision_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: knowledge_revision knowledge_revision_generation_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.knowledge_revision
    ADD CONSTRAINT knowledge_revision_generation_id_fkey FOREIGN KEY (generation_id) REFERENCES factory.knowledge_generation(id);


--
-- Name: knowledge_revision knowledge_revision_page_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.knowledge_revision
    ADD CONSTRAINT knowledge_revision_page_id_fkey FOREIGN KEY (page_id) REFERENCES factory.knowledge_page(id);


--
-- Name: learning_application learning_application_applied_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_application
    ADD CONSTRAINT learning_application_applied_by_fkey FOREIGN KEY (applied_by) REFERENCES auth."user"(id);


--
-- Name: learning_application learning_application_comparison_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_application
    ADD CONSTRAINT learning_application_comparison_id_fkey FOREIGN KEY (comparison_id) REFERENCES factory.learning_trial(id);


--
-- Name: learning_application learning_application_proposal_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_application
    ADD CONSTRAINT learning_application_proposal_id_fkey FOREIGN KEY (proposal_id) REFERENCES factory.learning_proposal(id) ON DELETE CASCADE;


--
-- Name: learning_application learning_application_reverted_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_application
    ADD CONSTRAINT learning_application_reverted_by_fkey FOREIGN KEY (reverted_by) REFERENCES auth."user"(id);


--
-- Name: learning_application learning_application_reverted_comparison_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_application
    ADD CONSTRAINT learning_application_reverted_comparison_id_fkey FOREIGN KEY (reverted_comparison_id) REFERENCES factory.learning_trial(id);


--
-- Name: learning_case learning_case_batch_fk; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_case
    ADD CONSTRAINT learning_case_batch_fk FOREIGN KEY (batch_id) REFERENCES factory.learning_review(id);


--
-- Name: learning_case learning_case_owner_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_case
    ADD CONSTRAINT learning_case_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth."user"(id) ON DELETE CASCADE;


--
-- Name: learning_case learning_case_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_case
    ADD CONSTRAINT learning_case_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id) ON DELETE CASCADE;


--
-- Name: learning_case learning_case_reviewer_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_case
    ADD CONSTRAINT learning_case_reviewer_id_fkey FOREIGN KEY (reviewer_id) REFERENCES auth."user"(id);


--
-- Name: learning_command learning_command_actor_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_command
    ADD CONSTRAINT learning_command_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth."user"(id);


--
-- Name: learning_policy learning_policy_owner_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_policy
    ADD CONSTRAINT learning_policy_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth."user"(id) ON DELETE CASCADE;


--
-- Name: learning_policy learning_policy_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_policy
    ADD CONSTRAINT learning_policy_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id) ON DELETE CASCADE;


--
-- Name: learning_policy learning_policy_updated_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_policy
    ADD CONSTRAINT learning_policy_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth."user"(id);


--
-- Name: learning_proposal learning_proposal_decided_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_proposal
    ADD CONSTRAINT learning_proposal_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES auth."user"(id);


--
-- Name: learning_proposal learning_proposal_review_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_proposal
    ADD CONSTRAINT learning_proposal_review_id_fkey FOREIGN KEY (review_id) REFERENCES factory.learning_review(id) ON DELETE CASCADE;


--
-- Name: learning_proposal learning_proposal_ticket_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_proposal
    ADD CONSTRAINT learning_proposal_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES factory.ticket(id);


--
-- Name: learning_review learning_review_owner_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_review
    ADD CONSTRAINT learning_review_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth."user"(id) ON DELETE CASCADE;


--
-- Name: learning_review learning_review_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_review
    ADD CONSTRAINT learning_review_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id) ON DELETE CASCADE;


--
-- Name: learning_review learning_review_reviewer_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_review
    ADD CONSTRAINT learning_review_reviewer_id_fkey FOREIGN KEY (reviewer_id) REFERENCES auth."user"(id);


--
-- Name: learning_source_artifact learning_source_artifact_turn_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_source_artifact
    ADD CONSTRAINT learning_source_artifact_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES factory.agent_turn(id) ON DELETE CASCADE;


--
-- Name: learning_trial learning_trial_actor_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_trial
    ADD CONSTRAINT learning_trial_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth."user"(id);


--
-- Name: learning_trial learning_trial_proposal_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_trial
    ADD CONSTRAINT learning_trial_proposal_id_fkey FOREIGN KEY (proposal_id) REFERENCES factory.learning_proposal(id) ON DELETE CASCADE;


--
-- Name: learning_trial_step learning_trial_step_trial_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.learning_trial_step
    ADD CONSTRAINT learning_trial_step_trial_id_fkey FOREIGN KEY (trial_id) REFERENCES factory.learning_trial(id) ON DELETE CASCADE;


--
-- Name: mcp_access_decision mcp_access_decision_connection_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_access_decision
    ADD CONSTRAINT mcp_access_decision_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES factory.mcp_connection(id);


--
-- Name: mcp_access_decision mcp_access_decision_decided_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_access_decision
    ADD CONSTRAINT mcp_access_decision_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES auth."user"(id);


--
-- Name: mcp_access_decision mcp_access_decision_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_access_decision
    ADD CONSTRAINT mcp_access_decision_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: mcp_choice mcp_choice_library_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_choice
    ADD CONSTRAINT mcp_choice_library_id_fkey FOREIGN KEY (library_id) REFERENCES factory.mcp_library(id);


--
-- Name: mcp_choice mcp_choice_revision_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_choice
    ADD CONSTRAINT mcp_choice_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES factory.mcp_revision(id);


--
-- Name: mcp_connect_intent mcp_connect_intent_connection_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_connect_intent
    ADD CONSTRAINT mcp_connect_intent_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES factory.mcp_connection(id);


--
-- Name: mcp_connect_intent mcp_connect_intent_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_connect_intent
    ADD CONSTRAINT mcp_connect_intent_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: mcp_connect_intent mcp_connect_intent_revision_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_connect_intent
    ADD CONSTRAINT mcp_connect_intent_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES factory.mcp_revision(id);


--
-- Name: mcp_connection mcp_connection_authorized_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_connection
    ADD CONSTRAINT mcp_connection_authorized_by_fkey FOREIGN KEY (authorized_by) REFERENCES auth."user"(id);


--
-- Name: mcp_connection mcp_connection_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_connection
    ADD CONSTRAINT mcp_connection_id_fkey FOREIGN KEY (id) REFERENCES factory.mcp_library(id);


--
-- Name: mcp_connection mcp_connection_revision_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_connection
    ADD CONSTRAINT mcp_connection_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES factory.mcp_revision(id);


--
-- Name: mcp_library_cover mcp_library_cover_library_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_library_cover
    ADD CONSTRAINT mcp_library_cover_library_id_fkey FOREIGN KEY (library_id) REFERENCES factory.mcp_library(id);


--
-- Name: mcp_library_cover mcp_library_cover_updated_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_library_cover
    ADD CONSTRAINT mcp_library_cover_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth."user"(id);


--
-- Name: mcp_library mcp_library_owner_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_library
    ADD CONSTRAINT mcp_library_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth."user"(id);


--
-- Name: mcp_library mcp_library_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_library
    ADD CONSTRAINT mcp_library_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: mcp_oauth_flow mcp_oauth_flow_connection_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_oauth_flow
    ADD CONSTRAINT mcp_oauth_flow_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES factory.mcp_connection(id);


--
-- Name: mcp_oauth_flow mcp_oauth_flow_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_oauth_flow
    ADD CONSTRAINT mcp_oauth_flow_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: mcp_observation mcp_observation_connection_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_observation
    ADD CONSTRAINT mcp_observation_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES factory.mcp_connection(id);


--
-- Name: mcp_observation mcp_observation_turn_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_observation
    ADD CONSTRAINT mcp_observation_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES factory.agent_turn(id);


--
-- Name: mcp_policy_approval mcp_policy_approval_connection_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_policy_approval
    ADD CONSTRAINT mcp_policy_approval_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES factory.mcp_connection(id);


--
-- Name: mcp_policy_approval mcp_policy_approval_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_policy_approval
    ADD CONSTRAINT mcp_policy_approval_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth."user"(id);


--
-- Name: mcp_policy_approval mcp_policy_approval_revision_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_policy_approval
    ADD CONSTRAINT mcp_policy_approval_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES factory.mcp_revision(id);


--
-- Name: mcp_project_grant mcp_project_grant_connection_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_project_grant
    ADD CONSTRAINT mcp_project_grant_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES factory.mcp_connection(id);


--
-- Name: mcp_project_grant mcp_project_grant_granted_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_project_grant
    ADD CONSTRAINT mcp_project_grant_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES auth."user"(id);


--
-- Name: mcp_project_grant mcp_project_grant_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_project_grant
    ADD CONSTRAINT mcp_project_grant_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: mcp_revision mcp_revision_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_revision
    ADD CONSTRAINT mcp_revision_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: mcp_revision mcp_revision_library_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_revision
    ADD CONSTRAINT mcp_revision_library_id_fkey FOREIGN KEY (library_id) REFERENCES factory.mcp_library(id);


--
-- Name: mcp_secret_write mcp_secret_write_connection_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_secret_write
    ADD CONSTRAINT mcp_secret_write_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES factory.mcp_connection(id);


--
-- Name: mcp_share_proposal mcp_share_proposal_accepted_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_share_proposal
    ADD CONSTRAINT mcp_share_proposal_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES auth."user"(id);


--
-- Name: mcp_share_proposal mcp_share_proposal_accepted_library_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_share_proposal
    ADD CONSTRAINT mcp_share_proposal_accepted_library_id_fkey FOREIGN KEY (accepted_library_id) REFERENCES factory.mcp_library(id);


--
-- Name: mcp_share_proposal mcp_share_proposal_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_share_proposal
    ADD CONSTRAINT mcp_share_proposal_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: mcp_share_proposal mcp_share_proposal_proposed_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_share_proposal
    ADD CONSTRAINT mcp_share_proposal_proposed_by_fkey FOREIGN KEY (proposed_by) REFERENCES auth."user"(id);


--
-- Name: mcp_share_proposal mcp_share_proposal_revision_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_share_proposal
    ADD CONSTRAINT mcp_share_proposal_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES factory.mcp_revision(id);


--
-- Name: mcp_token_refresh mcp_token_refresh_connection_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.mcp_token_refresh
    ADD CONSTRAINT mcp_token_refresh_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES factory.mcp_connection(id);


--
-- Name: merge_operation merge_operation_change_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.merge_operation
    ADD CONSTRAINT merge_operation_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);


--
-- Name: merge_operation merge_operation_delivery_approval_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.merge_operation
    ADD CONSTRAINT merge_operation_delivery_approval_id_fkey FOREIGN KEY (delivery_approval_id) REFERENCES factory.delivery_approval(id);


--
-- Name: model_connection_version model_connection_version_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.model_connection_version
    ADD CONSTRAINT model_connection_version_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: model_connection_write model_connection_write_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.model_connection_write
    ADD CONSTRAINT model_connection_write_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: model_defaults model_defaults_updated_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.model_defaults
    ADD CONSTRAINT model_defaults_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth."user"(id);


--
-- Name: model_role_connection model_role_connection_connection_id_connection_version_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.model_role_connection
    ADD CONSTRAINT model_role_connection_connection_id_connection_version_fkey FOREIGN KEY (connection_id, connection_version) REFERENCES factory.model_connection_version(connection_id, version);


--
-- Name: model_role_connection model_role_connection_updated_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.model_role_connection
    ADD CONSTRAINT model_role_connection_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth."user"(id);


--
-- Name: model_role_probe model_role_probe_connection_id_connection_version_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.model_role_probe
    ADD CONSTRAINT model_role_probe_connection_id_connection_version_fkey FOREIGN KEY (connection_id, connection_version) REFERENCES factory.model_connection_version(connection_id, version);


--
-- Name: model_role_probe model_role_probe_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.model_role_probe
    ADD CONSTRAINT model_role_probe_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: monitoring_command monitoring_command_actor_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.monitoring_command
    ADD CONSTRAINT monitoring_command_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth."user"(id);


--
-- Name: monitoring_command monitoring_command_hook_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.monitoring_command
    ADD CONSTRAINT monitoring_command_hook_id_fkey FOREIGN KEY (hook_id) REFERENCES factory.monitoring_hook(id);


--
-- Name: monitoring_command monitoring_command_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.monitoring_command
    ADD CONSTRAINT monitoring_command_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: monitoring_hook monitoring_current_policy; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.monitoring_hook
    ADD CONSTRAINT monitoring_current_policy FOREIGN KEY (policy_id) REFERENCES factory.monitoring_policy(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: monitoring_evidence monitoring_evidence_incident_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.monitoring_evidence
    ADD CONSTRAINT monitoring_evidence_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES factory.monitoring_incident(id);


--
-- Name: monitoring_hook monitoring_hook_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.monitoring_hook
    ADD CONSTRAINT monitoring_hook_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: monitoring_incident monitoring_incident_hook_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.monitoring_incident
    ADD CONSTRAINT monitoring_incident_hook_id_fkey FOREIGN KEY (hook_id) REFERENCES factory.monitoring_hook(id);


--
-- Name: monitoring_incident monitoring_incident_policy_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.monitoring_incident
    ADD CONSTRAINT monitoring_incident_policy_id_fkey FOREIGN KEY (policy_id) REFERENCES factory.monitoring_policy(id);


--
-- Name: monitoring_incident monitoring_incident_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.monitoring_incident
    ADD CONSTRAINT monitoring_incident_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: monitoring_incident monitoring_incident_ticket_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.monitoring_incident
    ADD CONSTRAINT monitoring_incident_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES factory.ticket(id);


--
-- Name: monitoring_policy monitoring_policy_connection_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.monitoring_policy
    ADD CONSTRAINT monitoring_policy_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES factory.mcp_connection(id);


--
-- Name: monitoring_policy monitoring_policy_delegated_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.monitoring_policy
    ADD CONSTRAINT monitoring_policy_delegated_by_fkey FOREIGN KEY (delegated_by) REFERENCES auth."user"(id);


--
-- Name: monitoring_policy monitoring_policy_hook_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.monitoring_policy
    ADD CONSTRAINT monitoring_policy_hook_id_fkey FOREIGN KEY (hook_id) REFERENCES factory.monitoring_hook(id);


--
-- Name: personal_git_operation personal_git_operation_runtime_attempt_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.personal_git_operation
    ADD CONSTRAINT personal_git_operation_runtime_attempt_id_fkey FOREIGN KEY (runtime_attempt_id) REFERENCES factory.runtime_attempt(id);


--
-- Name: personal_git_operation personal_git_operation_runtime_attempt_id_workspace_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.personal_git_operation
    ADD CONSTRAINT personal_git_operation_runtime_attempt_id_workspace_id_fkey FOREIGN KEY (runtime_attempt_id, workspace_id) REFERENCES factory.runtime_attempt(id, workspace_id);


--
-- Name: personal_git_operation personal_git_operation_user_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.personal_git_operation
    ADD CONSTRAINT personal_git_operation_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id);


--
-- Name: personal_git_operation personal_git_operation_workspace_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.personal_git_operation
    ADD CONSTRAINT personal_git_operation_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES factory.development_workspace(id);


--
-- Name: personal_model_settings personal_model_settings_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.personal_model_settings
    ADD CONSTRAINT personal_model_settings_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id) ON DELETE CASCADE;


--
-- Name: personal_model_settings personal_model_settings_user_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.personal_model_settings
    ADD CONSTRAINT personal_model_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;


--
-- Name: personal_skill_settings personal_skill_settings_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.personal_skill_settings
    ADD CONSTRAINT personal_skill_settings_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id) ON DELETE CASCADE;


--
-- Name: personal_skill_settings personal_skill_settings_user_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.personal_skill_settings
    ADD CONSTRAINT personal_skill_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;


--
-- Name: project project_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project
    ADD CONSTRAINT project_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: project_delivery_policy project_delivery_policy_delegated_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_delivery_policy
    ADD CONSTRAINT project_delivery_policy_delegated_by_fkey FOREIGN KEY (delegated_by) REFERENCES auth."user"(id);


--
-- Name: project_delivery_policy project_delivery_policy_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_delivery_policy
    ADD CONSTRAINT project_delivery_policy_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: project_delivery_policy project_delivery_policy_revoked_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_delivery_policy
    ADD CONSTRAINT project_delivery_policy_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES auth."user"(id);


--
-- Name: project_delivery_queue project_delivery_queue_change_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_delivery_queue
    ADD CONSTRAINT project_delivery_queue_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);


--
-- Name: project_delivery_queue project_delivery_queue_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_delivery_queue
    ADD CONSTRAINT project_delivery_queue_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: project_environment project_environment_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_environment
    ADD CONSTRAINT project_environment_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: project_image_preparation project_image_preparation_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_image_preparation
    ADD CONSTRAINT project_image_preparation_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: project_image_preparation project_image_preparation_runtime_attempt_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_image_preparation
    ADD CONSTRAINT project_image_preparation_runtime_attempt_id_fkey FOREIGN KEY (runtime_attempt_id) REFERENCES factory.runtime_attempt(id);


--
-- Name: project_membership project_membership_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_membership
    ADD CONSTRAINT project_membership_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id) ON DELETE CASCADE;


--
-- Name: project_membership project_membership_updated_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_membership
    ADD CONSTRAINT project_membership_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth."user"(id);


--
-- Name: project_membership project_membership_user_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_membership
    ADD CONSTRAINT project_membership_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;


--
-- Name: project_model_settings project_model_settings_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_model_settings
    ADD CONSTRAINT project_model_settings_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id) ON DELETE CASCADE;


--
-- Name: project_model_settings project_model_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_model_settings
    ADD CONSTRAINT project_model_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth."user"(id);


--
-- Name: project_release project_release_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_release
    ADD CONSTRAINT project_release_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: project_release project_release_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_release
    ADD CONSTRAINT project_release_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: project_repository_intent project_repository_intent_user_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_repository_intent
    ADD CONSTRAINT project_repository_intent_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id);


--
-- Name: project_setup_confirmation project_setup_confirmation_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_setup_confirmation
    ADD CONSTRAINT project_setup_confirmation_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: project_setup_confirmation project_setup_confirmation_inspection_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_setup_confirmation
    ADD CONSTRAINT project_setup_confirmation_inspection_id_fkey FOREIGN KEY (inspection_id) REFERENCES factory.project_setup_inspection(id);


--
-- Name: project_setup_draft project_setup_draft_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_setup_draft
    ADD CONSTRAINT project_setup_draft_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: project_setup_draft project_setup_draft_user_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_setup_draft
    ADD CONSTRAINT project_setup_draft_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;


--
-- Name: project_setup_inspection project_setup_inspection_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_setup_inspection
    ADD CONSTRAINT project_setup_inspection_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: project_setup_inspection project_setup_inspection_parent_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_setup_inspection
    ADD CONSTRAINT project_setup_inspection_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES factory.project_setup_inspection(id);


--
-- Name: project_setup_inspection project_setup_inspection_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_setup_inspection
    ADD CONSTRAINT project_setup_inspection_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id) ON DELETE CASCADE;


--
-- Name: project_setup_readiness project_setup_readiness_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_setup_readiness
    ADD CONSTRAINT project_setup_readiness_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id) ON DELETE CASCADE;


--
-- Name: project_skill_settings project_skill_settings_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_skill_settings
    ADD CONSTRAINT project_skill_settings_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id) ON DELETE CASCADE;


--
-- Name: project_skill_settings project_skill_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.project_skill_settings
    ADD CONSTRAINT project_skill_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth."user"(id);


--
-- Name: promotion_operation promotion_operation_change_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.promotion_operation
    ADD CONSTRAINT promotion_operation_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);


--
-- Name: promotion_operation promotion_operation_previous_runtime_attempt_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.promotion_operation
    ADD CONSTRAINT promotion_operation_previous_runtime_attempt_id_fkey FOREIGN KEY (previous_runtime_attempt_id) REFERENCES factory.runtime_attempt(id);


--
-- Name: promotion_operation promotion_operation_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.promotion_operation
    ADD CONSTRAINT promotion_operation_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: promotion_operation promotion_operation_replacement_runtime_attempt_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.promotion_operation
    ADD CONSTRAINT promotion_operation_replacement_runtime_attempt_id_fkey FOREIGN KEY (replacement_runtime_attempt_id) REFERENCES factory.runtime_attempt(id);


--
-- Name: promotion_operation promotion_operation_retry_command_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.promotion_operation
    ADD CONSTRAINT promotion_operation_retry_command_id_fkey FOREIGN KEY (retry_command_id) REFERENCES factory.execution_policy_command(command_id);


--
-- Name: promotion_operation promotion_operation_supersedes_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.promotion_operation
    ADD CONSTRAINT promotion_operation_supersedes_id_fkey FOREIGN KEY (supersedes_id) REFERENCES factory.promotion_operation(id);


--
-- Name: pull_request_operation pull_request_operation_change_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.pull_request_operation
    ADD CONSTRAINT pull_request_operation_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);


--
-- Name: read_version read_version_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.read_version
    ADD CONSTRAINT read_version_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id) ON DELETE CASCADE;


--
-- Name: release_access release_access_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.release_access
    ADD CONSTRAINT release_access_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: release_access release_access_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.release_access
    ADD CONSTRAINT release_access_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: release_access release_access_release_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.release_access
    ADD CONSTRAINT release_access_release_id_fkey FOREIGN KEY (release_id) REFERENCES factory.project_release(id);


--
-- Name: release_access release_access_replaces_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.release_access
    ADD CONSTRAINT release_access_replaces_id_fkey FOREIGN KEY (replaces_id) REFERENCES factory.release_access(id);


--
-- Name: release_attempt release_attempt_release_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.release_attempt
    ADD CONSTRAINT release_attempt_release_id_fkey FOREIGN KEY (release_id) REFERENCES factory.project_release(id);


--
-- Name: release_attempt release_attempt_runtime_attempt_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.release_attempt
    ADD CONSTRAINT release_attempt_runtime_attempt_id_fkey FOREIGN KEY (runtime_attempt_id) REFERENCES factory.runtime_attempt(id);


--
-- Name: repository_mirror_command repository_mirror_command_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.repository_mirror_command
    ADD CONSTRAINT repository_mirror_command_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: repository_mirror_command repository_mirror_command_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.repository_mirror_command
    ADD CONSTRAINT repository_mirror_command_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: requirement_approval requirement_approval_approved_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.requirement_approval
    ADD CONSTRAINT requirement_approval_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES auth."user"(id);


--
-- Name: requirement_approval requirement_approval_monitoring_incident_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.requirement_approval
    ADD CONSTRAINT requirement_approval_monitoring_incident_id_fkey FOREIGN KEY (monitoring_incident_id) REFERENCES factory.monitoring_incident(id);


--
-- Name: requirement_approval requirement_approval_monitoring_policy_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.requirement_approval
    ADD CONSTRAINT requirement_approval_monitoring_policy_id_fkey FOREIGN KEY (monitoring_policy_id) REFERENCES factory.monitoring_policy(id);


--
-- Name: requirement_approval requirement_approval_requirement_revision_id_ticket_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.requirement_approval
    ADD CONSTRAINT requirement_approval_requirement_revision_id_ticket_id_fkey FOREIGN KEY (requirement_revision_id, ticket_id) REFERENCES factory.requirement_revision(id, ticket_id);


--
-- Name: requirement_approval requirement_approval_technical_design_fk; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.requirement_approval
    ADD CONSTRAINT requirement_approval_technical_design_fk FOREIGN KEY (technical_design_revision_id, ticket_id, requirement_revision_id) REFERENCES factory.technical_design_revision(id, ticket_id, requirement_revision_id);


--
-- Name: requirement_approval requirement_approval_ticket_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.requirement_approval
    ADD CONSTRAINT requirement_approval_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES factory.ticket(id);


--
-- Name: requirement_revision requirement_revision_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.requirement_revision
    ADD CONSTRAINT requirement_revision_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: requirement_revision requirement_revision_ticket_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.requirement_revision
    ADD CONSTRAINT requirement_revision_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES factory.ticket(id);


--
-- Name: requirements_entry_intent requirements_entry_intent_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.requirements_entry_intent
    ADD CONSTRAINT requirements_entry_intent_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: requirements_entry_intent requirements_entry_intent_ticket_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.requirements_entry_intent
    ADD CONSTRAINT requirements_entry_intent_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES factory.ticket(id) ON DELETE CASCADE;


--
-- Name: review_feedback review_feedback_author_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.review_feedback
    ADD CONSTRAINT review_feedback_author_id_fkey FOREIGN KEY (author_id) REFERENCES auth."user"(id);


--
-- Name: review_feedback review_feedback_change_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.review_feedback
    ADD CONSTRAINT review_feedback_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);


--
-- Name: review_feedback_command review_feedback_command_actor_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.review_feedback_command
    ADD CONSTRAINT review_feedback_command_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth."user"(id);


--
-- Name: review_feedback_command review_feedback_command_change_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.review_feedback_command
    ADD CONSTRAINT review_feedback_command_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);


--
-- Name: review_feedback_command review_feedback_command_feedback_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.review_feedback_command
    ADD CONSTRAINT review_feedback_command_feedback_id_fkey FOREIGN KEY (feedback_id) REFERENCES factory.review_feedback(id);


--
-- Name: review_feedback_command review_feedback_command_turn_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.review_feedback_command
    ADD CONSTRAINT review_feedback_command_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES factory.agent_turn(id);


--
-- Name: review_feedback review_feedback_media_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.review_feedback
    ADD CONSTRAINT review_feedback_media_id_fkey FOREIGN KEY (media_id) REFERENCES factory.review_media(id);


--
-- Name: review_feedback_message review_feedback_message_author_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.review_feedback_message
    ADD CONSTRAINT review_feedback_message_author_id_fkey FOREIGN KEY (author_id) REFERENCES auth."user"(id);


--
-- Name: review_feedback_message review_feedback_message_feedback_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.review_feedback_message
    ADD CONSTRAINT review_feedback_message_feedback_id_fkey FOREIGN KEY (feedback_id) REFERENCES factory.review_feedback(id);


--
-- Name: review_feedback review_feedback_resolved_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.review_feedback
    ADD CONSTRAINT review_feedback_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES auth."user"(id);


--
-- Name: review_media review_media_browser_session_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.review_media
    ADD CONSTRAINT review_media_browser_session_id_fkey FOREIGN KEY (browser_session_id) REFERENCES factory.build_browser_session(id);


--
-- Name: review_media review_media_change_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.review_media
    ADD CONSTRAINT review_media_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);


--
-- Name: review_media review_media_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.review_media
    ADD CONSTRAINT review_media_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: review_media review_media_review_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.review_media
    ADD CONSTRAINT review_media_review_id_fkey FOREIGN KEY (review_id) REFERENCES factory.candidate_review(id);


--
-- Name: review_media review_media_runtime_attempt_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.review_media
    ADD CONSTRAINT review_media_runtime_attempt_id_fkey FOREIGN KEY (runtime_attempt_id) REFERENCES factory.runtime_attempt(id);


--
-- Name: review_scenario review_scenario_media_session_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.review_scenario
    ADD CONSTRAINT review_scenario_media_session_id_fkey FOREIGN KEY (media_session_id) REFERENCES factory.build_browser_session(id);


--
-- Name: review_scenario review_scenario_review_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.review_scenario
    ADD CONSTRAINT review_scenario_review_id_fkey FOREIGN KEY (review_id) REFERENCES factory.candidate_review(id);


--
-- Name: runtime_attempt runtime_attempt_change_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.runtime_attempt
    ADD CONSTRAINT runtime_attempt_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);


--
-- Name: runtime_attempt runtime_attempt_change_project_fk; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.runtime_attempt
    ADD CONSTRAINT runtime_attempt_change_project_fk FOREIGN KEY (change_id, project_id) REFERENCES factory.change(id, project_id);


--
-- Name: runtime_attempt runtime_attempt_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.runtime_attempt
    ADD CONSTRAINT runtime_attempt_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: runtime_attempt runtime_attempt_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.runtime_attempt
    ADD CONSTRAINT runtime_attempt_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: runtime_attempt runtime_attempt_verification_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.runtime_attempt
    ADD CONSTRAINT runtime_attempt_verification_id_fkey FOREIGN KEY (verification_id) REFERENCES factory.verification(id);


--
-- Name: runtime_attempt runtime_attempt_workspace_change_fk; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.runtime_attempt
    ADD CONSTRAINT runtime_attempt_workspace_change_fk FOREIGN KEY (workspace_id, change_id) REFERENCES factory.development_workspace(id, change_id);


--
-- Name: runtime_attempt runtime_attempt_workspace_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.runtime_attempt
    ADD CONSTRAINT runtime_attempt_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES factory.development_workspace(id);


--
-- Name: runtime_attempt runtime_attempt_workspace_project_fk; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.runtime_attempt
    ADD CONSTRAINT runtime_attempt_workspace_project_fk FOREIGN KEY (workspace_id, project_id) REFERENCES factory.development_workspace(id, project_id);


--
-- Name: runtime_compute_wait runtime_compute_wait_attempt_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.runtime_compute_wait
    ADD CONSTRAINT runtime_compute_wait_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES factory.runtime_attempt(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


--
-- Name: runtime_environment_intent runtime_environment_intent_runtime_attempt_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.runtime_environment_intent
    ADD CONSTRAINT runtime_environment_intent_runtime_attempt_id_fkey FOREIGN KEY (runtime_attempt_id) REFERENCES factory.runtime_attempt(id);


--
-- Name: session_archive session_archive_runtime_attempt_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.session_archive
    ADD CONSTRAINT session_archive_runtime_attempt_id_fkey FOREIGN KEY (runtime_attempt_id) REFERENCES factory.runtime_attempt(id);


--
-- Name: session_archive session_archive_turn_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.session_archive
    ADD CONSTRAINT session_archive_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES factory.agent_turn(id);


--
-- Name: shared_document_resolution shared_document_resolution_actor_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.shared_document_resolution
    ADD CONSTRAINT shared_document_resolution_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth."user"(id);


--
-- Name: shared_document_resolution shared_document_resolution_workspace_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.shared_document_resolution
    ADD CONSTRAINT shared_document_resolution_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES factory.development_workspace(id);


--
-- Name: skill_library_choice skill_library_choice_library_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.skill_library_choice
    ADD CONSTRAINT skill_library_choice_library_id_fkey FOREIGN KEY (library_id) REFERENCES factory.skill_library(id);


--
-- Name: skill_library_choice skill_library_choice_revision_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.skill_library_choice
    ADD CONSTRAINT skill_library_choice_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES factory.skill_revision(id);


--
-- Name: skill_library_cover skill_library_cover_library_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.skill_library_cover
    ADD CONSTRAINT skill_library_cover_library_id_fkey FOREIGN KEY (library_id) REFERENCES factory.skill_library(id);


--
-- Name: skill_library_cover skill_library_cover_updated_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.skill_library_cover
    ADD CONSTRAINT skill_library_cover_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth."user"(id);


--
-- Name: skill_library skill_library_owner_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.skill_library
    ADD CONSTRAINT skill_library_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth."user"(id);


--
-- Name: skill_library skill_library_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.skill_library
    ADD CONSTRAINT skill_library_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: skill_library_revision skill_library_revision_copied_from_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.skill_library_revision
    ADD CONSTRAINT skill_library_revision_copied_from_fkey FOREIGN KEY (copied_from) REFERENCES factory.skill_revision(id);


--
-- Name: skill_library_revision skill_library_revision_library_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.skill_library_revision
    ADD CONSTRAINT skill_library_revision_library_id_fkey FOREIGN KEY (library_id) REFERENCES factory.skill_library(id);


--
-- Name: skill_library_revision skill_library_revision_revision_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.skill_library_revision
    ADD CONSTRAINT skill_library_revision_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES factory.skill_revision(id);


--
-- Name: skill_publication skill_publication_revision_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.skill_publication
    ADD CONSTRAINT skill_publication_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES factory.skill_revision(id);


--
-- Name: skill_publication skill_publication_updated_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.skill_publication
    ADD CONSTRAINT skill_publication_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth."user"(id);


--
-- Name: skill_revision skill_revision_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.skill_revision
    ADD CONSTRAINT skill_revision_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: skill_share_proposal skill_share_proposal_accepted_library_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.skill_share_proposal
    ADD CONSTRAINT skill_share_proposal_accepted_library_id_fkey FOREIGN KEY (accepted_library_id) REFERENCES factory.skill_library(id);


--
-- Name: skill_share_proposal skill_share_proposal_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.skill_share_proposal
    ADD CONSTRAINT skill_share_proposal_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: skill_share_proposal skill_share_proposal_proposed_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.skill_share_proposal
    ADD CONSTRAINT skill_share_proposal_proposed_by_fkey FOREIGN KEY (proposed_by) REFERENCES auth."user"(id);


--
-- Name: skill_share_proposal skill_share_proposal_revision_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.skill_share_proposal
    ADD CONSTRAINT skill_share_proposal_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES factory.skill_revision(id);


--
-- Name: staging_configuration staging_configuration_attempt_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.staging_configuration
    ADD CONSTRAINT staging_configuration_attempt_fkey FOREIGN KEY (runtime_attempt_id) REFERENCES factory.runtime_attempt(id);


--
-- Name: staging_preview staging_preview_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.staging_preview
    ADD CONSTRAINT staging_preview_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: staging_preview staging_preview_runtime_attempt_id_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.staging_preview
    ADD CONSTRAINT staging_preview_runtime_attempt_id_project_id_fkey FOREIGN KEY (runtime_attempt_id, project_id) REFERENCES factory.runtime_attempt(id, project_id);


--
-- Name: substrate_binding substrate_binding_runtime_attempt_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.substrate_binding
    ADD CONSTRAINT substrate_binding_runtime_attempt_id_fkey FOREIGN KEY (runtime_attempt_id) REFERENCES factory.runtime_attempt(id);


--
-- Name: substrate_isolated substrate_isolated_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.substrate_isolated
    ADD CONSTRAINT substrate_isolated_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: substrate_prebuild substrate_prebuild_preparation_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.substrate_prebuild
    ADD CONSTRAINT substrate_prebuild_preparation_id_fkey FOREIGN KEY (preparation_id) REFERENCES factory.project_image_preparation(id);


--
-- Name: substrate_source substrate_source_workspace_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.substrate_source
    ADD CONSTRAINT substrate_source_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES factory.development_workspace(id);


--
-- Name: substrate_verification substrate_verification_verification_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.substrate_verification
    ADD CONSTRAINT substrate_verification_verification_id_fkey FOREIGN KEY (verification_id) REFERENCES factory.verification(id);


--
-- Name: substrate_workspace substrate_workspace_workspace_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.substrate_workspace
    ADD CONSTRAINT substrate_workspace_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES factory.development_workspace(id);


--
-- Name: system_skill_settings system_skill_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.system_skill_settings
    ADD CONSTRAINT system_skill_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth."user"(id);


--
-- Name: technical_design_revision technical_design_revision_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.technical_design_revision
    ADD CONSTRAINT technical_design_revision_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: technical_design_revision technical_design_revision_planning_turn_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.technical_design_revision
    ADD CONSTRAINT technical_design_revision_planning_turn_id_fkey FOREIGN KEY (planning_turn_id) REFERENCES factory.agent_turn(id);


--
-- Name: technical_design_revision technical_design_revision_previous_revision_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.technical_design_revision
    ADD CONSTRAINT technical_design_revision_previous_revision_id_fkey FOREIGN KEY (previous_revision_id) REFERENCES factory.technical_design_revision(id);


--
-- Name: technical_design_revision technical_design_revision_requirement_revision_id_ticket_i_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.technical_design_revision
    ADD CONSTRAINT technical_design_revision_requirement_revision_id_ticket_i_fkey FOREIGN KEY (requirement_revision_id, ticket_id) REFERENCES factory.requirement_revision(id, ticket_id);


--
-- Name: technical_design_revision technical_design_revision_ticket_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.technical_design_revision
    ADD CONSTRAINT technical_design_revision_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES factory.ticket(id);


--
-- Name: technical_design_revision technical_design_revision_turn_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.technical_design_revision
    ADD CONSTRAINT technical_design_revision_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES factory.agent_turn(id);


--
-- Name: ticket_conversation ticket_conversation_active_coding_context_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_conversation
    ADD CONSTRAINT ticket_conversation_active_coding_context_id_fkey FOREIGN KEY (active_coding_context_id) REFERENCES factory.conversation_context(id);


--
-- Name: ticket_conversation ticket_conversation_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_conversation
    ADD CONSTRAINT ticket_conversation_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: ticket_conversation ticket_conversation_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_conversation
    ADD CONSTRAINT ticket_conversation_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id) ON DELETE CASCADE;


--
-- Name: ticket_conversation ticket_conversation_ticket_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_conversation
    ADD CONSTRAINT ticket_conversation_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES factory.ticket(id) ON DELETE RESTRICT;


--
-- Name: ticket ticket_converted_to_epic_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket
    ADD CONSTRAINT ticket_converted_to_epic_id_fkey FOREIGN KEY (converted_to_epic_id) REFERENCES factory.epic(id);


--
-- Name: ticket ticket_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket
    ADD CONSTRAINT ticket_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: ticket_dependency ticket_dependency_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_dependency
    ADD CONSTRAINT ticket_dependency_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: ticket_dependency ticket_dependency_prerequisite_id_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_dependency
    ADD CONSTRAINT ticket_dependency_prerequisite_id_project_id_fkey FOREIGN KEY (prerequisite_id, project_id) REFERENCES factory.ticket(id, project_id) ON DELETE CASCADE;


--
-- Name: ticket_dependency ticket_dependency_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_dependency
    ADD CONSTRAINT ticket_dependency_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id) ON DELETE CASCADE;


--
-- Name: ticket_dependency ticket_dependency_ticket_id_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_dependency
    ADD CONSTRAINT ticket_dependency_ticket_id_project_id_fkey FOREIGN KEY (ticket_id, project_id) REFERENCES factory.ticket(id, project_id) ON DELETE CASCADE;


--
-- Name: ticket_document_revision ticket_document_revision_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_document_revision
    ADD CONSTRAINT ticket_document_revision_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: ticket_document_revision ticket_document_revision_proposal_entry_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_document_revision
    ADD CONSTRAINT ticket_document_revision_proposal_entry_id_fkey FOREIGN KEY (proposal_entry_id) REFERENCES factory.conversation_entry(id);


--
-- Name: ticket_document_revision ticket_document_revision_requirement_revision_id_ticket_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_document_revision
    ADD CONSTRAINT ticket_document_revision_requirement_revision_id_ticket_id_fkey FOREIGN KEY (requirement_revision_id, ticket_id) REFERENCES factory.requirement_revision(id, ticket_id);


--
-- Name: ticket_document_revision ticket_document_revision_ticket_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_document_revision
    ADD CONSTRAINT ticket_document_revision_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES factory.ticket(id);


--
-- Name: ticket ticket_epic_id_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket
    ADD CONSTRAINT ticket_epic_id_project_id_fkey FOREIGN KEY (epic_id, project_id) REFERENCES factory.epic(id, project_id);


--
-- Name: ticket_follow ticket_follow_ticket_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_follow
    ADD CONSTRAINT ticket_follow_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES factory.ticket(id) ON DELETE CASCADE;


--
-- Name: ticket_follow_up ticket_follow_up_source_document_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_follow_up
    ADD CONSTRAINT ticket_follow_up_source_document_id_fkey FOREIGN KEY (source_document_id) REFERENCES factory.ticket_document_revision(id);


--
-- Name: ticket_follow_up ticket_follow_up_source_revision_id_source_ticket_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_follow_up
    ADD CONSTRAINT ticket_follow_up_source_revision_id_source_ticket_id_fkey FOREIGN KEY (source_revision_id, source_ticket_id) REFERENCES factory.requirement_revision(id, ticket_id);


--
-- Name: ticket_follow_up ticket_follow_up_source_ticket_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_follow_up
    ADD CONSTRAINT ticket_follow_up_source_ticket_id_fkey FOREIGN KEY (source_ticket_id) REFERENCES factory.ticket(id);


--
-- Name: ticket_follow_up ticket_follow_up_ticket_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_follow_up
    ADD CONSTRAINT ticket_follow_up_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES factory.ticket(id);


--
-- Name: ticket_follow ticket_follow_user_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_follow
    ADD CONSTRAINT ticket_follow_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;


--
-- Name: ticket ticket_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket
    ADD CONSTRAINT ticket_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: ticket_responsibility_event ticket_responsibility_event_actor_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_responsibility_event
    ADD CONSTRAINT ticket_responsibility_event_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth."user"(id);


--
-- Name: ticket_responsibility_event ticket_responsibility_event_ticket_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_responsibility_event
    ADD CONSTRAINT ticket_responsibility_event_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES factory.ticket(id) ON DELETE CASCADE;


--
-- Name: ticket_responsibility_event ticket_responsibility_event_user_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_responsibility_event
    ADD CONSTRAINT ticket_responsibility_event_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id);


--
-- Name: ticket_responsibility ticket_responsibility_ticket_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_responsibility
    ADD CONSTRAINT ticket_responsibility_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES factory.ticket(id) ON DELETE CASCADE;


--
-- Name: ticket_responsibility ticket_responsibility_user_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket_responsibility
    ADD CONSTRAINT ticket_responsibility_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id);


--
-- Name: ticket ticket_trashed_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.ticket
    ADD CONSTRAINT ticket_trashed_by_fkey FOREIGN KEY (trashed_by) REFERENCES auth."user"(id);


--
-- Name: usage_entry usage_entry_operation_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.usage_entry
    ADD CONSTRAINT usage_entry_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES factory.usage_operation(id) ON DELETE CASCADE;


--
-- Name: usage_operation usage_operation_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.usage_operation
    ADD CONSTRAINT usage_operation_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id) ON DELETE CASCADE;


--
-- Name: usage_operation usage_operation_user_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.usage_operation
    ADD CONSTRAINT usage_operation_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id);


--
-- Name: usage_rate_override usage_rate_override_updated_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.usage_rate_override
    ADD CONSTRAINT usage_rate_override_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth."user"(id);


--
-- Name: usage_replay_cursor usage_replay_cursor_operation_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.usage_replay_cursor
    ADD CONSTRAINT usage_replay_cursor_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES factory.usage_operation(id) ON DELETE CASCADE;


--
-- Name: user_ui_preference user_ui_preference_user_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.user_ui_preference
    ADD CONSTRAINT user_ui_preference_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id) ON DELETE CASCADE;


--
-- Name: verification verification_change_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.verification
    ADD CONSTRAINT verification_change_id_fkey FOREIGN KEY (change_id) REFERENCES factory.change(id);


--
-- Name: verification verification_created_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.verification
    ADD CONSTRAINT verification_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth."user"(id);


--
-- Name: verification verification_runtime_fk; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.verification
    ADD CONSTRAINT verification_runtime_fk FOREIGN KEY (runtime_attempt_id, id) REFERENCES factory.runtime_attempt(id, verification_id);


--
-- Name: wiki_source_update wiki_source_update_project_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.wiki_source_update
    ADD CONSTRAINT wiki_source_update_project_id_fkey FOREIGN KEY (project_id) REFERENCES factory.project(id);


--
-- Name: workspace_collaboration_decision workspace_collaboration_decision_actor_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_collaboration_decision
    ADD CONSTRAINT workspace_collaboration_decision_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth."user"(id);


--
-- Name: workspace_collaboration_decision workspace_collaboration_decision_workspace_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_collaboration_decision
    ADD CONSTRAINT workspace_collaboration_decision_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES factory.development_workspace(id);


--
-- Name: workspace_command workspace_command_actor_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_command
    ADD CONSTRAINT workspace_command_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth."user"(id);


--
-- Name: workspace_command workspace_command_runtime_attempt_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_command
    ADD CONSTRAINT workspace_command_runtime_attempt_id_fkey FOREIGN KEY (runtime_attempt_id) REFERENCES factory.runtime_attempt(id);


--
-- Name: workspace_command workspace_command_workspace_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_command
    ADD CONSTRAINT workspace_command_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES factory.development_workspace(id);


--
-- Name: workspace_file_operation workspace_file_operation_actor_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_file_operation
    ADD CONSTRAINT workspace_file_operation_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth."user"(id);


--
-- Name: workspace_file_operation workspace_file_operation_runtime_attempt_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_file_operation
    ADD CONSTRAINT workspace_file_operation_runtime_attempt_id_fkey FOREIGN KEY (runtime_attempt_id) REFERENCES factory.runtime_attempt(id);


--
-- Name: workspace_file_operation workspace_file_operation_workspace_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_file_operation
    ADD CONSTRAINT workspace_file_operation_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES factory.development_workspace(id);


--
-- Name: workspace_file_transfer workspace_file_transfer_actor_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_file_transfer
    ADD CONSTRAINT workspace_file_transfer_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth."user"(id);


--
-- Name: workspace_file_transfer workspace_file_transfer_runtime_attempt_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_file_transfer
    ADD CONSTRAINT workspace_file_transfer_runtime_attempt_id_fkey FOREIGN KEY (runtime_attempt_id) REFERENCES factory.runtime_attempt(id);


--
-- Name: workspace_file_transfer workspace_file_transfer_workspace_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_file_transfer
    ADD CONSTRAINT workspace_file_transfer_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES factory.development_workspace(id);


--
-- Name: workspace_lifecycle_command workspace_lifecycle_command_actor_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_lifecycle_command
    ADD CONSTRAINT workspace_lifecycle_command_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth."user"(id);


--
-- Name: workspace_lifecycle_command workspace_lifecycle_command_runtime_attempt_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_lifecycle_command
    ADD CONSTRAINT workspace_lifecycle_command_runtime_attempt_id_fkey FOREIGN KEY (runtime_attempt_id) REFERENCES factory.runtime_attempt(id);


--
-- Name: workspace_lifecycle_command workspace_lifecycle_command_workspace_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_lifecycle_command
    ADD CONSTRAINT workspace_lifecycle_command_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES factory.development_workspace(id);


--
-- Name: workspace_share_decision workspace_share_decision_actor_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_share_decision
    ADD CONSTRAINT workspace_share_decision_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth."user"(id);


--
-- Name: workspace_share_decision workspace_share_decision_user_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_share_decision
    ADD CONSTRAINT workspace_share_decision_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id);


--
-- Name: workspace_share_decision workspace_share_decision_workspace_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_share_decision
    ADD CONSTRAINT workspace_share_decision_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES factory.development_workspace(id);


--
-- Name: workspace_share workspace_share_granted_by_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_share
    ADD CONSTRAINT workspace_share_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES auth."user"(id);


--
-- Name: workspace_share workspace_share_user_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_share
    ADD CONSTRAINT workspace_share_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth."user"(id);


--
-- Name: workspace_share workspace_share_workspace_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_share
    ADD CONSTRAINT workspace_share_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES factory.development_workspace(id);


--
-- Name: workspace_shared_document workspace_shared_document_workspace_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_shared_document
    ADD CONSTRAINT workspace_shared_document_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES factory.development_workspace(id);


--
-- Name: workspace_submission workspace_submission_actor_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_submission
    ADD CONSTRAINT workspace_submission_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth."user"(id);


--
-- Name: workspace_submission workspace_submission_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_submission
    ADD CONSTRAINT workspace_submission_id_fkey FOREIGN KEY (id) REFERENCES factory.change_commit_operation(id);


--
-- Name: workspace_submission workspace_submission_workspace_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_submission
    ADD CONSTRAINT workspace_submission_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES factory.development_workspace(id);


--
-- Name: workspace_terminal_operation workspace_terminal_operation_actor_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_terminal_operation
    ADD CONSTRAINT workspace_terminal_operation_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth."user"(id);


--
-- Name: workspace_terminal_operation workspace_terminal_operation_command_id_fkey; Type: FK CONSTRAINT; Schema: factory; Owner: -
--

ALTER TABLE ONLY factory.workspace_terminal_operation
    ADD CONSTRAINT workspace_terminal_operation_command_id_fkey FOREIGN KEY (command_id) REFERENCES factory.workspace_command(id);


--
-- Name: factory_zero_publication; Type: PUBLICATION; Schema: -; Owner: -
--

CREATE PUBLICATION factory_zero_publication WITH (publish = 'insert, update, delete, truncate');


--
-- Name: factory_zero_publication epic; Type: PUBLICATION TABLE; Schema: factory; Owner: -
--

ALTER PUBLICATION factory_zero_publication ADD TABLE ONLY factory.epic;


--
-- Name: factory_zero_publication knowledge_page; Type: PUBLICATION TABLE; Schema: factory; Owner: -
--

ALTER PUBLICATION factory_zero_publication ADD TABLE ONLY factory.knowledge_page;


--
-- Name: factory_zero_publication knowledge_page_outline; Type: PUBLICATION TABLE; Schema: factory; Owner: -
--

ALTER PUBLICATION factory_zero_publication ADD TABLE ONLY factory.knowledge_page_outline;


--
-- Name: factory_zero_publication project; Type: PUBLICATION TABLE; Schema: factory; Owner: -
--

ALTER PUBLICATION factory_zero_publication ADD TABLE ONLY factory.project;


--
-- Name: factory_zero_publication project_membership; Type: PUBLICATION TABLE; Schema: factory; Owner: -
--

ALTER PUBLICATION factory_zero_publication ADD TABLE ONLY factory.project_membership;


--
-- Name: factory_zero_publication read_version; Type: PUBLICATION TABLE; Schema: factory; Owner: -
--

ALTER PUBLICATION factory_zero_publication ADD TABLE ONLY factory.read_version;


--
-- Name: factory_zero_publication ticket; Type: PUBLICATION TABLE; Schema: factory; Owner: -
--

ALTER PUBLICATION factory_zero_publication ADD TABLE ONLY factory.ticket;


--
-- Name: factory_zero_publication ticket_dependency; Type: PUBLICATION TABLE; Schema: factory; Owner: -
--

ALTER PUBLICATION factory_zero_publication ADD TABLE ONLY factory.ticket_dependency;


--
-- PostgreSQL database dump complete
--




-- Exact original-Actor cleanup intent, not another runtime lifecycle engine.
CREATE TABLE factory.substrate_input_stop (
    stop_id uuid PRIMARY KEY,
    runtime_attempt_id uuid NOT NULL REFERENCES factory.runtime_attempt(id),
    workspace_id uuid NOT NULL REFERENCES factory.development_workspace(id),
    change_id uuid NOT NULL REFERENCES factory.change(id),
    actor_uid uuid NOT NULL,
    assignment jsonb NOT NULL CHECK (jsonb_typeof(assignment)='object' AND octet_length(assignment::text)<=8192),
    checkpoint jsonb NOT NULL CHECK (jsonb_typeof(checkpoint)='object'),
    source_checkpoint_id uuid,
    source_writer_epoch bigint CHECK (source_writer_epoch>0),
    resume_attempted_at timestamp with time zone,
    snapshot_attempted_at timestamp with time zone,
    result jsonb CHECK (jsonb_typeof(result)='object' AND octet_length(result::text)<=8192),
    completed_checkpoint jsonb,
    completed_source_checkpoint_id uuid,
    completed_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CHECK ((source_checkpoint_id IS NULL)=(source_writer_epoch IS NULL)),
    CHECK (resume_attempted_at IS NULL OR source_checkpoint_id IS NOT NULL),
    CHECK (result IS NULL OR resume_attempted_at IS NOT NULL),
    CHECK (snapshot_attempted_at IS NULL OR resume_attempted_at IS NOT NULL),
    CHECK (completed_at IS NULL OR (result IS NOT NULL AND result->'confirmed'='true'::jsonb AND completed_checkpoint IS NOT NULL AND completed_source_checkpoint_id IS NOT NULL))
);

CREATE FUNCTION factory.protect_substrate_input_stop() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Native Stop intent and outcomes cannot be discarded'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.assignment->>'stopID' IS DISTINCT FROM NEW.stop_id::text
      OR NEW.assignment->>'attemptID' IS DISTINCT FROM NEW.runtime_attempt_id::text
      OR NEW.assignment->>'mode' IS DISTINCT FROM 'interrupt'
      OR NOT EXISTS(
        SELECT 1 FROM factory.runtime_attempt attempt
        JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=attempt.id
        JOIN factory.development_workspace workspace ON workspace.id=attempt.workspace_id
        JOIN factory.change change ON change.id=attempt.change_id AND change.runtime_attempt_id=attempt.id
        JOIN factory.change_agent_session session ON session.change_id=change.id
        JOIN factory.change_agent_turn_intent intent ON intent.turn_id=session.stop_turn_id
        JOIN factory.agent_turn turn ON turn.id=intent.turn_id
        JOIN factory.substrate_source source ON source.workspace_id=workspace.id
        WHERE attempt.id=NEW.runtime_attempt_id AND attempt.substrate AND workspace.substrate
          AND attempt.workspace_id=NEW.workspace_id AND attempt.change_id=NEW.change_id
          AND attempt.stop_intended_at IS NULL AND workspace.kind='ticket'
          AND binding.actor_uid=NEW.actor_uid AND binding.checkpoint=NEW.checkpoint
          AND binding.observation#>>'{status,state}'='ACTOR_STATE_SUSPENDED'
          AND binding.create_attempted_at IS NOT NULL AND NOT binding.create_rejected
          AND binding.delete_intended_at IS NULL AND binding.deleted_at IS NULL
          AND source.actor_uid=NEW.actor_uid AND source.owner='service' AND source.writable
          AND source.checkpoint IS NOT NULL AND source.service_base IS NOT NULL
          AND session.state='stopped' AND session.stop_pending AND session.stop_id=NEW.stop_id
          AND session.runtime_attempt_id=attempt.id AND session.opencode_session_id=NEW.assignment->>'sessionID'
          AND intent.runtime_attempt_id=attempt.id AND intent.session_id=session.opencode_session_id
          AND intent.prompt_id=NEW.assignment->>'promptID' AND turn.authority->>'modelId'=NEW.assignment->>'modelID'
          AND turn.state IN ('stopped','completed','failed')
          AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt newer
            WHERE newer.workspace_id=workspace.id AND newer.generation>attempt.generation))
      THEN RAISE EXCEPTION 'Native Stop requires the exact pending input and independent paused Source'; END IF;
  ELSIF ROW(NEW.stop_id,NEW.runtime_attempt_id,NEW.workspace_id,NEW.change_id,NEW.actor_uid,NEW.assignment,NEW.checkpoint,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.stop_id,OLD.runtime_attempt_id,OLD.workspace_id,OLD.change_id,OLD.actor_uid,OLD.assignment,OLD.checkpoint,OLD.created_at)
    OR (OLD.source_checkpoint_id IS NOT NULL AND ROW(NEW.source_checkpoint_id,NEW.source_writer_epoch)
      IS DISTINCT FROM ROW(OLD.source_checkpoint_id,OLD.source_writer_epoch))
    OR (OLD.resume_attempted_at IS NOT NULL AND NEW.resume_attempted_at IS DISTINCT FROM OLD.resume_attempted_at)
    OR (OLD.snapshot_attempted_at IS NOT NULL AND NEW.snapshot_attempted_at IS DISTINCT FROM OLD.snapshot_attempted_at)
    OR (OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result)
    OR (OLD.completed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD)
    THEN RAISE EXCEPTION 'Native Stop identity and dispatched outcomes are immutable'; END IF;
  IF NEW.result IS NOT NULL AND (
    NEW.result - ARRAY['mode','confirmed','engineExited','processTreeExited'] IS DISTINCT FROM NEW.assignment-'mode'
    OR COALESCE(NEW.result->>'mode' IN ('interrupt','observe'),false) IS NOT TRUE
    OR COALESCE(jsonb_typeof(NEW.result->'confirmed')='boolean',false) IS NOT TRUE
    OR NEW.result->'engineExited' IS DISTINCT FROM 'true'::jsonb
    OR NEW.result->'processTreeExited' IS DISTINCT FROM 'true'::jsonb)
    THEN RAISE EXCEPTION 'Native Stop requires its exact joined worker result'; END IF;
  IF NEW.completed_at IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM factory.runtime_attempt attempt
    JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=attempt.id
    JOIN factory.substrate_source source ON source.workspace_id=attempt.workspace_id
    WHERE attempt.id=NEW.runtime_attempt_id AND attempt.state='paused'
      AND attempt.stop_intended_at IS NULL AND binding.actor_uid=NEW.actor_uid
      AND binding.observation#>>'{status,state}'='ACTOR_STATE_SUSPENDED'
      AND (binding.checkpoint->>'generation')::bigint>(NEW.checkpoint->>'generation')::bigint
      AND binding.checkpoint->>'uuid' IS DISTINCT FROM NEW.checkpoint->>'uuid'
      AND NEW.completed_checkpoint=binding.checkpoint
      AND source.actor_uid=NEW.actor_uid AND source.owner='service' AND source.writable
      AND source.checkpoint->>'id'=NEW.completed_source_checkpoint_id::text AND source.service_base IS NOT NULL)
    THEN RAISE EXCEPTION 'Native Stop requires a new durable pause and independent Source'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER substrate_input_stop_identity BEFORE INSERT OR UPDATE OR DELETE
ON factory.substrate_input_stop FOR EACH ROW EXECUTE FUNCTION factory.protect_substrate_input_stop();

CREATE TABLE factory.substrate_actor_rpc (
    runtime_attempt_id uuid NOT NULL REFERENCES factory.runtime_attempt(id),
    action text NOT NULL CHECK (action IN ('resume','suspend')),
    origin_key text NOT NULL,
    actor_uid uuid NOT NULL,
    native_version text NOT NULL CHECK (native_version ~ '^[1-9][0-9]*$'),
    origin_checkpoint jsonb CHECK (jsonb_typeof(origin_checkpoint)='object'),
    stop_id uuid REFERENCES factory.substrate_input_stop(stop_id),
    intended_at timestamp with time zone NOT NULL DEFAULT now(),
    attempted_at timestamp with time zone,
    outcome jsonb CHECK (jsonb_typeof(outcome)='object' AND octet_length(outcome::text)<=65536),
    outcome_recorded_at timestamp with time zone,
    PRIMARY KEY(runtime_attempt_id,action,origin_key),
    CHECK (origin_key=COALESCE(origin_checkpoint->>'uuid','initial')),
    CHECK ((outcome IS NULL)=(outcome_recorded_at IS NULL)),
    CHECK (outcome IS NULL OR attempted_at IS NOT NULL)
);

CREATE FUNCTION factory.protect_substrate_actor_rpc() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Native lifecycle dispatch facts cannot be discarded'; END IF;
  IF TG_OP='INSERT' AND NOT EXISTS(
    SELECT 1 FROM factory.runtime_attempt attempt
    JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=attempt.id
    WHERE attempt.id=NEW.runtime_attempt_id AND attempt.substrate AND binding.actor_uid=NEW.actor_uid
      AND binding.create_attempted_at IS NOT NULL AND NOT binding.create_rejected
      AND binding.delete_intended_at IS NULL AND binding.deleted_at IS NULL
      AND binding.observation#>>'{metadata,version}'=NEW.native_version
      AND NEW.origin_key=COALESCE(binding.checkpoint->>'uuid','initial')
      AND NEW.origin_checkpoint IS NOT DISTINCT FROM binding.checkpoint
      AND ((NEW.action='resume' AND binding.observation#>>'{status,state}'='ACTOR_STATE_SUSPENDED')
        OR (NEW.action='suspend' AND binding.observation#>>'{status,state}'='ACTOR_STATE_RUNNING'
          AND EXISTS(SELECT 1 FROM factory.substrate_actor_rpc resumed
            WHERE resumed.runtime_attempt_id=attempt.id AND resumed.action='resume'
              AND resumed.origin_key=NEW.origin_key AND resumed.actor_uid=NEW.actor_uid
              AND resumed.attempted_at IS NOT NULL AND resumed.outcome->>'state'='ACTOR_STATE_RUNNING')))
      AND (NEW.stop_id IS NULL OR EXISTS(
        SELECT 1 FROM factory.substrate_input_stop stopped
        JOIN factory.change_agent_session session ON session.change_id=stopped.change_id
        WHERE stopped.stop_id=NEW.stop_id AND stopped.runtime_attempt_id=attempt.id
          AND stopped.actor_uid=NEW.actor_uid AND session.stop_id=stopped.stop_id AND session.stop_pending)))
    THEN RAISE EXCEPTION 'Native lifecycle intent requires its exact original Actor and checkpoint'; END IF;
  IF TG_OP='UPDATE' AND (
    ROW(NEW.runtime_attempt_id,NEW.action,NEW.origin_key,NEW.actor_uid,NEW.native_version,NEW.origin_checkpoint,NEW.stop_id,NEW.intended_at)
      IS DISTINCT FROM ROW(OLD.runtime_attempt_id,OLD.action,OLD.origin_key,OLD.actor_uid,OLD.native_version,OLD.origin_checkpoint,OLD.stop_id,OLD.intended_at)
    OR (OLD.attempted_at IS NOT NULL AND NEW.attempted_at IS DISTINCT FROM OLD.attempted_at)
    OR (OLD.outcome IS NOT NULL AND NEW IS DISTINCT FROM OLD))
    THEN RAISE EXCEPTION 'Native lifecycle identities, dispatch and outcome facts are immutable'; END IF;
  IF NEW.outcome IS NOT NULL AND (
    NEW.outcome->>'actorUID' IS DISTINCT FROM NEW.actor_uid::text
    OR COALESCE(NEW.outcome->>'version','') !~ '^[1-9][0-9]*$'
    OR (NEW.outcome->>'version')::numeric<NEW.native_version::numeric
    OR NEW.outcome->>'state' IS DISTINCT FROM CASE WHEN NEW.action='resume' THEN 'ACTOR_STATE_RUNNING' ELSE 'ACTOR_STATE_SUSPENDED' END
    OR NOT EXISTS(SELECT 1 FROM factory.substrate_binding binding
      WHERE binding.runtime_attempt_id=NEW.runtime_attempt_id AND binding.actor_uid=NEW.actor_uid
        AND binding.observation#>>'{metadata,version}'=NEW.outcome->>'version'
        AND binding.observation#>>'{status,state}'=NEW.outcome->>'state'
        AND (NEW.action='resume' OR binding.checkpoint=NEW.outcome->'checkpoint')))
    THEN RAISE EXCEPTION 'Native lifecycle completion requires its independent original-Actor observation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER substrate_actor_rpc_identity BEFORE INSERT OR UPDATE OR DELETE
ON factory.substrate_actor_rpc FOR EACH ROW EXECUTE FUNCTION factory.protect_substrate_actor_rpc();

CREATE TABLE factory.substrate_capacity_installation (
  owner text PRIMARY KEY CHECK (owner ~ '^[a-f0-9]{32}$'),
  intent jsonb NOT NULL CHECK (jsonb_typeof(intent)='object')
);
CREATE FUNCTION factory.protect_substrate_capacity_installation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Native capacity installation identity is immutable';
  END IF;
  IF NEW.intent->>'database' IS DISTINCT FROM current_database()
    OR COALESCE(NEW.intent#>>'{base,uid}','')=''
    OR COALESCE(NEW.intent#>>'{node,uid}','')=''
    OR COALESCE(NEW.intent->>'sandboxUID','')=''
    THEN RAISE EXCEPTION 'Native capacity requires its observed installation identity'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER substrate_capacity_installation_identity BEFORE INSERT OR UPDATE OR DELETE
ON factory.substrate_capacity_installation
FOR EACH ROW EXECUTE FUNCTION factory.protect_substrate_capacity_installation();

INSERT INTO factory.installation_maintenance(singleton) VALUES(true);
INSERT INTO factory.attachment_storage(singleton,id) VALUES(true,gen_random_uuid());
RESET check_function_bodies;
RESET search_path;
-- Baseline registration.
INSERT INTO factory.schema_migration(version,source_digest) VALUES(1,'8f95d95e5d52574fbbb181320a29a98de94701069e0fe643f02b7325a4bb0200');
COMMIT;
