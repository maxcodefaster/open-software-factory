BEGIN;

CREATE TABLE factory.factorybox_worker_admission (
  id uuid PRIMARY KEY,
  worker_id uuid NOT NULL REFERENCES factory.factorybox_worker(id),
  previous_id uuid UNIQUE REFERENCES factory.factorybox_worker_admission(id),
  profile jsonb,
  runtime_host_image text,
  claim_uid text,
  pod_uid text,
  identity jsonb,
  create_attempted boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES auth."user"(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  retirement_observation jsonb,
  CHECK ((profile IS NULL) = (runtime_host_image IS NULL)),
  CHECK (runtime_host_image IS NULL OR runtime_host_image ~ '@sha256:[0-9a-f]{64}$'),
  CHECK ((previous_id IS NULL AND id=worker_id AND created_by IS NULL)
    OR (previous_id IS NOT NULL AND id<>worker_id AND created_by IS NOT NULL)),
  CHECK ((retired_at IS NULL) = (retirement_observation IS NULL))
);
CREATE UNIQUE INDEX factorybox_one_active_admission
  ON factory.factorybox_worker_admission(worker_id) WHERE retired_at IS NULL;

-- This is an additive receipt of the original admission, not replacement of its
-- Pod, store, profile, source, namespace or native identity.
INSERT INTO factory.factorybox_worker_admission(
  id,worker_id,profile,runtime_host_image,claim_uid,pod_uid,identity,create_attempted,created_at)
  SELECT id,id,profile,runtime_host_image,claim_uid,pod_uid,identity,create_attempted,created_at
  FROM factory.factorybox_worker;

CREATE FUNCTION factory.factorybox_admission_pod(worker_id uuid, admission_id uuid)
RETURNS text LANGUAGE sql IMMUTABLE STRICT
AS $$ SELECT CASE WHEN worker_id=admission_id THEN 'worker'
  ELSE 'worker-'||replace(admission_id::text,'-','') END $$;

CREATE FUNCTION factory.ensure_factorybox_admission() RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE allocation_id uuid; selected_id uuid;
BEGIN
  allocation_id := factory.ensure_factorybox_worker();
  INSERT INTO factory.factorybox_worker_admission(
    id,worker_id,profile,runtime_host_image,claim_uid,pod_uid,identity,create_attempted,created_at)
    SELECT id,id,profile,runtime_host_image,claim_uid,pod_uid,identity,create_attempted,created_at
    FROM factory.factorybox_worker WHERE id=allocation_id ON CONFLICT(id) DO NOTHING;
  SELECT id INTO STRICT selected_id FROM factory.factorybox_worker_admission
    WHERE worker_id=allocation_id
      AND retired_at IS NULL;
  RETURN selected_id;
END $$;

ALTER TABLE factory.runtime_attempt ADD COLUMN factorybox_admission_id uuid
  REFERENCES factory.factorybox_worker_admission(id);
UPDATE factory.runtime_attempt SET factorybox_admission_id=factorybox_worker_id;
-- Retained rows queue deferred FK/read-version checks. Flush them before
-- changing the stored derived column on this same populated table.
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE factory.runtime_attempt ALTER COLUMN factorybox_admission_id SET NOT NULL;
ALTER TABLE factory.runtime_attempt ALTER COLUMN factorybox_admission_id
  SET DEFAULT factory.ensure_factorybox_admission();
-- PostgreSQL 16 cannot change a stored generated expression in place. The
-- original derived value remains exactly 'worker' for every retained row.
ALTER TABLE factory.runtime_attempt DROP COLUMN kubernetes_pod_name;
ALTER TABLE factory.runtime_attempt ADD COLUMN kubernetes_pod_name text
  GENERATED ALWAYS AS (
    factory.factorybox_admission_pod(factorybox_worker_id,factorybox_admission_id)
  ) STORED NOT NULL;

ALTER TABLE factory.execution_slot ADD COLUMN factorybox_admission_id uuid
  REFERENCES factory.factorybox_worker_admission(id);
UPDATE factory.execution_slot SET factorybox_admission_id=factorybox_worker_id;
ALTER TABLE factory.execution_slot ALTER COLUMN factorybox_admission_id SET NOT NULL;
ALTER TABLE factory.execution_slot ALTER COLUMN factorybox_admission_id
  SET DEFAULT factory.ensure_factorybox_admission();

CREATE FUNCTION factory.protect_factorybox_admission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Worker admissions cannot be deleted'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.previous_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM factory.factorybox_worker_admission previous
      WHERE previous.id=NEW.previous_id AND previous.worker_id=NEW.worker_id
        AND previous.retired_at IS NOT NULL AND previous.identity IS NULL
        AND previous.create_attempted AND previous.pod_uid IS NOT NULL
    ) THEN RAISE EXCEPTION 'Bootstrap recovery requires its retired original admission'; END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.worker_id,NEW.previous_id,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.worker_id,OLD.previous_id,OLD.created_by,OLD.created_at)
    OR (OLD.profile IS NOT NULL AND NEW.profile IS DISTINCT FROM OLD.profile)
    OR (OLD.runtime_host_image IS NOT NULL AND NEW.runtime_host_image IS DISTINCT FROM OLD.runtime_host_image)
    OR (OLD.claim_uid IS NOT NULL AND NEW.claim_uid IS DISTINCT FROM OLD.claim_uid)
    OR (OLD.pod_uid IS NOT NULL AND NEW.pod_uid IS DISTINCT FROM OLD.pod_uid)
    OR (OLD.identity IS NOT NULL AND NEW.identity IS DISTINCT FROM OLD.identity)
    OR (OLD.create_attempted AND NOT NEW.create_attempted)
    OR (OLD.retired_at IS NOT NULL AND NEW IS DISTINCT FROM OLD)
  THEN RAISE EXCEPTION 'Worker admission identity and outcome are immutable'; END IF;
  IF NEW.retired_at IS NOT NULL AND OLD.retired_at IS NULL AND (
    OLD.identity IS NOT NULL OR OLD.pod_uid IS NULL OR NOT OLD.create_attempted
    OR NEW.retirement_observation->>'podUID' IS DISTINCT FROM OLD.pod_uid
    OR coalesce(NEW.retirement_observation->>'phase' NOT IN ('Failed','Succeeded'),true)
    OR EXISTS (SELECT 1 FROM factory.runtime_attempt attempt
      WHERE attempt.factorybox_admission_id=OLD.id AND attempt.state NOT IN ('failed','stopped'))
    OR EXISTS (SELECT 1 FROM factory.runtime_attempt attempt
      JOIN factory.factorybox_runtime runtime ON runtime.runtime_attempt_id=attempt.id
      WHERE attempt.factorybox_admission_id=OLD.id AND runtime.identity IS NOT NULL)
    OR EXISTS (SELECT 1 FROM factory.execution_slot slot
      WHERE slot.factorybox_admission_id=OLD.id AND slot.state<>'deleted')
  ) THEN RAISE EXCEPTION 'Bootstrap recovery requires confirmed terminal unused worker'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER factorybox_admission_identity
  BEFORE INSERT OR UPDATE OR DELETE ON factory.factorybox_worker_admission
  FOR EACH ROW EXECUTE FUNCTION factory.protect_factorybox_admission();

