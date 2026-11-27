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
