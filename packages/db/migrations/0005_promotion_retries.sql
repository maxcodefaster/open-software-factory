BEGIN;

ALTER TABLE factory.promotion_operation
  DROP CONSTRAINT promotion_operation_change_id_key,
  ADD COLUMN ordinal integer NOT NULL DEFAULT 1 CHECK (ordinal > 0),
  ADD COLUMN supersedes_id uuid UNIQUE REFERENCES factory.promotion_operation(id),
  ADD COLUMN retry_command_id uuid UNIQUE REFERENCES factory.execution_policy_command(command_id),
  ADD CONSTRAINT promotion_operation_sequence UNIQUE (change_id,ordinal),
  ADD CONSTRAINT promotion_operation_retry_identity CHECK (
    (ordinal=1 AND supersedes_id IS NULL AND retry_command_id IS NULL)
    OR (ordinal>1 AND supersedes_id IS NOT NULL AND retry_command_id=id)
  );

CREATE VIEW factory.current_promotion WITH (security_invoker=true) AS
  SELECT DISTINCT ON (change_id) * FROM factory.promotion_operation
  ORDER BY change_id,ordinal DESC;

CREATE FUNCTION factory.protect_promotion_operation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous factory.promotion_operation%ROWTYPE;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.ordinal>1 THEN
      SELECT * INTO previous FROM factory.promotion_operation WHERE id=NEW.supersedes_id;
      IF NOT FOUND OR previous.state<>'failed' OR previous.ordinal+1<>NEW.ordinal
        OR ROW(NEW.change_id,NEW.project_id,NEW.commit_sha,NEW.previous_runtime_attempt_id)
          IS DISTINCT FROM ROW(previous.change_id,previous.project_id,previous.commit_sha,previous.previous_runtime_attempt_id)
        OR NEW.state<>'pending' OR NEW.replacement_runtime_attempt_id IS NOT NULL
        OR NOT EXISTS(SELECT 1 FROM factory.execution_policy_command command
          WHERE command.command_id=NEW.retry_command_id
            AND command.scope='promotion-retry:'||NEW.change_id
            AND command.input->>'changeID'=NEW.change_id::text
            AND command.input->>'promotionID'=previous.id::text)
      THEN RAISE EXCEPTION 'Promotion retry requires its exact failed predecessor and human command'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.change_id,NEW.project_id,NEW.commit_sha,NEW.previous_runtime_attempt_id,
      NEW.requested_at,NEW.ordinal,NEW.supersedes_id,NEW.retry_command_id)
    IS DISTINCT FROM ROW(OLD.id,OLD.change_id,OLD.project_id,OLD.commit_sha,OLD.previous_runtime_attempt_id,
      OLD.requested_at,OLD.ordinal,OLD.supersedes_id,OLD.retry_command_id)
    OR (OLD.replacement_runtime_attempt_id IS NOT NULL
      AND NEW.replacement_runtime_attempt_id IS DISTINCT FROM OLD.replacement_runtime_attempt_id)
    OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)
    OR (OLD.state IN ('succeeded','failed') AND NEW.state IS DISTINCT FROM OLD.state)
    OR (OLD.state='failed' AND NEW IS DISTINCT FROM OLD)
  THEN RAISE EXCEPTION 'Promotion identity and terminal outcome are immutable'; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER promotion_operation_protection BEFORE INSERT OR UPDATE ON factory.promotion_operation
  FOR EACH ROW EXECUTE FUNCTION factory.protect_promotion_operation();

INSERT INTO factory.schema_migration(version) VALUES(5);
COMMIT;
