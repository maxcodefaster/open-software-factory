BEGIN;
ALTER TABLE factory.project ADD COLUMN qa_recording_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE factory.candidate_review ADD COLUMN coverage_version integer NOT NULL DEFAULT 0;
ALTER TABLE factory.candidate_review ALTER COLUMN coverage_version SET DEFAULT 1;

CREATE TABLE factory.review_scenario (
  review_id uuid NOT NULL REFERENCES factory.candidate_review(id),
  id text NOT NULL CHECK (id ~ '^[a-z0-9-]{1,64}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  category text NOT NULL CHECK (category IN ('normal','error','boundary')),
  criterion integer NOT NULL CHECK (criterion > 0),
  expected text NOT NULL CHECK (length(expected) BETWEEN 1 AND 1000),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  observed text CHECK (length(observed) BETWEEN 1 AND 2000),
  media_started_ms bigint CHECK (media_started_ms >= 0),
  media_session_id uuid REFERENCES factory.build_browser_session(id),
  status text CHECK (status IN ('passed','failed','unverified')),
  PRIMARY KEY(review_id,id)
);
CREATE TABLE factory.review_media (
  id uuid PRIMARY KEY,
  change_id uuid NOT NULL REFERENCES factory.change(id),
  review_id uuid REFERENCES factory.candidate_review(id),
  browser_session_id uuid REFERENCES factory.build_browser_session(id),
  created_by uuid REFERENCES auth."user"(id),
  kind text NOT NULL CHECK (kind IN ('recording','still')),
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40}$'),
  runtime_attempt_id uuid REFERENCES factory.runtime_attempt(id),
  source_context jsonb,
  state text NOT NULL CHECK (state IN ('intended','recording','complete','unavailable','deleted')),
  byte_length integer CHECK (byte_length BETWEEN 1 AND 100663296),
  sha256 text CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  duration_ms integer CHECK (duration_ms >= 0),
  reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  deleted_at timestamptz,
  CHECK (state <> 'complete' OR (byte_length IS NOT NULL AND sha256 IS NOT NULL)),
  CHECK (kind <> 'recording' OR review_id IS NOT NULL),
  UNIQUE(browser_session_id,kind)
);
CREATE INDEX review_media_retention ON factory.review_media(change_id,kind,state);
CREATE TABLE factory.review_feedback (
  id uuid PRIMARY KEY,
  change_id uuid NOT NULL REFERENCES factory.change(id),
  author_id uuid NOT NULL REFERENCES auth."user"(id),
  kind text NOT NULL CHECK (kind IN ('comment','thread')),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','implemented','resolved')),
  version integer NOT NULL DEFAULT 1,
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40}$'),
  annotation jsonb,
  media_id uuid REFERENCES factory.review_media(id),
  resolved_by uuid REFERENCES auth."user"(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'comment' OR state='open'),
  CHECK ((annotation IS NULL) = (media_id IS NULL))
);
CREATE INDEX review_feedback_delivery ON factory.review_feedback(change_id)
  WHERE kind='thread' AND state<>'resolved';
CREATE TABLE factory.review_feedback_message (
  id uuid PRIMARY KEY,
  feedback_id uuid NOT NULL REFERENCES factory.review_feedback(id),
  author_id uuid NOT NULL REFERENCES auth."user"(id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE factory.review_feedback_command (
  id uuid PRIMARY KEY,
  change_id uuid NOT NULL REFERENCES factory.change(id),
  actor_id uuid NOT NULL REFERENCES auth."user"(id),
  input jsonb NOT NULL,
  feedback_id uuid REFERENCES factory.review_feedback(id),
  turn_id uuid UNIQUE REFERENCES factory.agent_turn(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION factory.guard_review_media() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER review_media_guard BEFORE UPDATE ON factory.review_media
  FOR EACH ROW EXECUTE FUNCTION factory.guard_review_media();
CREATE FUNCTION factory.guard_review_scenario() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE review factory.candidate_review;
BEGIN
  SELECT * INTO review FROM factory.candidate_review WHERE id=NEW.review_id FOR UPDATE;
  IF review.result IS NOT NULL OR review.state NOT IN ('pending','running')
    OR (TG_OP='UPDATE' AND (
      OLD.ended_at IS NOT NULL OR
      ROW(NEW.review_id,NEW.id,NEW.title,NEW.category,NEW.criterion,NEW.expected,NEW.started_at)
      IS DISTINCT FROM ROW(OLD.review_id,OLD.id,OLD.title,OLD.category,OLD.criterion,OLD.expected,OLD.started_at)))
  THEN RAISE EXCEPTION 'Review scenario intent and completed outcome are immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER review_scenario_guard BEFORE INSERT OR UPDATE ON factory.review_scenario
  FOR EACH ROW EXECUTE FUNCTION factory.guard_review_scenario();
INSERT INTO factory.schema_migration(version) VALUES (9);
COMMIT;
