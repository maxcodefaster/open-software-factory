-- Common routines. Run before Drizzle tables, with check_function_bodies disabled.

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
