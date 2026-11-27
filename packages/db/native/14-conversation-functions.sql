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
