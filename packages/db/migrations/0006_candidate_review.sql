BEGIN;

-- opencode_session_id continues to identify the current execution for Stop,
-- relay and browser authority. Keep the resumable implementation separately
-- while a fresh, read-only review Session owns that execution.
ALTER TABLE factory.change_agent_session
  ADD COLUMN implementation_session_id text,
  ADD COLUMN implementation_session_confirmed_at timestamptz,
  ADD CONSTRAINT change_agent_implementation_confirmation CHECK (
    implementation_session_confirmed_at IS NULL OR implementation_session_id IS NOT NULL
  );
UPDATE factory.change_agent_session SET
  implementation_session_id = opencode_session_id,
  implementation_session_confirmed_at = native_session_confirmed_at;

ALTER TABLE factory.agent_turn DROP CONSTRAINT agent_turn_check1;
ALTER TABLE factory.agent_turn ADD CONSTRAINT agent_turn_check1 CHECK (
  (input->>'kind' IN ('project-message','project-answer') AND conversation_id IS NOT NULL
    AND change_id IS NULL AND authority->>'mode' IN ('investigate','plan'))
  OR (input->>'kind' IN ('change-start','change-prompt','change-repair','change-review')
    AND change_id IS NOT NULL AND ticket_id IS NOT NULL AND authority->>'mode' = 'build')
);
ALTER TABLE factory.agent_turn ADD CONSTRAINT agent_turn_review_authority CHECK (
  (input->>'kind' = 'change-review') = (authority ? 'review')
);
CREATE TABLE factory.candidate_review (
  id uuid PRIMARY KEY,
  verification_id uuid NOT NULL REFERENCES factory.verification(id),
  ordinal integer NOT NULL DEFAULT 1 CHECK (ordinal > 0),
  supersedes_id uuid UNIQUE REFERENCES factory.candidate_review(id),
  change_id uuid NOT NULL REFERENCES factory.change(id),
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40}$'),
  base_sha text NOT NULL CHECK (base_sha ~ '^[a-f0-9]{40}$'),
  created_by uuid NOT NULL REFERENCES auth."user"(id),
  turn_id uuid UNIQUE REFERENCES factory.agent_turn(id),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','running','passed','changes-requested','incomplete')),
  ui_required boolean NOT NULL DEFAULT false,
  result jsonb CHECK (result IS NULL OR (jsonb_typeof(result)='object' AND octet_length(result::text)<=32768)),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) <= 256),
  repair_command_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  repair_prompted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (verification_id, ordinal),
  UNIQUE (id,change_id,verification_id,commit_sha),
  FOREIGN KEY (verification_id, change_id, commit_sha)
    REFERENCES factory.verification(id, change_id, commit_sha),
  CHECK (state NOT IN ('passed','changes-requested') OR result IS NOT NULL)
);
CREATE INDEX candidate_review_change_idx ON factory.candidate_review(change_id);
ALTER TABLE factory.delivery_approval
  ADD COLUMN candidate_review_id uuid,
  ADD CONSTRAINT delivery_approval_candidate_review_identity
    FOREIGN KEY (candidate_review_id,change_id,verification_id,commit_sha)
    REFERENCES factory.candidate_review(id,change_id,verification_id,commit_sha);

CREATE FUNCTION factory.guard_candidate_review() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER candidate_review_guard BEFORE UPDATE ON factory.candidate_review
  FOR EACH ROW EXECUTE FUNCTION factory.guard_candidate_review();

INSERT INTO factory.schema_migration(version) VALUES (6);
COMMIT;
