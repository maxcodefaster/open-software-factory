BEGIN;

-- External provisioning intent/outcomes, not a second runtime lifecycle. Names
-- stay retired even after Actor deletion. No retained Workspace is converted.
CREATE TABLE factory.substrate_workspace (
  workspace_id uuid PRIMARY KEY REFERENCES factory.development_workspace(id),
  intent jsonb NOT NULL CHECK (jsonb_typeof(intent)='object'),
  atespace_attempted_at timestamptz,
  atespace_rejected boolean NOT NULL DEFAULT false,
  atespace jsonb,
  policy_attempted_at timestamptz,
  policy_rejected boolean NOT NULL DEFAULT false,
  policy jsonb,
  template_attempted_at timestamptz,
  template_rejected boolean NOT NULL DEFAULT false,
  template jsonb,
  CHECK (atespace IS NULL OR atespace_attempted_at IS NOT NULL),
  CHECK (policy IS NULL OR policy_attempted_at IS NOT NULL),
  CHECK (template IS NULL OR template_attempted_at IS NOT NULL)
);
CREATE FUNCTION factory.protect_substrate_workspace() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Native Workspace provisioning names cannot be reused'; END IF;
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM factory.development_workspace w WHERE w.id=NEW.workspace_id
      AND w.substrate AND w.kind='personal'
      AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt a WHERE a.workspace_id=w.id)
      AND NOT EXISTS(SELECT 1 FROM factory.workspace_source s WHERE s.workspace_id=w.id))
      THEN RAISE EXCEPTION 'Native provisioning requires a fresh personal Workspace'; END IF;
  ELSIF ROW(NEW.workspace_id,NEW.intent) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.intent)
    OR (OLD.atespace_attempted_at IS NOT NULL AND NEW.atespace_attempted_at IS DISTINCT FROM OLD.atespace_attempted_at)
    OR (OLD.policy_attempted_at IS NOT NULL AND NEW.policy_attempted_at IS DISTINCT FROM OLD.policy_attempted_at)
    OR (OLD.template_attempted_at IS NOT NULL AND NEW.template_attempted_at IS DISTINCT FROM OLD.template_attempted_at)
    OR (OLD.atespace IS NOT NULL AND NEW.atespace IS DISTINCT FROM OLD.atespace)
    OR (OLD.policy IS NOT NULL AND NEW.policy IS DISTINCT FROM OLD.policy)
    OR (OLD.template IS NOT NULL AND NEW.template IS DISTINCT FROM OLD.template)
    OR (OLD.atespace_rejected AND NOT NEW.atespace_rejected)
    OR (OLD.policy_rejected AND NOT NEW.policy_rejected)
    OR (OLD.template_rejected AND NOT NEW.template_rejected)
    THEN RAISE EXCEPTION 'Native provisioning identity and dispatch facts are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER substrate_workspace_identity BEFORE INSERT OR UPDATE OR DELETE ON factory.substrate_workspace
  FOR EACH ROW EXECUTE FUNCTION factory.protect_substrate_workspace();

INSERT INTO factory.schema_migration(version) VALUES(20);
COMMIT;
