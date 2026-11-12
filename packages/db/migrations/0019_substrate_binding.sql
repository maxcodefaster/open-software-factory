BEGIN;

ALTER TABLE factory.development_workspace ADD COLUMN substrate boolean NOT NULL DEFAULT false;
ALTER TABLE factory.development_workspace ALTER COLUMN factorybox_worker_id DROP NOT NULL;
ALTER TABLE factory.development_workspace ALTER COLUMN kubernetes_namespace DROP NOT NULL;
ALTER TABLE factory.development_workspace ADD CHECK (
  (substrate AND factorybox_worker_id IS NULL AND kind='personal') OR (NOT substrate AND factorybox_worker_id IS NOT NULL)
);
CREATE FUNCTION factory.protect_workspace_runtime_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.substrate IS DISTINCT FROM OLD.substrate
    OR NEW.factorybox_worker_id IS DISTINCT FROM OLD.factorybox_worker_id
    THEN RAISE EXCEPTION 'Workspace runtime identity is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workspace_runtime_identity BEFORE UPDATE ON factory.development_workspace
  FOR EACH ROW EXECUTE FUNCTION factory.protect_workspace_runtime_binding();
CREATE FUNCTION factory.require_legacy_source_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM factory.development_workspace WHERE id=NEW.workspace_id AND substrate)
    THEN RAISE EXCEPTION 'Native Workspace Source handoff is not enabled'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER native_source_handoff_gate BEFORE INSERT ON factory.workspace_source
  FOR EACH ROW EXECUTE FUNCTION factory.require_legacy_source_binding();

-- Native Actors are not Factorybox workers. Retained rows and generated legacy
-- identities are unchanged; only new, explicitly native attempts omit them.
ALTER TABLE factory.runtime_attempt ADD COLUMN substrate boolean NOT NULL DEFAULT false;
ALTER TABLE factory.runtime_attempt ALTER COLUMN factorybox_worker_id DROP NOT NULL;
ALTER TABLE factory.runtime_attempt ALTER COLUMN factorybox_admission_id DROP NOT NULL;
ALTER TABLE factory.runtime_attempt ALTER COLUMN kubernetes_namespace DROP NOT NULL;
ALTER TABLE factory.runtime_attempt ALTER COLUMN kubernetes_pod_name DROP NOT NULL;
ALTER TABLE factory.runtime_attempt ADD CHECK (
  (substrate AND factorybox_worker_id IS NULL AND factorybox_admission_id IS NULL
    AND kubernetes_uid IS NULL AND kubernetes_namespace_uid IS NULL
    AND workspace_id IS NOT NULL AND change_id IS NULL AND isolated_kind IS NULL)
  OR (NOT substrate AND factorybox_worker_id IS NOT NULL AND factorybox_admission_id IS NOT NULL)
);

-- Retain the existing implementations, including their worker retirement locks.
DROP TRIGGER runtime_admission_binding ON factory.runtime_attempt;
CREATE TRIGGER runtime_admission_binding BEFORE INSERT OR UPDATE ON factory.runtime_attempt
  FOR EACH ROW WHEN (NOT NEW.substrate) EXECUTE FUNCTION factory.protect_factorybox_admission_binding();
DROP TRIGGER verification_pool_binding ON factory.runtime_attempt;
CREATE TRIGGER verification_pool_binding BEFORE INSERT OR UPDATE ON factory.runtime_attempt
  FOR EACH ROW WHEN (NOT NEW.substrate) EXECUTE FUNCTION factory.validate_verification_pool_binding();

CREATE TABLE factory.substrate_binding (
  runtime_attempt_id uuid PRIMARY KEY REFERENCES factory.runtime_attempt(id),
  atespace text NOT NULL UNIQUE,
  actor_name text NOT NULL,
  intent jsonb NOT NULL CHECK (jsonb_typeof(intent)='object'),
  actor_uid uuid UNIQUE,
  create_attempted_at timestamptz,
  create_rejected boolean NOT NULL DEFAULT false,
  delete_intended_at timestamptz,
  deleted_at timestamptz,
  observation jsonb,
  checkpoint jsonb,
  UNIQUE(atespace,actor_name),
  CHECK (actor_uid IS NULL OR create_attempted_at IS NOT NULL),
  CHECK (deleted_at IS NULL OR delete_intended_at IS NOT NULL)
);

CREATE FUNCTION factory.protect_substrate_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Native names and bindings cannot be reused'; END IF;
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM factory.runtime_attempt a WHERE a.id=NEW.runtime_attempt_id
      AND a.substrate AND a.state='create-intended' AND a.stop_intended_at IS NULL
      AND EXISTS(SELECT 1 FROM factory.development_workspace w WHERE w.id=a.workspace_id AND w.substrate)
      AND NEW.atespace='fa-'||replace(a.id::text,'-','')
      AND NEW.actor_name='runtime-'||replace(a.id::text,'-',''))
      THEN RAISE EXCEPTION 'Native binding requires deterministic active Attempt intent'; END IF;
  ELSIF ROW(NEW.runtime_attempt_id,NEW.atespace,NEW.actor_name,NEW.intent)
    IS DISTINCT FROM ROW(OLD.runtime_attempt_id,OLD.atespace,OLD.actor_name,OLD.intent)
    OR (OLD.actor_uid IS NOT NULL AND NEW.actor_uid IS DISTINCT FROM OLD.actor_uid)
    OR (OLD.create_attempted_at IS NOT NULL AND NEW.create_attempted_at IS DISTINCT FROM OLD.create_attempted_at)
    OR (OLD.create_rejected AND NOT NEW.create_rejected)
    OR (OLD.delete_intended_at IS NOT NULL AND NEW.delete_intended_at IS DISTINCT FROM OLD.delete_intended_at)
    OR (OLD.deleted_at IS NOT NULL AND NEW IS DISTINCT FROM OLD)
    THEN RAISE EXCEPTION 'Native binding identity and dispatch facts are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER substrate_binding_identity BEFORE INSERT OR UPDATE OR DELETE ON factory.substrate_binding
  FOR EACH ROW EXECUTE FUNCTION factory.protect_substrate_binding();

CREATE FUNCTION factory.require_substrate_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.substrate IS DISTINCT FROM OLD.substrate
    THEN RAISE EXCEPTION 'Runtime engine identity is immutable'; END IF;
  IF NEW.substrate AND NOT EXISTS(SELECT 1 FROM factory.substrate_binding WHERE runtime_attempt_id=NEW.id)
    THEN RAISE EXCEPTION 'Native Attempt requires its persisted binding'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER substrate_attempt_binding AFTER INSERT OR UPDATE ON factory.runtime_attempt
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.require_substrate_binding();

INSERT INTO factory.schema_migration(version) VALUES(19);
COMMIT;
