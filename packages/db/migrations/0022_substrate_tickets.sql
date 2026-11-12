BEGIN;

-- Extend fresh native intent to the existing Ticket Workspace owner. Retained
-- engine/worker bindings and all prior migrations remain immutable.
ALTER TABLE factory.development_workspace DROP CONSTRAINT development_workspace_check1;
ALTER TABLE factory.development_workspace ADD CONSTRAINT development_workspace_runtime_kind CHECK (
  (substrate AND factorybox_worker_id IS NULL) OR (NOT substrate AND factorybox_worker_id IS NOT NULL)
);
ALTER TABLE factory.runtime_attempt DROP CONSTRAINT runtime_attempt_check;
ALTER TABLE factory.runtime_attempt ADD CONSTRAINT runtime_attempt_native_workspace CHECK (
  (substrate AND factorybox_worker_id IS NULL AND factorybox_admission_id IS NULL
    AND kubernetes_uid IS NULL AND kubernetes_namespace_uid IS NULL
    AND workspace_id IS NOT NULL AND isolated_kind IS NULL)
  OR (NOT substrate AND factorybox_worker_id IS NOT NULL AND factorybox_admission_id IS NOT NULL)
);

CREATE OR REPLACE FUNCTION factory.protect_substrate_workspace() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Native Workspace provisioning names cannot be reused'; END IF;
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM factory.development_workspace w WHERE w.id=NEW.workspace_id
      AND w.substrate
      AND (w.kind='personal' OR EXISTS (
        SELECT 1 FROM factory.change c JOIN factory.ticket t ON t.id=c.ticket_id
        JOIN factory.branch_create_operation b ON b.change_id=c.id
        WHERE c.id=w.change_id AND c.ticket_id=w.ticket_id AND c.project_id=w.project_id
          AND c.cancel_requested_at IS NULL AND c.state IN ('starting','active','failed')
          AND t.trashed_at IS NULL AND b.state='succeeded' AND b.observed_head_sha=c.base_sha
          AND w.source_revision=c.base_sha AND w.source_branch=c.branch_name))
      AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt a WHERE a.workspace_id=w.id)
      AND NOT EXISTS(SELECT 1 FROM factory.workspace_source s WHERE s.workspace_id=w.id))
      THEN RAISE EXCEPTION 'Native provisioning requires a fresh personal or approved Ticket Workspace'; END IF;
  ELSIF ROW(NEW.workspace_id,NEW.intent) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.intent)
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

CREATE OR REPLACE FUNCTION factory.require_substrate_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.substrate IS DISTINCT FROM OLD.substrate
    THEN RAISE EXCEPTION 'Runtime engine identity is immutable'; END IF;
  IF NEW.substrate AND NOT EXISTS(SELECT 1 FROM factory.substrate_binding b
    JOIN factory.development_workspace w ON w.id=NEW.workspace_id AND w.substrate
      AND w.project_id=NEW.project_id AND w.change_id IS NOT DISTINCT FROM NEW.change_id
    WHERE b.runtime_attempt_id=NEW.id)
    THEN RAISE EXCEPTION 'Native Attempt requires its persisted matching Workspace binding'; END IF;
  RETURN NULL;
END $$;

INSERT INTO factory.schema_migration(version) VALUES(22);
COMMIT;
