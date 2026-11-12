BEGIN;

-- Keep the original allocation and every FK/derived Namespace intact. The
-- singleton marker now identifies the default Source worker, not the pool size.
ALTER TABLE factory.factorybox_worker DROP CONSTRAINT factorybox_worker_pkey;
ALTER TABLE factory.factorybox_worker DROP CONSTRAINT factorybox_worker_singleton_check;
ALTER TABLE factory.factorybox_worker ADD PRIMARY KEY(id);
CREATE UNIQUE INDEX factorybox_default_worker ON factory.factorybox_worker(singleton) WHERE singleton;
CREATE UNIQUE INDEX factorybox_pool_node ON factory.factorybox_worker(node_name) WHERE NOT singleton;
ALTER TABLE factory.factorybox_worker ADD COLUMN node_identity jsonb;
ALTER TABLE factory.factorybox_worker ADD CHECK (singleton OR (node_name IS NOT NULL AND node_identity IS NOT NULL));

CREATE OR REPLACE FUNCTION factory.ensure_factorybox_worker() RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE worker_id uuid;
BEGIN
  INSERT INTO factory.factorybox_worker(singleton) VALUES(true)
    ON CONFLICT(singleton) WHERE singleton DO NOTHING;
  SELECT id INTO STRICT worker_id FROM factory.factorybox_worker WHERE singleton;
  RETURN worker_id;
END $$;

CREATE FUNCTION factory.protect_factorybox_pool_node() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.node_identity IS DISTINCT FROM OLD.node_identity
    THEN RAISE EXCEPTION 'Worker node admission identity is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER factorybox_pool_node_identity BEFORE UPDATE ON factory.factorybox_worker
  FOR EACH ROW EXECUTE FUNCTION factory.protect_factorybox_pool_node();

-- This milestone admits only fresh immutable Verification, never another
-- Workspace's canonical RWO Source or a promoted Staging template on a new node.
CREATE FUNCTION factory.validate_verification_pool_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM factory.factorybox_worker WHERE id=NEW.factorybox_worker_id AND singleton)
    AND (NEW.isolated_kind IS DISTINCT FROM 'verification' OR NEW.workspace_id IS NOT NULL
      OR NEW.change_id IS NOT NULL OR NEW.verification_id IS NULL)
    THEN RAISE EXCEPTION 'Remote worker placement requires fresh isolated Verification'; END IF;
  IF NEW.verification_id IS NOT NULL AND EXISTS(SELECT 1 FROM factory.verification_compute_placement placement
    WHERE placement.verification_id=NEW.verification_id
      AND (placement.worker_id<>NEW.factorybox_worker_id OR placement.admission_id<>NEW.factorybox_admission_id))
    THEN RAISE EXCEPTION 'Verification execution differs from its immutable placement'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER verification_pool_binding BEFORE INSERT OR UPDATE ON factory.runtime_attempt
  FOR EACH ROW EXECUTE FUNCTION factory.validate_verification_pool_binding();

CREATE TABLE factory.verification_compute_placement (
  verification_id uuid PRIMARY KEY REFERENCES factory.verification(id),
  worker_id uuid NOT NULL REFERENCES factory.factorybox_worker(id),
  admission_id uuid NOT NULL REFERENCES factory.factorybox_worker_admission(id),
  profile jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION factory.protect_verification_compute_placement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Verification placement is immutable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM factory.factorybox_worker_admission
    WHERE id=NEW.admission_id AND worker_id=NEW.worker_id AND retired_at IS NULL AND profile=NEW.profile)
    THEN RAISE EXCEPTION 'Verification placement requires its retained active admission/profile'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER verification_compute_placement_identity BEFORE INSERT OR UPDATE OR DELETE
  ON factory.verification_compute_placement FOR EACH ROW EXECUTE FUNCTION factory.protect_verification_compute_placement();

INSERT INTO factory.schema_migration(version) VALUES(17);
COMMIT;
