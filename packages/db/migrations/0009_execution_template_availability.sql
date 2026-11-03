BEGIN;

-- A prepared credential-free checkpoint belongs to a promoted recipe, not to
-- that Staging process's current connection or running state.
CREATE OR REPLACE FUNCTION factory.execution_template_is_current(slot factory.execution_slot)
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

-- Creating the initial clean template still needs a genuinely healthy Staging.
-- Only descendants of that already-admitted template are independent of its
-- later availability. Do not turn a failed first Start into a warm basis.
CREATE FUNCTION factory.protect_execution_template_initial_health() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM factory.runtime_attempt staging
    WHERE staging.id=NEW.staging_attempt_id AND staging.state='ready'
      AND staging.stop_intended_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Initial execution template requires healthy Staging';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER execution_template_initial_health
  BEFORE INSERT ON factory.execution_slot
  FOR EACH ROW WHEN (NEW.template_id IS NULL)
  EXECUTE FUNCTION factory.protect_execution_template_initial_health();

INSERT INTO factory.schema_migration(version) VALUES(9);
COMMIT;
