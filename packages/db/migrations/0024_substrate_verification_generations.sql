BEGIN;

-- Preserve every native provisioning identity across the existing explicit
-- queued-bootstrap retry decision. No prior row is replaced or made mutable.
ALTER TABLE factory.substrate_verification DROP CONSTRAINT substrate_verification_pkey;
ALTER TABLE factory.substrate_verification ADD PRIMARY KEY(runtime_attempt_id);
ALTER TABLE factory.substrate_verification ADD UNIQUE(verification_id,generation);

CREATE OR REPLACE FUNCTION factory.protect_substrate_verification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE raw bytea;
  predecessor factory.substrate_verification;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Native Verification provisioning names cannot be reused'; END IF;
  IF TG_OP='INSERT' THEN
    raw:=digest(NEW.verification_id::text||':'||NEW.generation::text,'sha256');
    raw:=set_byte(raw,6,(get_byte(raw,6)&15)|80);
    raw:=set_byte(raw,8,(get_byte(raw,8)&63)|128);
    SELECT * INTO predecessor FROM factory.substrate_verification
      WHERE verification_id=NEW.verification_id ORDER BY generation DESC LIMIT 1;
    IF (predecessor.runtime_attempt_id IS NULL AND NEW.generation<>1)
      OR (predecessor.runtime_attempt_id IS NOT NULL AND (
        NEW.generation<>predecessor.generation+1 OR NOT EXISTS(
          SELECT 1 FROM factory.runtime_attempt a JOIN factory.substrate_binding b ON b.runtime_attempt_id=a.id
          JOIN factory.verification v ON v.id=NEW.verification_id
          JOIN factory.execution_policy_command decision ON decision.scope='checks-bootstrap-retry:'||v.change_id::text
          WHERE a.id=predecessor.runtime_attempt_id AND a.verification_id=v.id AND a.substrate
            AND a.state='stopped' AND b.deleted_at IS NOT NULL
            AND decision.input->>'verificationID'=v.id::text
            AND decision.input->>'runtimeAttemptID'=a.id::text
            AND decision.result->>'runtimeAttemptID'=a.id::text
            AND decision.result->>'state'='failed')))
      THEN RAISE EXCEPTION 'Native Verification successor requires exact cleanup and an explicit bootstrap retry decision'; END IF;
    IF NEW.runtime_attempt_id<>encode(substring(raw from 1 for 16),'hex')::uuid
      OR NOT EXISTS(SELECT 1 FROM factory.verification v JOIN factory.change c ON c.id=v.change_id
        JOIN factory.ticket t ON t.id=c.ticket_id
        WHERE v.id=NEW.verification_id AND v.runtime_attempt_id IS NULL
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
  ELSIF ROW(NEW.verification_id,NEW.runtime_attempt_id,NEW.generation,NEW.intent)
      IS DISTINCT FROM ROW(OLD.verification_id,OLD.runtime_attempt_id,OLD.generation,OLD.intent)
    OR (OLD.atespace_attempted_at IS NOT NULL AND NEW.atespace_attempted_at IS DISTINCT FROM OLD.atespace_attempted_at)
    OR (OLD.policy_attempted_at IS NOT NULL AND NEW.policy_attempted_at IS DISTINCT FROM OLD.policy_attempted_at)
    OR (OLD.template_attempted_at IS NOT NULL AND NEW.template_attempted_at IS DISTINCT FROM OLD.template_attempted_at)
    OR (OLD.atespace IS NOT NULL AND NEW.atespace IS DISTINCT FROM OLD.atespace)
    OR (OLD.policy IS NOT NULL AND NEW.policy IS DISTINCT FROM OLD.policy)
    OR (OLD.template IS NOT NULL AND NEW.template IS DISTINCT FROM OLD.template)
    OR (OLD.atespace_rejected AND NOT NEW.atespace_rejected)
    OR (OLD.policy_rejected AND NOT NEW.policy_rejected)
    OR (OLD.template_rejected AND NOT NEW.template_rejected)
    THEN RAISE EXCEPTION 'Native Verification provisioning identity and dispatch facts are immutable';
  END IF;
  RETURN NEW;
END $$;

INSERT INTO factory.schema_migration(version) VALUES(24);
COMMIT;
