-- Enum additions must commit before indexes use their new values.
BEGIN;
ALTER TYPE factory.runtime_attempt_state ADD VALUE IF NOT EXISTS 'pausing';
ALTER TYPE factory.runtime_attempt_state ADD VALUE IF NOT EXISTS 'paused';
ALTER TYPE factory.runtime_attempt_state ADD VALUE IF NOT EXISTS 'resuming';
COMMIT;

BEGIN;
ALTER TABLE factory.runtime_artifact_intent ADD COLUMN factorybox_profile jsonb;
ALTER TABLE factory.execution_slot
  ADD COLUMN factorybox_profile jsonb,
  ADD COLUMN factorybox_identity jsonb,
  ADD COLUMN factorybox_preparation jsonb,
  ADD COLUMN factorybox_start_attempted boolean NOT NULL DEFAULT false;
CREATE FUNCTION factory.protect_factorybox_slot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.factorybox_profile IS DISTINCT FROM OLD.factorybox_profile
    OR (OLD.factorybox_identity IS NOT NULL AND NEW.factorybox_identity IS DISTINCT FROM OLD.factorybox_identity)
    OR (OLD.factorybox_preparation IS NOT NULL AND NEW.factorybox_preparation IS DISTINCT FROM OLD.factorybox_preparation)
    OR (OLD.factorybox_start_attempted AND NOT NEW.factorybox_start_attempted) THEN
    RAISE EXCEPTION 'Factorybox execution slot artifacts and admitted identity are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER factorybox_slot_identity BEFORE UPDATE ON factory.execution_slot
  FOR EACH ROW EXECUTE FUNCTION factory.protect_factorybox_slot();
CREATE TABLE factory.factorybox_runtime (
  runtime_attempt_id uuid PRIMARY KEY REFERENCES factory.runtime_attempt(id),
  request jsonb NOT NULL,
  identity jsonb,
  inputs_released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE factory.factorybox_lifecycle_operation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  runtime_attempt_id uuid NOT NULL REFERENCES factory.factorybox_runtime(runtime_attempt_id),
  action text NOT NULL CHECK(action IN ('prepare','start','pause','resume','delete')),
  snapshot_id text CHECK(snapshot_id ~ '^[a-f0-9]{32}$'),
  intended_at timestamptz NOT NULL DEFAULT now(),
  attempted_at timestamptz,
  completed_at timestamptz,
  observation jsonb,
  CHECK((action IN ('pause','resume')) = (snapshot_id IS NOT NULL)),
  UNIQUE NULLS NOT DISTINCT(runtime_attempt_id,action,snapshot_id)
);
CREATE FUNCTION factory.protect_factorybox_runtime() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM factory.runtime_attempt WHERE id=NEW.runtime_attempt_id
      AND state='starting' AND stop_intended_at IS NULL) THEN
      RAISE EXCEPTION 'Factorybox preparation requires its active Runtime Attempt';
    END IF;
  ELSIF NEW.runtime_attempt_id<>OLD.runtime_attempt_id OR NEW.request IS DISTINCT FROM OLD.request
    OR NEW.created_at<>OLD.created_at OR (OLD.identity IS NOT NULL AND NEW.identity IS DISTINCT FROM OLD.identity) THEN
    RAISE EXCEPTION 'Factorybox request and admitted identity are immutable';
  END IF;
  IF TG_OP='UPDATE' AND OLD.inputs_released_at IS NOT NULL AND NEW.inputs_released_at IS DISTINCT FROM OLD.inputs_released_at THEN
    RAISE EXCEPTION 'Factorybox input release observation is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER factorybox_runtime_identity BEFORE INSERT OR UPDATE ON factory.factorybox_runtime
  FOR EACH ROW EXECUTE FUNCTION factory.protect_factorybox_runtime();
CREATE FUNCTION factory.protect_factorybox_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.runtime_attempt_id,NEW.action,NEW.snapshot_id,NEW.intended_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.runtime_attempt_id,OLD.action,OLD.snapshot_id,OLD.intended_at)
    OR (OLD.attempted_at IS NOT NULL AND NEW.attempted_at IS DISTINCT FROM OLD.attempted_at)
    OR (OLD.completed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Factorybox lifecycle intent and completed observation are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER factorybox_operation_identity BEFORE UPDATE ON factory.factorybox_lifecycle_operation
  FOR EACH ROW EXECUTE FUNCTION factory.protect_factorybox_operation();

DROP INDEX factory.runtime_attempt_one_active_per_change;
DROP INDEX factory.runtime_attempt_one_active_per_workspace;
CREATE UNIQUE INDEX runtime_attempt_one_active_per_change ON factory.runtime_attempt(change_id)
  WHERE change_id IS NOT NULL AND state NOT IN ('stopped','failed');
CREATE UNIQUE INDEX runtime_attempt_one_active_per_workspace ON factory.runtime_attempt(workspace_id)
  WHERE workspace_id IS NOT NULL AND state NOT IN ('stopped','failed');
INSERT INTO factory.schema_migration(version) VALUES(18);
COMMIT;
