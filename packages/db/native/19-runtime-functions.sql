-- Runtime routines. Run before Drizzle tables, with check_function_bodies disabled.

CREATE FUNCTION factory.image_build_is_public(secret_key text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $_$
  SELECT $1 IS NULL OR EXISTS (
    SELECT 1 FROM factory.environment_write write
    WHERE write.secret_key=$1 AND write.state='committed'
      AND write.manifest->'registries'='[]'::jsonb
      AND jsonb_typeof(write.manifest->'variables')='array'
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(write.manifest->'variables') variable
        WHERE variable->'build' IS DISTINCT FROM 'false'::jsonb
      )
  )
$_$;

CREATE FUNCTION factory.protect_developer_ide_intent() RETURNS trigger
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

CREATE FUNCTION factory.protect_development_workspace_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.id,NEW.project_id,NEW.kind,NEW.owner_user_id,NEW.ticket_id,NEW.change_id,
      NEW.source_branch,NEW.source_revision,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.project_id,OLD.kind,OLD.owner_user_id,OLD.ticket_id,OLD.change_id,
      OLD.source_branch,OLD.source_revision,OLD.created_by,OLD.created_at)
    THEN RAISE EXCEPTION 'Development Workspace identity and source are immutable'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION factory.protect_project_image_preparation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.environment<>OLD.environment OR NEW.revision<>OLD.revision OR NEW.environment_version<>OLD.environment_version OR NEW.created_at<>OLD.created_at
    OR (OLD.runtime_attempt_id IS NOT NULL AND NEW.runtime_attempt_id IS DISTINCT FROM OLD.runtime_attempt_id)
    OR (OLD.state IN ('succeeded','unsupported','failed') AND (NEW.state<>OLD.state OR NEW.identity IS DISTINCT FROM OLD.identity OR NEW.image IS DISTINCT FROM OLD.image)) THEN
    RAISE EXCEPTION 'Project image preparation intent and confirmed outcome are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.runtime_attempt_id IS NOT NULL AND OLD.runtime_attempt_id IS NULL AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt WHERE id=NEW.runtime_attempt_id AND project_id=NEW.project_id AND revision=NEW.revision AND isolated_kind='prebuild' AND state='create-intended' AND stop_intended_at IS NULL) THEN
    RAISE EXCEPTION 'Image preparation must reference matching producer intent' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.protect_repository_mirror_command() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF ROW(NEW.id,NEW.project_id,NEW.created_by,NEW.action,NEW.target_url,NEW.remote_name,
           NEW.fingerprint,NEW.before_state,NEW.created_at) IS DISTINCT FROM
       ROW(OLD.id,OLD.project_id,OLD.created_by,OLD.action,OLD.target_url,OLD.remote_name,
           OLD.fingerprint,OLD.before_state,OLD.created_at)
       OR (OLD.state IN ('completed','failed','acknowledged') AND NEW IS DISTINCT FROM OLD) THEN
        RAISE EXCEPTION 'Repository mirror command identity and terminal outcome are immutable';
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION factory.protect_runtime_attempt_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.id,NEW.project_id,NEW.change_id,NEW.workspace_id,NEW.generation,NEW.revision,
      NEW.isolated_kind,NEW.verification_id,NEW.parent_connector_token_hash,NEW.child_connector_token_hash,
      NEW.create_intended_at,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.project_id,OLD.change_id,OLD.workspace_id,OLD.generation,OLD.revision,
      OLD.isolated_kind,OLD.verification_id,OLD.parent_connector_token_hash,OLD.child_connector_token_hash,
      OLD.create_intended_at,OLD.created_by,OLD.created_at)
    OR (OLD.declared_apps<>'[]'::jsonb AND NEW.declared_apps IS DISTINCT FROM OLD.declared_apps)
    THEN RAISE EXCEPTION 'Runtime Attempt identity and create intent are immutable'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION factory.protect_runtime_environment_intent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE project uuid; expected_environment text; current_version bigint; current_key text; publication boolean;
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Runtime environment intent is immutable' USING ERRCODE='23514'; END IF;
  SELECT project_id,isolated_kind='publication',CASE WHEN isolated_kind='staging' THEN 'main-preview' ELSE 'development' END
    INTO project,publication,expected_environment FROM factory.runtime_attempt
    WHERE id=NEW.runtime_attempt_id AND state='create-intended' AND stop_intended_at IS NULL;
  IF publication THEN
    IF NEW.environment<>'development' OR NEW.version<>0 OR NEW.secret_key IS NOT NULL THEN
      RAISE EXCEPTION 'Publication cannot inherit Project environments' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT COALESCE((SELECT environment FROM factory.project_image_preparation WHERE runtime_attempt_id=NEW.runtime_attempt_id),expected_environment) INTO expected_environment;
  IF project IS NULL OR expected_environment<>NEW.environment THEN
    RAISE EXCEPTION 'Runtime environment requires matching active create intent' USING ERRCODE='23514';
  END IF;
  SELECT version,secret_key INTO current_version,current_key FROM factory.project_environment
    WHERE project_id=project AND environment=expected_environment;
  IF NEW.version<>COALESCE(current_version,0) OR NEW.secret_key IS DISTINCT FROM current_key THEN
    RAISE EXCEPTION 'Runtime environment must reference current protected values' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;

