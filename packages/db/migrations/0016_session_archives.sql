BEGIN;

-- Best-effort native Coding transcript checkpoints. No runtime identities,
-- authorization, external outcomes or existing source bindings are changed.
CREATE TABLE factory.session_archive (
  turn_id uuid PRIMARY KEY REFERENCES factory.agent_turn(id),
  runtime_attempt_id uuid NOT NULL REFERENCES factory.runtime_attempt(id),
  session_id text NOT NULL CHECK (length(session_id) BETWEEN 1 AND 200),
  prompt_id text NOT NULL CHECK (length(prompt_id) BETWEEN 1 AND 200),
  source_refs jsonb NOT NULL CHECK (jsonb_typeof(source_refs)='object' AND octet_length(source_refs::text)<=16384),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','failed','saved')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  manifest_key text,
  manifest_sha256 text CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  through_message_id text,
  producer_version text,
  summary jsonb CHECK (jsonb_typeof(summary)='object' AND octet_length(summary::text)<=16384),
  last_error text CHECK (length(last_error)<=2000),
  retry_after timestamptz NOT NULL DEFAULT now(),
  saved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state='saved') = (saved_at IS NOT NULL)),
  CHECK (state<>'saved' OR (manifest_key IS NOT NULL AND manifest_sha256 IS NOT NULL
    AND through_message_id IS NOT NULL AND producer_version IS NOT NULL AND summary IS NOT NULL))
);
CREATE INDEX session_archive_pending ON factory.session_archive(retry_after) WHERE state<>'saved';

CREATE FUNCTION factory.protect_session_archive() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER session_archive_identity BEFORE INSERT OR UPDATE OR DELETE ON factory.session_archive
  FOR EACH ROW EXECUTE FUNCTION factory.protect_session_archive();

INSERT INTO factory.schema_migration(version) VALUES(16);
COMMIT;
