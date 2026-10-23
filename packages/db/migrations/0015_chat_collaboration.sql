BEGIN;
ALTER TABLE factory.change_writer ADD COLUMN handoff_kind text NOT NULL DEFAULT 'takeover'
  CHECK (handoff_kind IN ('takeover','release'));

CREATE TABLE factory.change_editing_request (
  id uuid PRIMARY KEY,
  change_id uuid NOT NULL REFERENCES factory.change(id),
  requester_id uuid NOT NULL REFERENCES auth."user"(id),
  owner_id uuid NOT NULL REFERENCES auth."user"(id),
  writer_epoch bigint NOT NULL,
  state text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','accepted','superseded')),
  decided_by uuid REFERENCES auth."user"(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE UNIQUE INDEX change_editing_request_pending ON factory.change_editing_request(change_id,requester_id,writer_epoch)
  WHERE state='requested';

CREATE TABLE factory.change_editing_decision (
  command_id uuid PRIMARY KEY,
  change_id uuid NOT NULL REFERENCES factory.change(id),
  actor_id uuid NOT NULL REFERENCES auth."user"(id),
  target_id uuid REFERENCES auth."user"(id),
  request_id uuid REFERENCES factory.change_editing_request(id),
  writer_epoch bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('takeover','idle-takeover','approve','release')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER change_editing_decision_immutable BEFORE UPDATE OR DELETE ON factory.change_editing_decision
  FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TABLE factory.conversation_context (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES factory.ticket_conversation(id) ON DELETE CASCADE,
  command_id uuid NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('research','coding')),
  mode factory.conversation_mode NOT NULL DEFAULT 'investigate',
  ordinal integer NOT NULL CHECK (ordinal>0),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  created_by uuid NOT NULL REFERENCES auth."user"(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  change_id uuid REFERENCES factory.change(id),
  native_session_id text,
  previous_context_id uuid REFERENCES factory.conversation_context(id),
  original boolean NOT NULL DEFAULT false,
  archived_session jsonb,
  transcript jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE(conversation_id,ordinal),
  CHECK ((kind='coding')=(change_id IS NOT NULL)),
  CHECK ((kind='coding')=(mode='build')),
  CHECK (kind='coding' OR (native_session_id IS NULL AND archived_session IS NULL AND NOT original))
);
CREATE UNIQUE INDEX conversation_context_original ON factory.conversation_context(conversation_id) WHERE original;
ALTER TABLE factory.ticket_conversation ADD COLUMN active_coding_context_id uuid
  REFERENCES factory.conversation_context(id);

DROP INDEX factory.agent_turn_active_boundary_uidx;
CREATE UNIQUE INDEX agent_turn_active_boundary_uidx ON factory.agent_turn(project_id,
  (CASE WHEN change_id IS NULL AND input->>'contextId' IS NOT NULL THEN 'context:'||(input->>'contextId')
    ELSE COALESCE(ticket_id::text,'draft:'||created_by::text) END))
  WHERE state IN ('pending','dispatching','running');

CREATE FUNCTION factory.guard_conversation_context() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER conversation_context_identity BEFORE UPDATE ON factory.conversation_context
  FOR EACH ROW EXECUTE FUNCTION factory.guard_conversation_context();

CREATE FUNCTION factory.guard_active_coding_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.active_coding_context_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM factory.conversation_context context JOIN factory.change change ON change.id=context.change_id
    WHERE context.id=NEW.active_coding_context_id AND context.conversation_id=NEW.id
      AND context.kind='coding' AND NOT context.original AND change.ticket_id=NEW.ticket_id
      AND change.project_id=NEW.project_id
  ) THEN RAISE EXCEPTION 'Active Coding context must belong to this Ticket conversation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ticket_conversation_coding_context BEFORE INSERT OR UPDATE OF active_coding_context_id
  ON factory.ticket_conversation FOR EACH ROW EXECUTE FUNCTION factory.guard_active_coding_context();
INSERT INTO factory.schema_migration(version) VALUES(15);
COMMIT;