CREATE FUNCTION factory.protect_substrate_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
            AND NEW.intent->'environment'=p.intent->'environment')
        OR EXISTS(SELECT 1 FROM factory.substrate_isolated p
          WHERE p.runtime_attempt_id=a.id AND p.project_id=a.project_id AND p.generation=a.generation
            AND p.kind=a.isolated_kind::text AND a.workspace_id IS NULL AND a.change_id IS NULL AND a.verification_id IS NULL
            AND p.intent->>'revision'=a.revision AND p.intent->>'createdBy'=a.created_by::text
            AND p.atespace IS NOT NULL AND p.policy IS NOT NULL AND p.template IS NOT NULL
            AND NOT p.atespace_rejected AND NOT p.policy_rejected AND NOT p.template_rejected
            AND NEW.intent->>'projectID'=a.project_id::text AND NEW.intent->>'generation'=a.generation::text
            AND NEW.intent->>'isolatedID'=p.owner_id::text AND NEW.intent->>'isolatedKind'=p.kind
            AND (NEW.intent->>'promotionID') IS NOT DISTINCT FROM p.intent->>'promotionID'
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

CREATE FUNCTION factory.protect_substrate_prebuild() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION factory.protect_substrate_source() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Source ownership and checkpoints cannot be discarded'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.owner<>'actor' OR NEW.writer_epoch<>1 OR NOT NEW.writable OR NEW.generation<>0
      OR NOT EXISTS(SELECT 1 FROM factory.runtime_attempt a JOIN factory.substrate_binding b ON b.runtime_attempt_id=a.id
        WHERE a.workspace_id=NEW.workspace_id AND a.substrate AND b.actor_uid=NEW.actor_uid
          AND b.delete_intended_at IS NULL AND b.deleted_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt n WHERE n.workspace_id=a.workspace_id AND n.generation>a.generation))
      THEN RAISE EXCEPTION 'Source requires its current original Actor binding'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.writer_epoch<OLD.writer_epoch OR NEW.writer_epoch>OLD.writer_epoch+1
    OR NEW.generation<OLD.generation OR NEW.generation>OLD.generation+1
    THEN RAISE EXCEPTION 'Source identity/epoch/generation changed'; END IF;
  IF NEW.actor_uid IS DISTINCT FROM OLD.actor_uid THEN
    IF OLD.owner<>'service' OR NEW.owner<>'actor' OR OLD.writable OR NOT NEW.writable
      OR NOT EXISTS(
        SELECT 1 FROM factory.runtime_attempt predecessor
        JOIN factory.substrate_binding old_binding ON old_binding.runtime_attempt_id=predecessor.id
        JOIN factory.runtime_attempt current ON current.workspace_id=predecessor.workspace_id
          AND current.generation=predecessor.generation+1
        JOIN factory.substrate_binding new_binding ON new_binding.runtime_attempt_id=current.id
        JOIN factory.substrate_workspace provision ON provision.workspace_id=current.workspace_id AND provision.generation=current.generation
        WHERE predecessor.workspace_id=NEW.workspace_id AND predecessor.state='stopped'
          AND old_binding.actor_uid=OLD.actor_uid AND old_binding.deleted_at IS NOT NULL
          AND current.substrate AND current.state='create-intended' AND current.stop_intended_at IS NULL
          AND new_binding.actor_uid=NEW.actor_uid AND NOT new_binding.create_rejected
          AND new_binding.create_attempted_at IS NOT NULL
          AND new_binding.delete_intended_at IS NULL AND new_binding.deleted_at IS NULL
          AND new_binding.intent->>'workspaceID'=NEW.workspace_id::text
          AND new_binding.intent->>'generation'=current.generation::text
          AND new_binding.intent->>'atespaceUID'=provision.atespace#>>'{metadata,uid}'
          AND new_binding.intent->>'templateUID'=provision.template#>>'{metadata,uid}'
          AND new_binding.intent->>'templateVersion'=provision.template#>>'{metadata,version}'
          AND new_binding.intent->>'templateSHA256'=provision.intent->>'templateSHA256'
          AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt newer WHERE newer.workspace_id=current.workspace_id AND newer.generation>current.generation))
      THEN RAISE EXCEPTION 'Source Actor transfer requires its confirmed stopped predecessor and current native successor'; END IF;
  END IF;
  IF NEW.generation<>OLD.generation THEN
    IF NEW.writable OR NEW.owner<>OLD.owner OR NEW.writer_epoch<>OLD.writer_epoch
      OR NEW.checkpoint_id IS DISTINCT FROM OLD.checkpoint_id
      OR NEW.checkpoint->>'id' IS DISTINCT FROM NEW.checkpoint_id::text
      OR NEW.checkpoint->>'workspaceID' IS DISTINCT FROM NEW.workspace_id::text
      OR NEW.checkpoint->>'actorUID' IS DISTINCT FROM NEW.actor_uid::text
      OR NEW.checkpoint->>'generation' IS DISTINCT FROM NEW.generation::text
      OR NEW.checkpoint->>'writerEpoch' IS DISTINCT FROM NEW.writer_epoch::text
      THEN RAISE EXCEPTION 'Source checkpoint confirmation differs from frozen writer'; END IF;
  ELSIF NEW.checkpoint IS DISTINCT FROM OLD.checkpoint THEN
    RAISE EXCEPTION 'Last confirmed Source is immutable until a new generation';
  END IF;
  IF NEW.owner<>OLD.owner THEN
    IF OLD.writable OR NOT NEW.writable OR NEW.writer_epoch<>OLD.writer_epoch+1
      OR OLD.checkpoint_id IS NULL OR OLD.checkpoint->>'id' IS DISTINCT FROM OLD.checkpoint_id::text
      OR NEW.checkpoint_id IS NOT NULL OR NEW.generation<>OLD.generation
      OR (NEW.owner='service' AND NEW.service_base IS DISTINCT FROM OLD.checkpoint_id)
      THEN RAISE EXCEPTION 'Source transfer requires a completely confirmed frozen generation'; END IF;
    IF NEW.actor_uid=OLD.actor_uid AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt a JOIN factory.substrate_binding b ON b.runtime_attempt_id=a.id
      WHERE a.workspace_id=NEW.workspace_id AND a.state='paused' AND b.actor_uid=NEW.actor_uid
        AND b.checkpoint->>'actorUID'=NEW.actor_uid::text
        AND b.checkpoint->>'fidelity'='SNAPSHOT_FIDELITY_ROOTFS'
        AND b.checkpoint#>>'{durableSnapshot,state}'='SNAPSHOT_STORAGE_STATE_COMPLETED'
        AND b.observation#>>'{status,state}'='ACTOR_STATE_SUSPENDED'
        AND b.checkpoint->>'generation'=b.observation#>>'{status,lastAssignedGeneration}')
      THEN RAISE EXCEPTION 'Source transfer requires the original durable paused ROOTFS'; END IF;
  ELSIF NEW.writable IS DISTINCT FROM OLD.writable THEN
    IF NOT OLD.writable OR NEW.writable OR NEW.writer_epoch<>OLD.writer_epoch+1 OR NEW.checkpoint_id IS NULL
      THEN RAISE EXCEPTION 'Source freeze must advance the writer epoch'; END IF;
  ELSIF ROW(NEW.writer_epoch,NEW.checkpoint_id,NEW.service_base) IS DISTINCT FROM ROW(OLD.writer_epoch,OLD.checkpoint_id,OLD.service_base) THEN
    RAISE EXCEPTION 'Source lease facts cannot change outside freeze/transfer';
  END IF;
  IF NEW.owner=OLD.owner AND NEW.service_base IS DISTINCT FROM OLD.service_base THEN
    RAISE EXCEPTION 'Source service base is immutable for its ownership interval'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION factory.protect_substrate_worker_capacity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Native worker capacity names cannot be reused'; END IF;
  IF TG_OP='INSERT' AND (
    NEW.intent->>'database' IS DISTINCT FROM current_database()
    OR NEW.intent#>>'{node,uid}' IS DISTINCT FROM NEW.node_uid::text
    OR NEW.intent#>>'{pool,metadata,name}' IS DISTINCT FROM 'factory-native-'||substring(encode(digest(NEW.owner||':'||NEW.node_uid::text,'sha256'),'hex') from 1 for 32)
    OR NEW.intent#>>'{pool,metadata,labels,factory.dev/native-capacity}' IS DISTINCT FROM NEW.owner
    OR NEW.intent#>>'{pool,metadata,annotations,factory.dev/creation-intent}' IS NULL)
    THEN RAISE EXCEPTION 'Native worker capacity requires deterministic installation and node intent'; END IF;
  IF TG_OP='UPDATE' AND (
    ROW(NEW.owner,NEW.node_uid,NEW.intent) IS DISTINCT FROM ROW(OLD.owner,OLD.node_uid,OLD.intent)
    OR (OLD.attempted_at IS NOT NULL AND NEW.attempted_at IS DISTINCT FROM OLD.attempted_at)
    OR (OLD.rejected AND NOT NEW.rejected)
    OR (OLD.pool IS NOT NULL AND NEW.pool IS DISTINCT FROM OLD.pool))
    THEN RAISE EXCEPTION 'Native worker capacity intent and creation facts are immutable'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION factory.protect_substrate_workspace() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE previous_generation bigint;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Native Workspace provisioning names cannot be reused'; END IF;
  IF TG_OP='INSERT' THEN
    SELECT max(generation) INTO previous_generation FROM factory.substrate_workspace
      WHERE workspace_id=NEW.workspace_id;
    IF (previous_generation IS NULL AND NEW.generation<>1)
      OR (previous_generation IS NOT NULL AND (
        NEW.generation<>previous_generation+1 OR NOT EXISTS(
          SELECT 1 FROM factory.runtime_attempt a JOIN factory.substrate_binding b ON b.runtime_attempt_id=a.id
          JOIN factory.substrate_source s ON s.workspace_id=a.workspace_id AND s.actor_uid=b.actor_uid
          WHERE a.workspace_id=NEW.workspace_id AND a.generation=previous_generation
            AND a.substrate AND a.state='stopped' AND b.deleted_at IS NOT NULL
            AND s.owner='service' AND s.writable AND s.checkpoint IS NOT NULL)))
      THEN RAISE EXCEPTION 'Native Workspace successor requires exact cleanup and independent Source'; END IF;
    IF NOT EXISTS(SELECT 1 FROM factory.development_workspace w WHERE w.id=NEW.workspace_id
      AND w.substrate
      AND (w.kind='personal' OR EXISTS (
        SELECT 1 FROM factory.change c JOIN factory.ticket t ON t.id=c.ticket_id
        JOIN factory.branch_create_operation b ON b.change_id=c.id
        WHERE c.id=w.change_id AND c.ticket_id=w.ticket_id AND c.project_id=w.project_id
          AND c.cancel_requested_at IS NULL AND c.state IN ('starting','active','failed')
          AND t.trashed_at IS NULL AND b.state='succeeded' AND b.observed_head_sha=c.base_sha
          AND w.source_revision=c.base_sha AND w.source_branch=c.branch_name))
      AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt a WHERE a.workspace_id=w.id AND a.generation>=NEW.generation))
      THEN RAISE EXCEPTION 'Native provisioning requires a fresh personal or approved Ticket Workspace'; END IF;
  ELSIF ROW(NEW.workspace_id,NEW.generation,NEW.intent) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.generation,OLD.intent)
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

