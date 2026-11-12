BEGIN;

-- Provisioning facts for the existing Project image preparation owner. No
-- Workspace, Source writer, synthetic worker or additional Actor lifecycle.
CREATE TABLE factory.substrate_prebuild (
  preparation_id uuid PRIMARY KEY REFERENCES factory.project_image_preparation(id),
  runtime_attempt_id uuid NOT NULL UNIQUE,
  generation bigint NOT NULL CHECK(generation=1),
  intent jsonb NOT NULL CHECK(jsonb_typeof(intent)='object'),
  atespace_attempted_at timestamptz,
  atespace_rejected boolean NOT NULL DEFAULT false,
  atespace jsonb,
  policy_attempted_at timestamptz,
  policy_rejected boolean NOT NULL DEFAULT false,
  policy jsonb,
  template_attempted_at timestamptz,
  template_rejected boolean NOT NULL DEFAULT false,
  template jsonb,
  CHECK(atespace IS NULL OR (atespace_attempted_at IS NOT NULL AND jsonb_typeof(atespace)='object')),
  CHECK(policy IS NULL OR (policy_attempted_at IS NOT NULL AND jsonb_typeof(policy)='object')),
  CHECK(template IS NULL OR (template_attempted_at IS NOT NULL AND jsonb_typeof(template)='object'))
);
CREATE FUNCTION factory.protect_substrate_prebuild() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE raw bytea;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Native prebuild provisioning names cannot be reused'; END IF;
  IF TG_OP='INSERT' THEN
    raw:=digest(NEW.preparation_id::text||':'||NEW.generation::text,'sha256');
    raw:=set_byte(raw,6,(get_byte(raw,6)&15)|80);
    raw:=set_byte(raw,8,(get_byte(raw,8)&63)|128);
    IF NEW.runtime_attempt_id<>encode(substring(raw from 1 for 16),'hex')::uuid
      OR NOT EXISTS(SELECT 1 FROM factory.project_image_preparation p JOIN factory.project project ON project.id=p.project_id
        LEFT JOIN factory.project_environment environment ON environment.project_id=p.project_id AND environment.environment=p.environment
        WHERE p.id=NEW.preparation_id AND p.runtime_attempt_id IS NULL AND p.state='pending'
          AND NEW.intent#>>'{configuration,projectID}'=p.project_id::text
          AND NEW.intent#>>'{configuration,database}'=current_database()
          AND NEW.intent->>'revision'=p.revision AND NEW.intent->>'repository'=project.repository_url
          AND NEW.intent#>>'{environment,environment}'=p.environment
          AND NEW.intent#>>'{environment,version}'=p.environment_version::text
          AND p.environment_version=COALESCE(environment.version,0)
          AND (NEW.intent#>>'{environment,secretKey}') IS NOT DISTINCT FROM environment.secret_key
          AND EXISTS(SELECT 1 FROM factory.environment_write publication_grant
            WHERE publication_grant.project_id=p.project_id AND publication_grant.environment=p.environment
              AND publication_grant.secret_key=environment.secret_key AND publication_grant.base_version+1=p.environment_version
              AND publication_grant.state='committed' AND publication_grant.manifest @> jsonb_build_object('registries',jsonb_build_array(
                jsonb_build_object('host',NEW.intent#>>'{configuration,prebuildRegistry}','hasPassword',true))))
          AND NEW.intent->>'imageRepository'=NEW.intent#>>'{configuration,prebuildRegistry}'||'/open-factory/prebuilds/'||p.project_id::text
          AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt a WHERE a.id=NEW.runtime_attempt_id))
      THEN RAISE EXCEPTION 'Native prebuild requires deterministic fresh exact-input intent'; END IF;
  ELSIF ROW(NEW.preparation_id,NEW.runtime_attempt_id,NEW.generation,NEW.intent)
      IS DISTINCT FROM ROW(OLD.preparation_id,OLD.runtime_attempt_id,OLD.generation,OLD.intent)
    OR (OLD.atespace_attempted_at IS NOT NULL AND NEW.atespace_attempted_at IS DISTINCT FROM OLD.atespace_attempted_at)
    OR (OLD.policy_attempted_at IS NOT NULL AND NEW.policy_attempted_at IS DISTINCT FROM OLD.policy_attempted_at)
    OR (OLD.template_attempted_at IS NOT NULL AND NEW.template_attempted_at IS DISTINCT FROM OLD.template_attempted_at)
    OR (OLD.atespace IS NOT NULL AND NEW.atespace IS DISTINCT FROM OLD.atespace)
    OR (OLD.policy IS NOT NULL AND NEW.policy IS DISTINCT FROM OLD.policy)
    OR (OLD.template IS NOT NULL AND NEW.template IS DISTINCT FROM OLD.template)
    OR (OLD.atespace_rejected AND NOT NEW.atespace_rejected)
    OR (OLD.policy_rejected AND NOT NEW.policy_rejected)
    OR (OLD.template_rejected AND NOT NEW.template_rejected)
    THEN RAISE EXCEPTION 'Native prebuild provisioning identity and dispatch facts are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER substrate_prebuild_identity BEFORE INSERT OR UPDATE OR DELETE ON factory.substrate_prebuild
  FOR EACH ROW EXECUTE FUNCTION factory.protect_substrate_prebuild();

ALTER TABLE factory.runtime_attempt DROP CONSTRAINT runtime_attempt_native_owner;
ALTER TABLE factory.runtime_attempt ADD CONSTRAINT runtime_attempt_native_owner CHECK (
  (substrate AND factorybox_worker_id IS NULL AND factorybox_admission_id IS NULL
    AND kubernetes_uid IS NULL AND kubernetes_namespace_uid IS NULL
    AND ((workspace_id IS NOT NULL AND isolated_kind IS NULL)
      OR (workspace_id IS NULL AND change_id IS NULL AND isolated_kind='verification' AND verification_id IS NOT NULL)
      OR (workspace_id IS NULL AND change_id IS NULL AND isolated_kind='prebuild' AND verification_id IS NULL)))
  OR (NOT substrate AND factorybox_worker_id IS NOT NULL AND factorybox_admission_id IS NOT NULL)
);

CREATE OR REPLACE FUNCTION factory.protect_substrate_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Native names and bindings cannot be reused'; END IF;
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM factory.runtime_attempt a WHERE a.id=NEW.runtime_attempt_id
      AND a.substrate AND a.state='create-intended' AND a.stop_intended_at IS NULL
      AND (EXISTS(SELECT 1 FROM factory.development_workspace w WHERE w.id=a.workspace_id AND w.substrate)
        OR EXISTS(SELECT 1 FROM factory.substrate_verification p WHERE p.verification_id=a.verification_id
          AND p.runtime_attempt_id=a.id AND p.generation=a.generation AND a.isolated_kind='verification'
          AND a.workspace_id IS NULL AND a.change_id IS NULL AND p.atespace IS NOT NULL
          AND p.policy IS NOT NULL AND p.template IS NOT NULL
          AND NEW.intent->>'projectID'=a.project_id::text
          AND NEW.intent->>'generation'=a.generation::text
          AND NEW.intent->>'verificationID'=p.verification_id::text
          AND NEW.intent->>'atespaceUID'=p.atespace#>>'{metadata,uid}'
          AND NEW.intent->>'templateUID'=p.template#>>'{metadata,uid}'
          AND NEW.intent->>'templateVersion'=p.template#>>'{metadata,version}'
          AND NEW.intent->>'templateSHA256'=p.intent->>'templateSHA256')
        OR EXISTS(SELECT 1 FROM factory.substrate_prebuild p JOIN factory.project_image_preparation preparation ON preparation.id=p.preparation_id
          WHERE p.runtime_attempt_id=a.id AND p.generation=a.generation AND a.isolated_kind='prebuild'
            AND a.workspace_id IS NULL AND a.change_id IS NULL AND preparation.runtime_attempt_id=a.id
            AND preparation.project_id=a.project_id AND preparation.revision=a.revision
            AND p.atespace IS NOT NULL AND p.policy IS NOT NULL AND p.template IS NOT NULL
            AND NOT p.atespace_rejected AND NOT p.policy_rejected AND NOT p.template_rejected
            AND NEW.intent->>'projectID'=a.project_id::text AND NEW.intent->>'generation'=a.generation::text
            AND NEW.intent->>'preparationID'=p.preparation_id::text
            AND NEW.intent->>'atespaceUID'=p.atespace#>>'{metadata,uid}'
            AND NEW.intent->>'templateUID'=p.template#>>'{metadata,uid}'
            AND NEW.intent->>'templateVersion'=p.template#>>'{metadata,version}'
            AND NEW.intent->>'templateSHA256'=p.intent->>'templateSHA256'
            AND NEW.intent->'environment'=p.intent->'environment'))
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
    THEN RAISE EXCEPTION 'Native binding identity and dispatch facts are immutable'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION factory.require_substrate_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.substrate IS DISTINCT FROM OLD.substrate
    THEN RAISE EXCEPTION 'Runtime engine identity is immutable'; END IF;
  IF NEW.substrate AND NOT EXISTS(SELECT 1 FROM factory.substrate_binding b WHERE b.runtime_attempt_id=NEW.id AND (
    EXISTS(SELECT 1 FROM factory.development_workspace w WHERE w.id=NEW.workspace_id AND w.substrate
      AND w.project_id=NEW.project_id AND w.change_id IS NOT DISTINCT FROM NEW.change_id)
    OR EXISTS(SELECT 1 FROM factory.substrate_verification p JOIN factory.verification v ON v.id=p.verification_id
      JOIN factory.change c ON c.id=v.change_id
      WHERE p.runtime_attempt_id=NEW.id AND p.verification_id=NEW.verification_id
        AND p.generation=NEW.generation AND c.project_id=NEW.project_id AND v.commit_sha=NEW.revision
        AND NEW.workspace_id IS NULL AND NEW.change_id IS NULL AND NEW.isolated_kind='verification'
        AND b.intent->>'verificationID'=p.verification_id::text)
    OR EXISTS(SELECT 1 FROM factory.substrate_prebuild p JOIN factory.project_image_preparation preparation ON preparation.id=p.preparation_id
      WHERE p.runtime_attempt_id=NEW.id AND p.generation=NEW.generation AND preparation.runtime_attempt_id=NEW.id
        AND preparation.project_id=NEW.project_id AND preparation.revision=NEW.revision
        AND NEW.workspace_id IS NULL AND NEW.change_id IS NULL AND NEW.isolated_kind='prebuild'
        AND b.intent->>'preparationID'=p.preparation_id::text)))
    THEN RAISE EXCEPTION 'Native Attempt requires its persisted matching owner binding'; END IF;
  RETURN NULL;
END $$;

INSERT INTO factory.schema_migration(version) VALUES(27);
COMMIT;
