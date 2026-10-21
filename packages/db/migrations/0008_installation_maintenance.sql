BEGIN;

CREATE TABLE factory.installation_maintenance (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  requested_at timestamptz
);
INSERT INTO factory.installation_maintenance(singleton) VALUES (true);

-- Admissions hold a shared lock until their intent commits. Upgrade admission
-- takes the exclusive row lock before checking for active work, so neither a
-- concurrent request nor a detached background worker can slip new inference
-- between the idle check and the persisted maintenance fence.
CREATE FUNCTION factory.require_installation_admission() RETURNS trigger
LANGUAGE plpgsql AS $$
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

CREATE TRIGGER installation_admission BEFORE INSERT ON factory.agent_turn
  FOR EACH ROW EXECUTE FUNCTION factory.require_installation_admission();
CREATE TRIGGER installation_admission BEFORE INSERT ON factory.knowledge_generation
  FOR EACH ROW EXECUTE FUNCTION factory.require_installation_admission();
CREATE TRIGGER installation_admission BEFORE INSERT ON factory.model_role_probe
  FOR EACH ROW EXECUTE FUNCTION factory.require_installation_admission();
CREATE TRIGGER installation_admission BEFORE INSERT ON factory.project_setup_inspection
  FOR EACH ROW EXECUTE FUNCTION factory.require_installation_admission();

INSERT INTO factory.schema_migration(version) VALUES (8);
COMMIT;
