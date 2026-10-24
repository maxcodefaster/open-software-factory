BEGIN;
ALTER TABLE factory.review_scenario
  ADD COLUMN observation_kind text CHECK (observation_kind IN ('app','source'));

CREATE OR REPLACE FUNCTION factory.guard_review_scenario() RETURNS trigger LANGUAGE plpgsql AS $$
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

INSERT INTO factory.schema_migration(version) VALUES (17);
COMMIT;
