BEGIN;

-- A retry's Attempt ID is not a dependency input. Keep the original template
-- ancestry, but require a healthy current promoted execution with the exact
-- same public recipe, artifacts and worker admission at every use.
CREATE FUNCTION factory.execution_template_is_current(slot factory.execution_slot)
RETURNS boolean LANGUAGE sql STABLE STRICT AS $$
  SELECT EXISTS (
    SELECT 1 FROM factory.runtime_attempt original
    JOIN factory.runtime_artifact_intent original_artifact ON original_artifact.runtime_attempt_id=original.id
    JOIN factory.staging_configuration original_configuration ON original_configuration.runtime_attempt_id=original.id
    JOIN factory.staging_preview preview ON preview.project_id=original.project_id
    JOIN factory.runtime_attempt current ON current.id=preview.runtime_attempt_id
    JOIN factory.runtime_artifact_intent artifact ON artifact.runtime_attempt_id=current.id
    JOIN factory.staging_configuration configuration ON configuration.runtime_attempt_id=current.id
    WHERE original.id=slot.staging_attempt_id AND original.project_id=slot.project_id
      AND original.isolated_kind='staging' AND original.revision=slot.revision
      AND original.factorybox_worker_id=slot.factorybox_worker_id
      AND original.factorybox_admission_id=slot.factorybox_admission_id
      AND original_artifact.runtime_host_image=slot.runtime_host_image
      AND original_artifact.factorybox_profile=slot.factorybox_profile
      AND original_configuration.declaration->>'devcontainerPath'=slot.project_recipe->>'devcontainerPath'
      AND original_configuration.declaration->'channels'=slot.project_recipe->'channels'
      AND original_configuration.declaration->'processes'=slot.project_recipe->'processes'
      AND preview.revision=slot.revision AND current.revision=slot.revision
      AND current.project_id=slot.project_id AND current.isolated_kind='staging'
      AND current.state='ready' AND current.stop_intended_at IS NULL
      AND current.factorybox_worker_id=slot.factorybox_worker_id
      AND current.factorybox_admission_id=slot.factorybox_admission_id
      AND artifact.runtime_host_image=slot.runtime_host_image
      AND artifact.factorybox_profile=slot.factorybox_profile
      AND configuration.declaration=original_configuration.declaration
      AND coalesce(slot.project_recipe->'deferRuntimeProcesses','false'::jsonb)=to_jsonb(
        coalesce((SELECT write.manifest<>'{"variables":[],"registries":[]}'::jsonb
          FROM factory.runtime_environment_intent environment
          JOIN factory.environment_write write ON write.secret_key=environment.secret_key AND write.state='committed'
          WHERE environment.runtime_attempt_id=current.id),false))
  )
$$;

CREATE OR REPLACE FUNCTION factory.protect_execution_slot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.project_id,NEW.staging_attempt_id,NEW.revision,NEW.template_id,NEW.template_key,NEW.project_recipe,NEW.seed_expires_at)
        IS DISTINCT FROM ROW(OLD.project_id,OLD.staging_attempt_id,OLD.revision,OLD.template_id,OLD.template_key,OLD.project_recipe,OLD.seed_expires_at)
      OR NEW.factorybox_worker_id <> OLD.factorybox_worker_id OR NEW.id <> OLD.id OR NEW.role <> OLD.role OR NEW.runtime_host_image <> OLD.runtime_host_image
      OR NEW.kubernetes_namespace <> OLD.kubernetes_namespace OR NEW.created_at <> OLD.created_at
      OR NEW.expires_at <> OLD.expires_at
      OR (OLD.namespace_uid IS NOT NULL AND NEW.namespace_uid IS DISTINCT FROM OLD.namespace_uid)
      OR (OLD.pod_uid IS NOT NULL AND NEW.pod_uid IS DISTINCT FROM OLD.pod_uid)
      OR (OLD.claim_uid IS NOT NULL AND NEW.claim_uid IS DISTINCT FROM OLD.claim_uid)
      OR (OLD.assigned_attempt_id IS NOT NULL AND
        (NEW.assigned_attempt_id IS DISTINCT FROM OLD.assigned_attempt_id OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at)) THEN
      RAISE EXCEPTION 'Execution slot identity and assignment are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.state <> OLD.state AND NOT (
      (OLD.state = 'creating' AND NEW.state IN ('ready','retiring')) OR
      (OLD.state = 'ready' AND NEW.state IN ('assigned','retiring')) OR
      (OLD.state = 'retiring' AND NEW.state = 'deleted') OR
      (OLD.state = 'assigned' AND NEW.state = 'deleted')
    ) THEN
      RAISE EXCEPTION 'Execution slots cannot return to the reserve' USING ERRCODE = '23514';
    END IF;
    IF NEW.assigned_attempt_id IS DISTINCT FROM OLD.assigned_attempt_id AND
      (OLD.state <> 'ready' OR NEW.state <> 'assigned' OR OLD.template_id IS NULL) THEN
      RAISE EXCEPTION 'Only a ready execution slot may be assigned once' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.state <> 'creating' OR NEW.assigned_attempt_id IS NOT NULL OR NEW.namespace_uid IS NOT NULL OR NEW.pod_uid IS NOT NULL THEN
    RAISE EXCEPTION 'Execution slots require clean create intent' USING ERRCODE = '23514';
  END IF;
  IF (TG_OP='INSERT' OR
      (TG_OP='UPDATE' AND NEW.assigned_attempt_id IS DISTINCT FROM OLD.assigned_attempt_id)) AND (
    NOT factory.execution_template_is_current(NEW)
    OR (TG_OP='INSERT' AND NEW.template_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM factory.staging_preview preview WHERE preview.project_id=NEW.project_id
        AND preview.runtime_attempt_id=NEW.staging_attempt_id
    ))
  ) THEN
    RAISE EXCEPTION 'Execution pool requires the healthy promoted Staging identity';
  END IF;
  IF NEW.template_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM factory.execution_slot template WHERE template.id=NEW.template_id
      AND template.template_id IS NULL AND template.project_id=NEW.project_id
      AND template.staging_attempt_id=NEW.staging_attempt_id AND template.revision=NEW.revision
      AND template.template_key=NEW.template_key AND template.project_recipe=NEW.project_recipe
      AND template.seed_expires_at=NEW.seed_expires_at
      AND template.factorybox_worker_id=NEW.factorybox_worker_id
      AND template.runtime_host_image=NEW.runtime_host_image AND template.factorybox_profile=NEW.factorybox_profile
  ) THEN
    RAISE EXCEPTION 'Standby Fork must retain its exact clean Staging template';
  END IF;
  RETURN NEW;
END $$;

INSERT INTO factory.schema_migration(version) VALUES(7);
COMMIT;
