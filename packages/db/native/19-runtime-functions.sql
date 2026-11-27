-- Runtime routines. Run before Drizzle tables, with check_function_bodies disabled.

CREATE FUNCTION factory.protect_runtime_attempt_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.atespace IS NOT NULL THEN RAISE EXCEPTION 'Native names and bindings cannot be reused'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW.project_id,NEW.change_id,NEW.workspace_id,NEW.generation,NEW.revision,
        NEW.isolated_kind,NEW.verification_id,NEW.parent_connector_token_hash,
        NEW.create_intended_at,NEW.created_by,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.project_id,OLD.change_id,OLD.workspace_id,OLD.generation,OLD.revision,
        OLD.isolated_kind,OLD.verification_id,OLD.parent_connector_token_hash,
        OLD.create_intended_at,OLD.created_by,OLD.created_at)
      OR (OLD.declared_apps<>'[]'::jsonb AND NEW.declared_apps IS DISTINCT FROM OLD.declared_apps)
       THEN RAISE EXCEPTION 'Runtime Attempt identity and create intent are immutable'; END IF;
    IF (OLD.stop_intended_at IS NOT NULL AND NEW.stop_intended_at IS DISTINCT FROM OLD.stop_intended_at)
      OR (NEW.stop_intended_at IS NOT NULL AND NEW.state NOT IN ('stopping','stopped')) THEN
      RAISE EXCEPTION 'Final Stop intent cannot be cleared or reopen execution';
    END IF;
  END IF;
  IF (TG_OP='INSERT' AND NEW.atespace IS NOT NULL)
    OR (TG_OP='UPDATE' AND OLD.atespace IS NULL AND NEW.atespace IS NOT NULL) THEN
    IF NOT (NEW.state='create-intended' AND NEW.stop_intended_at IS NULL
      AND (EXISTS(SELECT 1 FROM factory.development_workspace w WHERE w.id=NEW.workspace_id)
        OR EXISTS(SELECT 1 FROM factory.substrate_provision p WHERE p.kind='verification'
          AND p.owner_id=NEW.verification_id
          AND p.runtime_attempt_id=NEW.id AND p.generation=NEW.generation AND NEW.isolated_kind='verification'
          AND NEW.workspace_id IS NULL AND NEW.change_id IS NULL
          AND jsonb_typeof(p.resources->'atespace'->'value')='object'
          AND jsonb_typeof(p.resources->'policy'->'value')='object'
          AND jsonb_typeof(p.resources->'template'->'value')='object'
          AND NEW.binding_intent->>'projectID'=NEW.project_id::text
          AND NEW.binding_intent->>'generation'=NEW.generation::text
          AND NEW.binding_intent->>'verificationID'=p.owner_id::text
          AND NEW.binding_intent->>'atespaceUID'=p.resources#>>'{atespace,value,metadata,uid}'
          AND NEW.binding_intent->>'templateUID'=p.resources#>>'{template,value,metadata,uid}'
          AND NEW.binding_intent->>'templateVersion'=p.resources#>>'{template,value,metadata,version}'
          AND NEW.binding_intent->>'templateSHA256'=p.intent->>'templateSHA256')
        OR EXISTS(SELECT 1 FROM factory.substrate_provision p
          WHERE p.kind IN ('staging','publication')
            AND p.runtime_attempt_id=NEW.id AND p.project_id=NEW.project_id AND p.generation=NEW.generation
            AND p.kind=NEW.isolated_kind::text AND NEW.workspace_id IS NULL AND NEW.change_id IS NULL AND NEW.verification_id IS NULL
            AND p.intent->>'revision'=NEW.revision AND p.intent->>'createdBy'=NEW.created_by::text
            AND jsonb_typeof(p.resources->'atespace'->'value')='object'
            AND jsonb_typeof(p.resources->'policy'->'value')='object'
            AND jsonb_typeof(p.resources->'template'->'value')='object'
            AND NOT COALESCE((p.resources#>>'{atespace,rejected}')::boolean,false)
            AND NOT COALESCE((p.resources#>>'{policy,rejected}')::boolean,false)
            AND NOT COALESCE((p.resources#>>'{template,rejected}')::boolean,false)
            AND NEW.binding_intent->>'projectID'=NEW.project_id::text AND NEW.binding_intent->>'generation'=NEW.generation::text
            AND NEW.binding_intent->>'isolatedID'=p.owner_id::text AND NEW.binding_intent->>'isolatedKind'=p.kind
            AND (NEW.binding_intent->>'promotionID') IS NOT DISTINCT FROM p.intent->>'promotionID'
            AND NEW.binding_intent->>'atespaceUID'=p.resources#>>'{atespace,value,metadata,uid}'
            AND NEW.binding_intent->>'templateUID'=p.resources#>>'{template,value,metadata,uid}'
            AND NEW.binding_intent->>'templateVersion'=p.resources#>>'{template,value,metadata,version}'
            AND NEW.binding_intent->>'templateSHA256'=p.intent->>'templateSHA256'
            AND NEW.binding_intent->'environment'=p.intent->'environment'))
      AND NEW.atespace='fa-'||replace(NEW.id::text,'-','')
      AND NEW.actor_name='runtime-'||replace(NEW.id::text,'-',''))
      THEN RAISE EXCEPTION 'Native binding requires deterministic active Attempt intent'; END IF;
  ELSIF TG_OP='UPDATE' AND OLD.atespace IS NOT NULL AND (
    ROW(NEW.atespace,NEW.actor_name,NEW.binding_intent)
      IS DISTINCT FROM ROW(OLD.atespace,OLD.actor_name,OLD.binding_intent)
    OR (OLD.actor_uid IS NOT NULL AND NEW.actor_uid IS DISTINCT FROM OLD.actor_uid)
    OR (OLD.create_attempted_at IS NOT NULL AND NEW.create_attempted_at IS DISTINCT FROM OLD.create_attempted_at)
    OR (OLD.create_rejected AND NOT NEW.create_rejected)
    OR (OLD.delete_intended_at IS NOT NULL AND NEW.delete_intended_at IS DISTINCT FROM OLD.delete_intended_at)
    OR (OLD.deleted_at IS NOT NULL AND ROW(NEW.atespace,NEW.actor_name,NEW.binding_intent,NEW.actor_uid,
        NEW.create_attempted_at,NEW.create_rejected,NEW.delete_intended_at,NEW.deleted_at,
        NEW.observation,NEW.checkpoint)
      IS DISTINCT FROM ROW(OLD.atespace,OLD.actor_name,OLD.binding_intent,OLD.actor_uid,
        OLD.create_attempted_at,OLD.create_rejected,OLD.delete_intended_at,OLD.deleted_at,
        OLD.observation,OLD.checkpoint)))
    THEN RAISE EXCEPTION 'Native binding identity and dispatch facts are immutable'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION factory.protect_substrate_source() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Source ownership and checkpoints cannot be discarded'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.writer_epoch<>1 OR NOT NEW.writable OR NEW.generation<>0 OR NEW.seed_confirmed_at IS NOT NULL
      THEN RAISE EXCEPTION 'Source requires an initial writable generation'; END IF;
    IF NEW.owner='service' THEN
      IF NEW.actor_uid IS NOT NULL OR NEW.seed IS NULL
        OR NEW.service_base::text IS DISTINCT FROM NEW.seed->>'id'
        OR NOT EXISTS(SELECT 1 FROM factory.development_workspace w JOIN factory.project p ON p.id=w.project_id
          WHERE w.id=NEW.workspace_id AND w.id::text=NEW.seed->>'workspaceID'
            AND w.project_id::text=NEW.seed->>'projectID'
            AND p.repository_url=NEW.seed->>'repositoryURL'
            AND w.source_branch=NEW.seed->>'branch' AND w.source_revision=NEW.seed->>'revision')
        OR EXISTS(SELECT 1 FROM factory.runtime_attempt a WHERE a.workspace_id=NEW.workspace_id)
        THEN RAISE EXCEPTION 'Initial service Source requires its exact Workspace seed before any Attempt'; END IF;
    ELSIF NEW.owner<>'actor' OR NEW.seed IS NOT NULL
      OR NOT EXISTS(SELECT 1 FROM factory.runtime_attempt a
        WHERE a.workspace_id=NEW.workspace_id AND a.actor_uid=NEW.actor_uid
          AND a.delete_intended_at IS NULL AND a.deleted_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt n WHERE n.workspace_id=a.workspace_id AND n.generation>a.generation))
      THEN RAISE EXCEPTION 'Source requires its current original Actor binding'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.seed IS DISTINCT FROM OLD.seed
    THEN RAISE EXCEPTION 'Source seed is immutable'; END IF;
  IF OLD.seed_confirmed_at IS NOT NULL AND NEW.seed_confirmed_at IS DISTINCT FROM OLD.seed_confirmed_at
    THEN RAISE EXCEPTION 'Source seed confirmation is immutable'; END IF;
  IF OLD.seed_confirmed_at IS NULL AND NEW.seed_confirmed_at IS NOT NULL AND (
    OLD.seed IS NULL OR OLD.actor_uid IS NOT NULL OR OLD.owner<>'service'
    OR OLD.service_base::text IS DISTINCT FROM OLD.seed->>'id'
    OR ROW(NEW.actor_uid,NEW.owner,NEW.writer_epoch,NEW.writable,NEW.generation,
        NEW.checkpoint_id,NEW.checkpoint,NEW.service_base)
      IS DISTINCT FROM ROW(OLD.actor_uid,OLD.owner,OLD.writer_epoch,OLD.writable,OLD.generation,
        OLD.checkpoint_id,OLD.checkpoint,OLD.service_base))
    THEN RAISE EXCEPTION 'Source seed confirmation requires its unchanged initialized service owner'; END IF;
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.writer_epoch<OLD.writer_epoch OR NEW.writer_epoch>OLD.writer_epoch+1
    OR NEW.generation<OLD.generation OR NEW.generation>OLD.generation+1
    THEN RAISE EXCEPTION 'Source identity/epoch/generation changed'; END IF;
  IF NEW.actor_uid IS DISTINCT FROM OLD.actor_uid THEN
    IF OLD.owner<>'service' OR NEW.owner<>'actor' OR OLD.writable OR NOT NEW.writable
      THEN RAISE EXCEPTION 'Source Actor transfer requires its confirmed stopped predecessor and current native successor'; END IF;
    IF OLD.actor_uid IS NULL THEN
      IF NEW.actor_uid IS NULL OR OLD.seed IS NULL OR OLD.seed_confirmed_at IS NULL
        OR OLD.service_base::text IS DISTINCT FROM OLD.seed->>'id'
        OR NOT EXISTS(
          SELECT 1 FROM factory.runtime_attempt current
          JOIN factory.substrate_provision provision ON provision.owner_id=current.workspace_id
            AND provision.kind='workspace' AND provision.generation=current.generation
          WHERE current.workspace_id=NEW.workspace_id
            AND current.project_id::text=OLD.seed->>'projectID' AND current.revision=OLD.seed->>'revision'
            AND (current.state='create-intended' OR (current.state='starting'
              AND current.binding_intent->>'sourceRestoreProtocol'='2'))
            AND current.stop_intended_at IS NULL
            AND current.actor_uid=NEW.actor_uid AND NOT current.create_rejected
            AND current.create_attempted_at IS NOT NULL
            AND current.delete_intended_at IS NULL AND current.deleted_at IS NULL
            AND current.observation#>>'{metadata,uid}'=NEW.actor_uid::text
            AND current.observation#>>'{metadata,name}'=current.actor_name
            AND current.observation#>>'{metadata,atespace}'=current.atespace
            AND current.binding_intent->>'projectID'=current.project_id::text
            AND current.binding_intent->>'workspaceID'=NEW.workspace_id::text
            AND current.binding_intent->>'generation'=current.generation::text
            AND current.binding_intent->>'atespaceUID'=provision.resources#>>'{atespace,value,metadata,uid}'
            AND current.binding_intent->>'templateUID'=provision.resources#>>'{template,value,metadata,uid}'
            AND current.binding_intent->>'templateVersion'=provision.resources#>>'{template,value,metadata,version}'
            AND current.binding_intent->>'templateSHA256'=provision.intent->>'templateSHA256'
            AND jsonb_typeof(provision.resources->'atespace'->'value')='object'
            AND jsonb_typeof(provision.resources->'policy'->'value')='object'
            AND jsonb_typeof(provision.resources->'template'->'value')='object'
            AND NOT COALESCE((provision.resources#>>'{atespace,rejected}')::boolean,false)
            AND NOT COALESCE((provision.resources#>>'{policy,rejected}')::boolean,false)
            AND NOT COALESCE((provision.resources#>>'{template,rejected}')::boolean,false)
            AND provision.intent->>'revision'=OLD.seed->>'revision'
            AND provision.intent->>'branch'=OLD.seed->>'branch'
            AND provision.intent->>'repositoryURL'=OLD.seed->>'repositoryURL'
            AND NOT EXISTS(
              SELECT 1 FROM factory.runtime_attempt other
              WHERE other.workspace_id=current.workspace_id AND other.id<>current.id
                AND (other.generation<current.generation AND other.state='stopped'
                  AND other.deleted_at IS NOT NULL AND other.binding_intent->>'sourceRestoreProtocol'='2') IS NOT TRUE))
        THEN RAISE EXCEPTION 'Source first Actor transfer requires its confirmed seed and exact generation-one native binding'; END IF;
    ELSIF NOT EXISTS(
        SELECT 1 FROM factory.runtime_attempt predecessor
        JOIN factory.runtime_attempt current ON current.workspace_id=predecessor.workspace_id
          AND current.generation>predecessor.generation
        JOIN factory.substrate_provision provision ON provision.owner_id=current.workspace_id
          AND provision.kind='workspace' AND provision.generation=current.generation
        WHERE predecessor.workspace_id=NEW.workspace_id AND predecessor.state='stopped'
          AND predecessor.actor_uid=OLD.actor_uid AND predecessor.deleted_at IS NOT NULL
          AND (current.state='create-intended' OR (current.state='starting'
            AND current.binding_intent->>'sourceRestoreProtocol'='2'))
          AND current.stop_intended_at IS NULL
          AND current.actor_uid=NEW.actor_uid AND NOT current.create_rejected
          AND current.create_attempted_at IS NOT NULL
          AND current.delete_intended_at IS NULL AND current.deleted_at IS NULL
          AND current.binding_intent->>'workspaceID'=NEW.workspace_id::text
          AND current.binding_intent->>'generation'=current.generation::text
          AND current.binding_intent->>'atespaceUID'=provision.resources#>>'{atespace,value,metadata,uid}'
          AND current.binding_intent->>'templateUID'=provision.resources#>>'{template,value,metadata,uid}'
          AND current.binding_intent->>'templateVersion'=provision.resources#>>'{template,value,metadata,version}'
          AND current.binding_intent->>'templateSHA256'=provision.intent->>'templateSHA256'
          AND NOT EXISTS(
            SELECT 1 FROM factory.runtime_attempt skipped
            WHERE skipped.workspace_id=current.workspace_id
              AND skipped.generation>predecessor.generation AND skipped.generation<current.generation
              AND (skipped.state='stopped' AND skipped.deleted_at IS NOT NULL
                AND skipped.binding_intent->>'sourceRestoreProtocol'='2') IS NOT TRUE)
          AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt newer WHERE newer.workspace_id=current.workspace_id AND newer.generation>current.generation))
      THEN RAISE EXCEPTION 'Source Actor transfer requires its confirmed stopped predecessor and current native successor'; END IF;
  END IF;
  IF NEW.generation<>OLD.generation THEN
    IF NEW.writable OR NEW.owner<>OLD.owner OR NEW.writer_epoch<>OLD.writer_epoch
      OR NEW.checkpoint_id IS DISTINCT FROM OLD.checkpoint_id
      OR NEW.checkpoint->>'id' IS DISTINCT FROM NEW.checkpoint_id::text
      OR NEW.checkpoint->>'workspaceID' IS DISTINCT FROM NEW.workspace_id::text
      OR NEW.checkpoint->>'actorUID' IS DISTINCT FROM NEW.actor_uid::text
      OR (NEW.actor_uid IS NULL AND (
        NEW.seed_confirmed_at IS NULL
        OR NEW.checkpoint->'actorUID' IS DISTINCT FROM 'null'::jsonb
        OR NEW.checkpoint->'seedID' IS DISTINCT FROM NEW.seed->'id'))
      OR (NEW.actor_uid IS NOT NULL AND NEW.checkpoint ? 'seedID')
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
    IF NEW.actor_uid=OLD.actor_uid AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt a
      WHERE a.workspace_id=NEW.workspace_id AND a.actor_uid=NEW.actor_uid
        AND a.checkpoint->>'actorUID'=NEW.actor_uid::text
        AND a.checkpoint->>'fidelity' IN ('SNAPSHOT_FIDELITY_ROOTFS','SNAPSHOT_FIDELITY_MEMORY')
        AND a.checkpoint#>>'{durableSnapshot,state}'='SNAPSHOT_STORAGE_STATE_COMPLETED'
        AND ((a.state='paused' AND a.observation#>>'{status,state}'='ACTOR_STATE_SUSPENDED'
          AND a.checkpoint->>'generation'=a.observation#>>'{status,lastAssignedGeneration}')
          OR (NEW.owner='actor' AND a.state='starting' AND a.stop_intended_at IS NULL
            AND a.binding_intent->>'sourceRestoreProtocol'='2' AND EXISTS(
              SELECT 1 FROM factory.operation resumed
              WHERE resumed.kind='runtime.actor_rpc' AND resumed.scope_type='runtime_attempt'
                AND resumed.scope_id=a.id::text AND (resumed.payload->>'actorUid')::uuid=NEW.actor_uid
                AND resumed.payload->>'action'='resume'
                AND NULLIF(resumed.payload->'originCheckpoint','null'::jsonb) IS NOT DISTINCT FROM a.checkpoint
                AND (resumed.payload->>'attemptedAt') IS NOT NULL))))
      AND NOT (NEW.owner='service' AND EXISTS(
        SELECT 1 FROM factory.runtime_attempt a
        WHERE a.workspace_id=NEW.workspace_id AND a.state='stopping' AND a.stop_intended_at IS NOT NULL
          AND a.actor_uid=NEW.actor_uid AND a.create_attempted_at IS NOT NULL AND NOT a.create_rejected
          AND a.delete_intended_at IS NULL AND a.deleted_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt newer
            WHERE newer.workspace_id=a.workspace_id AND newer.generation>a.generation)))
      THEN RAISE EXCEPTION 'Source transfer requires original durable paused ROOTFS or final Stop intent'; END IF;
  ELSIF NEW.writable IS DISTINCT FROM OLD.writable THEN
    IF OLD.owner='service' AND NOT OLD.writable AND NEW.writable
      AND NEW.writer_epoch=OLD.writer_epoch+1 AND NEW.checkpoint_id IS NULL
      AND EXISTS(
        SELECT 1 FROM factory.runtime_attempt a
        WHERE a.workspace_id=NEW.workspace_id AND a.state='stopping' AND a.stop_intended_at IS NOT NULL
          AND a.binding_intent->>'sourceRestoreProtocol'='2' AND a.actor_uid IS NOT NULL
          AND a.create_attempted_at IS NOT NULL AND NOT a.create_rejected AND a.deleted_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt newer
            WHERE newer.workspace_id=a.workspace_id AND newer.generation>a.generation))
      THEN NULL; -- No v2 writer grant was committed; retain the same saved service tree.
    ELSIF NOT OLD.writable OR NEW.writable OR NEW.writer_epoch<>OLD.writer_epoch+1 OR NEW.checkpoint_id IS NULL
      THEN RAISE EXCEPTION 'Source freeze must advance the writer epoch'; END IF;
  ELSIF ROW(NEW.writer_epoch,NEW.checkpoint_id,NEW.service_base) IS DISTINCT FROM ROW(OLD.writer_epoch,OLD.checkpoint_id,OLD.service_base) THEN
    RAISE EXCEPTION 'Source lease facts cannot change outside freeze/transfer';
  END IF;
  IF NEW.owner=OLD.owner AND NEW.service_base IS DISTINCT FROM OLD.service_base THEN
    RAISE EXCEPTION 'Source service base is immutable for its ownership interval'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION factory.protect_substrate_provision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  previous_generation bigint;
  previous_provision factory.substrate_provision;
  k text;
  old_r jsonb;
  new_r jsonb;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Native provisioning names cannot be reused'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.kind='workspace' THEN
      SELECT max(generation) INTO previous_generation FROM factory.substrate_provision
        WHERE owner_id=NEW.owner_id AND kind='workspace';
      IF (previous_generation IS NULL AND NEW.generation<>1)
        OR (previous_generation IS NOT NULL AND (
          NEW.generation<>previous_generation+1 OR NOT EXISTS(
            SELECT 1 FROM factory.runtime_attempt a
            JOIN factory.substrate_source s ON s.workspace_id=a.workspace_id
            WHERE a.workspace_id=NEW.owner_id AND a.generation=previous_generation
              AND a.state='stopped' AND a.deleted_at IS NOT NULL
              AND s.owner='service' AND s.writable AND s.service_base IS NOT NULL
              AND ((s.actor_uid=a.actor_uid AND s.checkpoint IS NOT NULL)
                OR (a.binding_intent->>'sourceRestoreProtocol'='2'
                  AND (s.checkpoint IS NOT NULL OR s.seed_confirmed_at IS NOT NULL))))))
        THEN RAISE EXCEPTION 'Native Workspace successor requires exact cleanup and independent Source'; END IF;
      IF NOT EXISTS(SELECT 1 FROM factory.development_workspace w WHERE w.id=NEW.owner_id
        AND (w.kind='personal' OR EXISTS (
          SELECT 1 FROM factory.change c JOIN factory.ticket t ON t.id=c.ticket_id
          JOIN factory.operation b ON b.kind='delivery.branch_create' AND b.scope_type='change' AND b.scope_id=c.id::text
          WHERE c.id=w.change_id AND c.ticket_id=w.ticket_id AND c.project_id=w.project_id
            AND c.cancel_requested_at IS NULL AND c.state IN ('starting','active','failed')
            AND t.trashed_at IS NULL AND b.state='succeeded' AND b.result->>'observedHeadSha'=c.base_sha
            AND w.source_revision=c.base_sha AND w.source_branch=c.branch_name))
        AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt a WHERE a.workspace_id=w.id AND a.generation>=NEW.generation))
        THEN RAISE EXCEPTION 'Native provisioning requires a fresh personal or approved Ticket Workspace'; END IF;
    ELSIF NEW.kind='verification' THEN
      SELECT * INTO previous_provision FROM factory.substrate_provision
        WHERE owner_id=NEW.owner_id AND kind='verification' ORDER BY generation DESC LIMIT 1;
      IF (previous_provision.runtime_attempt_id IS NULL AND NEW.generation<>1)
        OR (previous_provision.runtime_attempt_id IS NOT NULL AND (
          NEW.generation<>previous_provision.generation+1 OR NOT EXISTS(
            SELECT 1 FROM factory.runtime_attempt a
            JOIN factory.verification v ON v.id=NEW.owner_id
            JOIN factory.audit_event decision ON decision.kind='usage.policy_command'
              AND decision.scope_type='execution_policy'
              AND decision.scope_id='checks-bootstrap-retry:'||v.change_id::text
            WHERE a.id=previous_provision.runtime_attempt_id AND a.verification_id=v.id
              AND a.state='stopped' AND a.deleted_at IS NOT NULL
              AND decision.payload->'input'->>'verificationID'=v.id::text
              AND decision.payload->'input'->>'runtimeAttemptID'=a.id::text
              AND decision.payload->'result'->>'runtimeAttemptID'=a.id::text
              AND decision.payload->'result'->>'state'='failed')))
        THEN RAISE EXCEPTION 'Native Verification successor requires exact cleanup and an explicit bootstrap retry decision'; END IF;
      IF NEW.runtime_attempt_id<>factory.deterministic_uuid(NEW.owner_id::text||':'||NEW.generation::text)
        OR NOT EXISTS(SELECT 1 FROM factory.verification v JOIN factory.change c ON c.id=v.change_id
          JOIN factory.ticket t ON t.id=c.ticket_id
          WHERE v.id=NEW.owner_id AND v.runtime_attempt_id IS NULL
            AND v.state='pending' AND v.action_run_id IS NOT NULL AND v.runner_uuid IS NOT NULL
            AND v.runner_token IS NOT NULL AND v.runner_job_handle IS NOT NULL
            AND c.state='active' AND c.cancel_requested_at IS NULL AND t.trashed_at IS NULL
            AND NEW.intent#>>'{configuration,projectID}'=c.project_id::text
            AND NEW.intent#>>'{configuration,database}'=current_database()
            AND NEW.intent->>'revision'=v.commit_sha AND NEW.intent->>'jobHandle'=v.runner_job_handle
            AND NEW.intent->>'runnerUUID'=v.runner_uuid::text
            AND NOT EXISTS(SELECT 1 FROM factory.change_agent_session s WHERE s.change_id=c.id AND (s.state='stopped' OR s.stop_pending))
            AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt a WHERE a.id=NEW.runtime_attempt_id))
        THEN RAISE EXCEPTION 'Native Verification requires deterministic fresh exact-job intent'; END IF;
    ELSE
      IF NEW.runtime_attempt_id<>factory.deterministic_uuid(NEW.owner_id::text||':'||NEW.generation::text)
        OR (NEW.intent#>>'{configuration,projectID}') IS DISTINCT FROM NEW.project_id::text
        OR (NEW.intent#>>'{configuration,database}') IS DISTINCT FROM current_database()
        OR NOT EXISTS(SELECT 1 FROM factory.project project WHERE project.id=NEW.project_id
          AND project.repository_url=NEW.intent->>'repository'
          AND project.actor_template_path=NEW.intent->>'actorTemplatePath')
        OR NOT EXISTS(SELECT 1 FROM auth."user" principal WHERE principal.id::text=NEW.intent->>'createdBy'
          AND (EXISTS(SELECT 1 FROM factory.project_membership member WHERE member.user_id=principal.id AND member.project_id=NEW.project_id)
            OR EXISTS(SELECT 1 FROM factory.administrator administrator WHERE administrator.user_id=principal.id)))
        OR EXISTS(SELECT 1 FROM factory.runtime_attempt WHERE id=NEW.runtime_attempt_id)
        THEN RAISE EXCEPTION 'Native isolated provisioning requires deterministic fresh product intent'; END IF;
      IF NEW.kind='publication' THEN
        IF NEW.intent->>'promotionID' IS NOT NULL OR NOT EXISTS(
          SELECT 1 FROM factory.operation publication JOIN factory.project_release release ON release.id=(publication.scope_id)::uuid
          WHERE publication.kind='releases.attempt' AND publication.scope_type='project_release'
            AND publication.id=NEW.owner_id AND release.project_id=NEW.project_id
            AND release.created_by::text=NEW.intent->>'createdBy' AND release.commit_sha=NEW.intent->>'revision'
            AND release.version=NEW.intent->>'version' AND publication.payload->>'jobHandle'=NEW.intent->>'jobHandle'
            AND publication.payload->>'runnerUuid'=NEW.intent->>'runnerUUID' AND publication.payload->>'runnerToken' IS NOT NULL
            AND publication.payload->>'runId' IS NOT NULL AND publication.payload->>'dispatchIntendedAt' IS NOT NULL
            AND publication.payload->>'runtimeAttemptId' IS NULL AND publication.state='running' AND release.state='running'
            AND publication.id=(SELECT id FROM factory.operation
              WHERE kind='releases.attempt' AND scope_type='project_release' AND scope_id=release.id::text
              ORDER BY (payload->>'ordinal')::int DESC LIMIT 1))
          OR (NEW.intent#>>'{environment,environment}') IS DISTINCT FROM 'development'
          OR (NEW.intent#>>'{environment,version}') IS DISTINCT FROM '0' OR NEW.intent#>>'{environment,secretKey}' IS NOT NULL
          THEN RAISE EXCEPTION 'Native publication requires its exact active job and empty Project environment'; END IF;
      ELSIF NEW.intent->>'promotionID' IS NOT NULL THEN
        IF NEW.owner_id::text<>NEW.intent->>'promotionID' OR NOT EXISTS(
          SELECT 1 FROM factory.operation promotion JOIN factory.change change ON change.id::text=promotion.payload->>'changeId'
          JOIN factory.ticket ticket ON ticket.id=change.ticket_id
          JOIN factory.operation merge ON merge.kind='delivery.merge' AND merge.scope_type='change'
            AND merge.scope_id=change.id::text AND merge.state='succeeded'
            AND merge.payload->>'commitSha'=promotion.payload->>'commitSha'
            AND merge.result->>'mergeSha'=merge.payload->>'commitSha'
          JOIN factory.delivery_approval approval ON approval.id::text=merge.payload->>'approvalId'
            AND approval.change_id=change.id AND approval.commit_sha=merge.payload->>'commitSha'
          JOIN factory.verification verification ON verification.id=approval.verification_id
            AND verification.change_id=change.id AND verification.commit_sha=merge.payload->>'commitSha' AND verification.state='succeeded'
          JOIN factory.candidate_review review ON review.id=approval.candidate_review_id AND review.verification_id=verification.id
            AND review.change_id=change.id AND review.commit_sha=merge.payload->>'commitSha' AND review.state='passed'
          WHERE promotion.id=NEW.owner_id AND promotion.kind='delivery.promotion' AND promotion.scope_type='change'
            AND promotion.scope_id=change.id::text
            AND promotion.payload->>'projectId'=NEW.project_id::text AND change.project_id=NEW.project_id
            AND promotion.payload->>'commitSha'=NEW.intent->>'revision' AND promotion.state='pending'
            AND (promotion.payload->>'replacementRuntimeAttemptId') IS NULL AND change.state='delivering'
            AND change.cancel_requested_at IS NULL AND ticket.trashed_at IS NULL
            AND EXISTS(SELECT 1 FROM factory.current_promotion WHERE id=promotion.id))
          THEN RAISE EXCEPTION 'Native Staging replacement requires its approved exact-commit promotion'; END IF;
      ELSE
        IF NEW.owner_id<>factory.deterministic_uuid('staging:'||NEW.project_id::text||':1') OR NOT EXISTS(
          SELECT 1 FROM factory.operation preview
          WHERE preview.kind='delivery.staging_preview' AND preview.scope_type='project'
            AND preview.scope_id=NEW.project_id::text
            AND preview.payload->>'revision'=NEW.intent->>'revision'
            AND (preview.payload->>'runtimeAttemptId' IS NULL
              OR EXISTS(SELECT 1 FROM factory.runtime_attempt predecessor
                WHERE predecessor.id::text=preview.payload->>'runtimeAttemptId'
                  AND predecessor.state='stopped' AND predecessor.deleted_at IS NOT NULL)))
          OR (NEW.generation>1 AND NOT EXISTS(
            SELECT 1 FROM factory.substrate_provision previous JOIN factory.runtime_attempt predecessor ON predecessor.id=previous.runtime_attempt_id
            WHERE previous.owner_id=NEW.owner_id AND previous.kind=NEW.kind AND previous.generation=NEW.generation-1
              AND predecessor.state='stopped' AND predecessor.deleted_at IS NOT NULL))
          THEN RAISE EXCEPTION 'Native initial Staging requires its pinned Preview and confirmed predecessor cleanup'; END IF;
      END IF;
      IF NEW.kind='staging' AND ((NEW.intent#>>'{environment,environment}') IS DISTINCT FROM 'main-preview'
        OR NOT EXISTS(SELECT 1 FROM factory.project project
          LEFT JOIN factory.operation environment ON environment.kind='environments.environment'
            AND environment.scope_type='project' AND environment.scope_id=project.id::text
            AND environment.idempotency_key='environments.environment:'||project.id::text||':main-preview'
          WHERE project.id=NEW.project_id AND NEW.intent#>>'{environment,version}'=COALESCE((environment.payload->>'version')::bigint,0)::text
            AND (NEW.intent#>>'{environment,secretKey}') IS NOT DISTINCT FROM (environment.payload->>'secretKey')))
        THEN RAISE EXCEPTION 'Native Staging requires its frozen main-preview environment'; END IF;
    END IF;
  ELSE
    IF ROW(NEW.owner_id,NEW.kind,NEW.generation,NEW.project_id,NEW.runtime_attempt_id,NEW.intent)
        IS DISTINCT FROM ROW(OLD.owner_id,OLD.kind,OLD.generation,OLD.project_id,OLD.runtime_attempt_id,OLD.intent) THEN
      RAISE EXCEPTION 'Native provisioning identity and dispatch facts are immutable';
    END IF;
    FOREACH k IN ARRAY ARRAY['atespace','policy','template'] LOOP
      old_r := COALESCE(OLD.resources->k,'{}'::jsonb);
      new_r := COALESCE(NEW.resources->k,'{}'::jsonb);
      IF (old_r->>'attemptedAt' IS NOT NULL AND new_r->>'attemptedAt' IS DISTINCT FROM old_r->>'attemptedAt')
        OR (NULLIF(old_r->'value','null'::jsonb) IS NOT NULL AND new_r->'value' IS DISTINCT FROM old_r->'value')
        OR (COALESCE((old_r->>'rejected')::boolean,false) AND NOT COALESCE((new_r->>'rejected')::boolean,false)) THEN
        RAISE EXCEPTION 'Native provisioning identity and dispatch facts are immutable';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
