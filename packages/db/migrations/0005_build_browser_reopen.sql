BEGIN;

ALTER TABLE factory.build_browser_session
  ADD COLUMN ordinal integer NOT NULL DEFAULT 1 CHECK (ordinal > 0),
  ADD COLUMN reopen_allowed boolean NOT NULL DEFAULT false,
  DROP CONSTRAINT build_browser_session_turn_id_owner_id_key,
  ADD CONSTRAINT build_browser_session_owner_ordinal_key UNIQUE (turn_id, owner_id, ordinal);

CREATE UNIQUE INDEX build_browser_one_unclosed_session
  ON factory.build_browser_session(turn_id, owner_id) WHERE state <> 'closed';

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

CREATE TRIGGER build_browser_ordinal_guard BEFORE INSERT OR UPDATE
  ON factory.build_browser_session FOR EACH ROW EXECUTE FUNCTION factory.guard_build_browser_ordinal();

INSERT INTO factory.schema_migration(version) VALUES (5);
COMMIT;