-- The original allocation's retained admission fields remain immutable and
-- continue to mirror that first admission only. A successor never writes them.
CREATE FUNCTION factory.sync_original_factorybox_admission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE factory.factorybox_worker_admission SET
    profile=NEW.profile,runtime_host_image=NEW.runtime_host_image,claim_uid=NEW.claim_uid,
    pod_uid=NEW.pod_uid,identity=NEW.identity,create_attempted=NEW.create_attempted
    WHERE id=NEW.id;
  RETURN NEW;
END $$;
CREATE TRIGGER factorybox_original_admission AFTER UPDATE ON factory.factorybox_worker
  FOR EACH ROW WHEN (
    ROW(OLD.profile,OLD.runtime_host_image,OLD.claim_uid,OLD.pod_uid,OLD.identity,OLD.create_attempted)
    IS DISTINCT FROM
    ROW(NEW.profile,NEW.runtime_host_image,NEW.claim_uid,NEW.pod_uid,NEW.identity,NEW.create_attempted)
  ) EXECUTE FUNCTION factory.sync_original_factorybox_admission();

CREATE FUNCTION factory.protect_factorybox_admission_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.factorybox_admission_id IS DISTINCT FROM OLD.factorybox_admission_id
    THEN RAISE EXCEPTION 'Execution admission is immutable'; END IF;
  IF TG_OP='INSERT' AND NOT EXISTS (
    SELECT 1 FROM factory.factorybox_worker_admission admission
    WHERE admission.id=NEW.factorybox_admission_id AND admission.worker_id=NEW.factorybox_worker_id
      AND admission.retired_at IS NULL
  ) THEN RAISE EXCEPTION 'Fresh execution requires its active worker admission'; END IF;
  IF TG_TABLE_NAME='execution_slot' THEN
    IF NOT EXISTS (SELECT 1 FROM factory.runtime_attempt staging
      WHERE staging.id=NEW.staging_attempt_id AND staging.factorybox_admission_id=NEW.factorybox_admission_id)
      OR (NEW.template_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM factory.execution_slot template WHERE template.id=NEW.template_id
          AND template.factorybox_admission_id=NEW.factorybox_admission_id))
    THEN RAISE EXCEPTION 'Execution pool must retain its original worker admission'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER runtime_admission_binding BEFORE INSERT OR UPDATE ON factory.runtime_attempt
  FOR EACH ROW EXECUTE FUNCTION factory.protect_factorybox_admission_binding();
CREATE TRIGGER slot_admission_binding BEFORE INSERT OR UPDATE ON factory.execution_slot
  FOR EACH ROW EXECUTE FUNCTION factory.protect_factorybox_admission_binding();

CREATE OR REPLACE FUNCTION factory.validate_execution_slot_assignment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assigned_attempt_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM factory.runtime_attempt attempt
    JOIN factory.runtime_artifact_intent artifact ON artifact.runtime_attempt_id=attempt.id
    WHERE attempt.id=NEW.assigned_attempt_id AND NEW.template_id IS NOT NULL
      AND attempt.isolated_kind IN ('staging','verification') AND attempt.project_id=NEW.project_id
      AND attempt.workspace_id IS NULL AND attempt.kubernetes_namespace=NEW.kubernetes_namespace
      AND attempt.factorybox_worker_id=NEW.factorybox_worker_id
      AND attempt.factorybox_admission_id=NEW.factorybox_admission_id
      AND artifact.runtime_host_image=NEW.runtime_host_image
  ) THEN RAISE EXCEPTION 'Execution slot assignment requires matching immutable runtime intent'
    USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;

INSERT INTO factory.schema_migration(version) VALUES(2);
COMMIT;
