BEGIN;

CREATE OR REPLACE FUNCTION factory.protect_factorybox_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous factory.factorybox_worker_admission%ROWTYPE; operator_recovery boolean;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Worker admissions cannot be deleted'; END IF;
  IF TG_OP='INSERT' AND NEW.previous_id IS NOT NULL THEN
    SELECT * INTO previous FROM factory.factorybox_worker_admission
      WHERE id=NEW.previous_id AND worker_id=NEW.worker_id AND retired_at IS NOT NULL
        AND create_attempted AND pod_uid IS NOT NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'Recovery requires its retired original admission'; END IF;
    operator_recovery := coalesce(previous.retirement_observation->>'kind'='operator-recovery',false);
    IF operator_recovery THEN
      IF NEW.id::text IS DISTINCT FROM previous.retirement_observation->>'requestID'
        OR NEW.created_by::text IS DISTINCT FROM previous.retirement_observation->>'actorID'
        OR NEW.claim_uid IS DISTINCT FROM previous.claim_uid
        OR NEW.profile->'retainedStore'->>'storeID' IS DISTINCT FROM
          coalesce(previous.profile->'retainedStore'->>'storeID',previous.identity->>'storeID')
        OR NEW.profile->'retainedStore'->>'initializedByPodUID' IS DISTINCT FROM
          coalesce(previous.profile->'retainedStore'->>'initializedByPodUID',previous.pod_uid)
        OR NEW.profile->'retainedStore'->'boundedBytes' IS DISTINCT FROM
          coalesce(previous.profile->'retainedStore'->'boundedBytes',
            previous.identity->'boundedBytes',previous.profile->'boundedBytes')
        OR NEW.profile->'boundedBytes' IS DISTINCT FROM previous.profile->'boundedBytes'
        OR NEW.profile->'minimumBoundedBytes' IS DISTINCT FROM previous.profile->'minimumBoundedBytes'
        OR NEW.profile->'claimGiB' IS DISTINCT FROM previous.profile->'claimGiB'
        OR NEW.profile->'nodeName' IS DISTINCT FROM previous.profile->'nodeName'
        OR NEW.profile->'architecture' IS DISTINCT FROM previous.profile->'architecture'
        OR NEW.declaration->'claim' IS DISTINCT FROM previous.declaration->'claim'
        OR NEW.declaration->'namespace' IS DISTINCT FROM previous.declaration->'namespace'
        OR NEW.declaration#>>'{pod,metadata,name}' IS DISTINCT FROM
          factory.factorybox_admission_pod(NEW.worker_id,NEW.id)
        OR NEW.declaration IS NULL OR NEW.profile IS NULL OR NEW.claim_uid IS NULL
        OR NEW.create_attempted OR NEW.pod_uid IS NOT NULL OR NEW.identity IS NOT NULL
      THEN RAISE EXCEPTION 'Operator recovery must retain its exact store and new worker intent'; END IF;
    ELSIF previous.identity IS NOT NULL OR previous.profile ? 'retainedStore' THEN
      RAISE EXCEPTION 'Admitted stores require explicit operator recovery';
    END IF;
  END IF;
  IF NEW.profile ? 'retainedStore' AND (NEW.previous_id IS NULL OR NOT EXISTS(
    SELECT 1 FROM factory.factorybox_worker_admission parent WHERE parent.id=NEW.previous_id
      AND parent.worker_id=NEW.worker_id AND parent.retired_at IS NOT NULL
      AND parent.retirement_observation->>'kind'='operator-recovery'
      AND parent.retirement_observation->>'requestID'=NEW.id::text
  )) THEN RAISE EXCEPTION 'Retained stores require their explicit recovery receipt'; END IF;
  IF TG_OP='INSERT' THEN RETURN NEW; END IF;
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
  IF NEW.retired_at IS NOT NULL AND OLD.retired_at IS NULL THEN
    operator_recovery := coalesce(NEW.retirement_observation->>'kind'='operator-recovery',false);
    IF OLD.pod_uid IS NULL OR NOT OLD.create_attempted
      OR NEW.retirement_observation->>'podUID' IS DISTINCT FROM OLD.pod_uid
      OR coalesce(NEW.retirement_observation->>'phase' NOT IN ('Failed','Succeeded'),true)
      OR EXISTS(SELECT 1 FROM factory.runtime_attempt attempt
        WHERE attempt.factorybox_admission_id=OLD.id AND attempt.state NOT IN ('failed','stopped'))
      OR EXISTS(SELECT 1 FROM factory.execution_slot slot
        WHERE slot.factorybox_admission_id=OLD.id AND slot.state<>'deleted')
    THEN RAISE EXCEPTION 'Worker recovery requires confirmed terminal settled execution'; END IF;
    IF operator_recovery THEN
      IF (OLD.identity IS NULL AND NOT coalesce(OLD.profile ? 'retainedStore',false))
        OR OLD.claim_uid IS NULL OR OLD.declaration IS NULL
        OR NEW.retirement_observation->>'namespaceUID' IS DISTINCT FROM
          (SELECT namespace_uid FROM factory.factorybox_worker WHERE id=OLD.worker_id)
        OR NOT EXISTS(SELECT 1 FROM factory.administrator administrator
          JOIN factory.account_access account ON account.user_id=administrator.user_id
          WHERE administrator.user_id::text=NEW.retirement_observation->>'actorID'
            AND account.disabled_at IS NULL AND account.directory_disabled_at IS NULL)
        OR NOT coalesce(NEW.retirement_observation->>'requestID' ~
          '^[a-f0-9]{8}-([a-f0-9]{4}-){3}[a-f0-9]{12}$',false)
      THEN RAISE EXCEPTION 'Operator recovery requires its active System Manager and original store'; END IF;
    ELSIF OLD.identity IS NOT NULL OR OLD.profile ? 'retainedStore' OR EXISTS(
      SELECT 1 FROM factory.runtime_attempt attempt
      JOIN factory.factorybox_runtime runtime ON runtime.runtime_attempt_id=attempt.id
      WHERE attempt.factorybox_admission_id=OLD.id AND runtime.identity IS NOT NULL
    ) THEN RAISE EXCEPTION 'Bootstrap recovery requires confirmed terminal unused worker'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION factory.protect_factorybox_admission_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.factorybox_admission_id IS DISTINCT FROM OLD.factorybox_admission_id
    THEN RAISE EXCEPTION 'Execution admission is immutable'; END IF;
  IF TG_OP='INSERT' THEN
    -- Serialize fresh commissions against the predecessor's retirement. The
    -- recovery transaction locks this row before observing settled execution.
    PERFORM id FROM factory.factorybox_worker_admission admission
      WHERE admission.id=NEW.factorybox_admission_id AND admission.worker_id=NEW.factorybox_worker_id
        AND admission.retired_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Fresh execution requires its active worker admission'; END IF;
  END IF;
  IF TG_TABLE_NAME='execution_slot' THEN
    IF NOT EXISTS(SELECT 1 FROM factory.runtime_attempt staging
      WHERE staging.id=NEW.staging_attempt_id AND staging.factorybox_admission_id=NEW.factorybox_admission_id)
      OR (NEW.template_id IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM factory.execution_slot template WHERE template.id=NEW.template_id
          AND template.factorybox_admission_id=NEW.factorybox_admission_id))
    THEN RAISE EXCEPTION 'Execution pool must retain its original worker admission'; END IF;
  END IF;
  RETURN NEW;
END $$;

INSERT INTO factory.schema_migration(version) VALUES(4);
COMMIT;