CREATE FUNCTION factory.protect_workspace_runtime_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.substrate IS DISTINCT FROM OLD.substrate THEN
    RAISE EXCEPTION 'Workspace runtime identity is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION factory.require_substrate_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
        AND b.intent->>'preparationID'=p.preparation_id::text)
    OR EXISTS(SELECT 1 FROM factory.substrate_isolated p
      WHERE p.runtime_attempt_id=NEW.id AND p.project_id=NEW.project_id AND p.generation=NEW.generation
        AND NEW.workspace_id IS NULL AND NEW.change_id IS NULL AND NEW.verification_id IS NULL
        AND p.kind=NEW.isolated_kind::text AND p.intent->>'revision'=NEW.revision
        AND b.intent->>'isolatedID'=p.owner_id::text AND b.intent->>'isolatedKind'=p.kind)))
    THEN RAISE EXCEPTION 'Native Attempt requires its persisted matching owner binding'; END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION factory.protect_substrate_input_stop() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Native Stop intent and outcomes cannot be discarded'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.assignment->>'stopID' IS DISTINCT FROM NEW.stop_id::text
      OR NEW.assignment->>'attemptID' IS DISTINCT FROM NEW.runtime_attempt_id::text
      OR NEW.assignment->>'mode' IS DISTINCT FROM 'interrupt'
      OR NOT EXISTS(
        SELECT 1 FROM factory.runtime_attempt attempt
        JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=attempt.id
        JOIN factory.development_workspace workspace ON workspace.id=attempt.workspace_id
        JOIN factory.change change ON change.id=attempt.change_id AND change.runtime_attempt_id=attempt.id
        JOIN factory.change_agent_session session ON session.change_id=change.id
        JOIN factory.change_agent_turn_intent intent ON intent.turn_id=session.stop_turn_id
        JOIN factory.agent_turn turn ON turn.id=intent.turn_id
        JOIN factory.substrate_source source ON source.workspace_id=workspace.id
        WHERE attempt.id=NEW.runtime_attempt_id AND attempt.substrate AND workspace.substrate
          AND attempt.workspace_id=NEW.workspace_id AND attempt.change_id=NEW.change_id
          AND attempt.stop_intended_at IS NULL AND workspace.kind='ticket'
          AND binding.actor_uid=NEW.actor_uid AND binding.checkpoint=NEW.checkpoint
          AND binding.observation#>>'{status,state}'='ACTOR_STATE_SUSPENDED'
          AND binding.create_attempted_at IS NOT NULL AND NOT binding.create_rejected
          AND binding.delete_intended_at IS NULL AND binding.deleted_at IS NULL
          AND source.actor_uid=NEW.actor_uid AND source.owner='service' AND source.writable
          AND source.checkpoint IS NOT NULL AND source.service_base IS NOT NULL
          AND session.state='stopped' AND session.stop_pending AND session.stop_id=NEW.stop_id
          AND session.runtime_attempt_id=attempt.id AND session.opencode_session_id=NEW.assignment->>'sessionID'
          AND intent.runtime_attempt_id=attempt.id AND intent.session_id=session.opencode_session_id
          AND intent.prompt_id=NEW.assignment->>'promptID' AND turn.authority->>'modelId'=NEW.assignment->>'modelID'
          AND turn.state IN ('stopped','completed','failed')
          AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt newer
            WHERE newer.workspace_id=workspace.id AND newer.generation>attempt.generation))
      THEN RAISE EXCEPTION 'Native Stop requires the exact pending input and independent paused Source'; END IF;
  ELSIF ROW(NEW.stop_id,NEW.runtime_attempt_id,NEW.workspace_id,NEW.change_id,NEW.actor_uid,NEW.assignment,NEW.checkpoint,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.stop_id,OLD.runtime_attempt_id,OLD.workspace_id,OLD.change_id,OLD.actor_uid,OLD.assignment,OLD.checkpoint,OLD.created_at)
    OR (OLD.source_checkpoint_id IS NOT NULL AND ROW(NEW.source_checkpoint_id,NEW.source_writer_epoch)
      IS DISTINCT FROM ROW(OLD.source_checkpoint_id,OLD.source_writer_epoch))
    OR (OLD.resume_attempted_at IS NOT NULL AND NEW.resume_attempted_at IS DISTINCT FROM OLD.resume_attempted_at)
    OR (OLD.snapshot_attempted_at IS NOT NULL AND NEW.snapshot_attempted_at IS DISTINCT FROM OLD.snapshot_attempted_at)
    OR (OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result)
    OR (OLD.completed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD)
    THEN RAISE EXCEPTION 'Native Stop identity and dispatched outcomes are immutable'; END IF;
  IF NEW.result IS NOT NULL AND (
    NEW.result - ARRAY['mode','confirmed','engineExited','processTreeExited'] IS DISTINCT FROM NEW.assignment-'mode'
    OR COALESCE(NEW.result->>'mode' IN ('interrupt','observe'),false) IS NOT TRUE
    OR COALESCE(jsonb_typeof(NEW.result->'confirmed')='boolean',false) IS NOT TRUE
    OR NEW.result->'engineExited' IS DISTINCT FROM 'true'::jsonb
    OR NEW.result->'processTreeExited' IS DISTINCT FROM 'true'::jsonb)
    THEN RAISE EXCEPTION 'Native Stop requires its exact joined worker result'; END IF;
  IF NEW.completed_at IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM factory.runtime_attempt attempt
    JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=attempt.id
    JOIN factory.substrate_source source ON source.workspace_id=attempt.workspace_id
    WHERE attempt.id=NEW.runtime_attempt_id AND attempt.state='paused'
      AND attempt.stop_intended_at IS NULL AND binding.actor_uid=NEW.actor_uid
      AND binding.observation#>>'{status,state}'='ACTOR_STATE_SUSPENDED'
      AND (binding.checkpoint->>'generation')::bigint>(NEW.checkpoint->>'generation')::bigint
      AND binding.checkpoint->>'uuid' IS DISTINCT FROM NEW.checkpoint->>'uuid'
      AND NEW.completed_checkpoint=binding.checkpoint
      AND source.actor_uid=NEW.actor_uid AND source.owner='service' AND source.writable
      AND source.checkpoint->>'id'=NEW.completed_source_checkpoint_id::text AND source.service_base IS NOT NULL)
    THEN RAISE EXCEPTION 'Native Stop requires a new durable pause and independent Source'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION factory.protect_substrate_actor_rpc() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Native lifecycle dispatch facts cannot be discarded'; END IF;
  IF TG_OP='INSERT' AND NOT EXISTS(
    SELECT 1 FROM factory.runtime_attempt attempt
    JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=attempt.id
    WHERE attempt.id=NEW.runtime_attempt_id AND attempt.substrate AND binding.actor_uid=NEW.actor_uid
      AND binding.create_attempted_at IS NOT NULL AND NOT binding.create_rejected
      AND binding.delete_intended_at IS NULL AND binding.deleted_at IS NULL
      AND binding.observation#>>'{metadata,version}'=NEW.native_version
      AND NEW.origin_key=COALESCE(binding.checkpoint->>'uuid','initial')
      AND NEW.origin_checkpoint IS NOT DISTINCT FROM binding.checkpoint
      AND ((NEW.action='resume' AND binding.observation#>>'{status,state}'='ACTOR_STATE_SUSPENDED')
        OR (NEW.action='suspend' AND binding.observation#>>'{status,state}'='ACTOR_STATE_RUNNING'
          AND EXISTS(SELECT 1 FROM factory.substrate_actor_rpc resumed
            WHERE resumed.runtime_attempt_id=attempt.id AND resumed.action='resume'
              AND resumed.origin_key=NEW.origin_key AND resumed.actor_uid=NEW.actor_uid
              AND resumed.attempted_at IS NOT NULL AND resumed.outcome->>'state'='ACTOR_STATE_RUNNING')))
      AND (NEW.stop_id IS NULL OR EXISTS(
        SELECT 1 FROM factory.substrate_input_stop stopped
        JOIN factory.change_agent_session session ON session.change_id=stopped.change_id
        WHERE stopped.stop_id=NEW.stop_id AND stopped.runtime_attempt_id=attempt.id
          AND stopped.actor_uid=NEW.actor_uid AND session.stop_id=stopped.stop_id AND session.stop_pending)))
    THEN RAISE EXCEPTION 'Native lifecycle intent requires its exact original Actor and checkpoint'; END IF;
  IF TG_OP='UPDATE' AND (
    ROW(NEW.runtime_attempt_id,NEW.action,NEW.origin_key,NEW.actor_uid,NEW.native_version,NEW.origin_checkpoint,NEW.stop_id,NEW.intended_at)
      IS DISTINCT FROM ROW(OLD.runtime_attempt_id,OLD.action,OLD.origin_key,OLD.actor_uid,OLD.native_version,OLD.origin_checkpoint,OLD.stop_id,OLD.intended_at)
    OR (OLD.attempted_at IS NOT NULL AND NEW.attempted_at IS DISTINCT FROM OLD.attempted_at)
    OR (OLD.outcome IS NOT NULL AND NEW IS DISTINCT FROM OLD))
    THEN RAISE EXCEPTION 'Native lifecycle identities, dispatch and outcome facts are immutable'; END IF;
  IF NEW.outcome IS NOT NULL AND (
    NEW.outcome->>'actorUID' IS DISTINCT FROM NEW.actor_uid::text
    OR COALESCE(NEW.outcome->>'version','') !~ '^[1-9][0-9]*$'
    OR (NEW.outcome->>'version')::numeric<NEW.native_version::numeric
    OR NEW.outcome->>'state' IS DISTINCT FROM CASE WHEN NEW.action='resume' THEN 'ACTOR_STATE_RUNNING' ELSE 'ACTOR_STATE_SUSPENDED' END
    OR NOT EXISTS(SELECT 1 FROM factory.substrate_binding binding
      WHERE binding.runtime_attempt_id=NEW.runtime_attempt_id AND binding.actor_uid=NEW.actor_uid
        AND binding.observation#>>'{metadata,version}'=NEW.outcome->>'version'
        AND binding.observation#>>'{status,state}'=NEW.outcome->>'state'
        AND (NEW.action='resume' OR binding.checkpoint=NEW.outcome->'checkpoint')))
    THEN RAISE EXCEPTION 'Native lifecycle completion requires its independent original-Actor observation'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION factory.protect_substrate_capacity_installation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Native capacity installation identity is immutable';
  END IF;
  IF NEW.intent->>'database' IS DISTINCT FROM current_database()
    OR COALESCE(NEW.intent#>>'{base,uid}','')=''
    OR COALESCE(NEW.intent#>>'{node,uid}','')=''
    OR COALESCE(NEW.intent->>'sandboxUID','')=''
    THEN RAISE EXCEPTION 'Native capacity requires its observed installation identity'; END IF;
  RETURN NEW;
END $$;
