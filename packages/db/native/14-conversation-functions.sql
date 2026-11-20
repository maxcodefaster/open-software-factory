-- Conversation routines. Run before Drizzle tables, with check_function_bodies disabled.

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
