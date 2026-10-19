BEGIN;

ALTER TABLE factory.developer_ide ADD COLUMN resource_id uuid;
-- Preserve every retained namespace and Pod identity until its explicit Stop.
UPDATE factory.developer_ide SET resource_id = user_id;
ALTER TABLE factory.developer_ide
  ALTER COLUMN resource_id SET NOT NULL,
  ALTER COLUMN resource_id SET DEFAULT gen_random_uuid(),
  ADD CONSTRAINT developer_ide_resource_id_unique UNIQUE (resource_id);

CREATE OR REPLACE FUNCTION factory.protect_developer_ide_intent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.service_epoch < OLD.service_epoch THEN
    RAISE EXCEPTION 'Developer IDE identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.service_epoch = OLD.service_epoch AND (
    NEW.resource_id IS DISTINCT FROM OLD.resource_id OR
    NEW.image IS DISTINCT FROM OLD.image OR
    (OLD.namespace_uid IS NOT NULL AND NEW.namespace_uid IS DISTINCT FROM OLD.namespace_uid) OR
    (OLD.pod_uid IS NOT NULL AND NEW.pod_uid IS DISTINCT FROM OLD.pod_uid)
  ) THEN RAISE EXCEPTION 'Developer IDE intent outcome is immutable' USING ERRCODE = '23514'; END IF;
  IF NEW.service_epoch <> OLD.service_epoch AND (
    NEW.service_epoch <> OLD.service_epoch + 1 OR OLD.state <> 'stopped' OR NEW.state <> 'create-intended' OR
    NEW.pod_uid IS NOT NULL OR
    CASE WHEN NEW.resource_id = OLD.resource_id
      THEN NEW.namespace_uid IS DISTINCT FROM OLD.namespace_uid
      ELSE OLD.resource_id <> OLD.user_id OR NEW.resource_id = NEW.user_id OR NEW.namespace_uid IS NOT NULL
    END
  ) THEN RAISE EXCEPTION 'Stop the Developer IDE before issuing a new epoch' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;

INSERT INTO factory.schema_migration(version) VALUES (4);
COMMIT;
