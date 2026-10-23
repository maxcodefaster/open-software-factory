BEGIN;
CREATE TABLE factory.monitoring_hook (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES factory.project(id),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  version bigint NOT NULL CHECK(version > 0),
  enabled boolean NOT NULL,
  secret_digest text NOT NULL CHECK(secret_digest ~ '^[a-f0-9]{64}$'),
  policy_id uuid NOT NULL,
  received_window timestamptz NOT NULL DEFAULT now(),
  received_count integer NOT NULL DEFAULT 0
);
CREATE TABLE factory.monitoring_policy (
  id uuid PRIMARY KEY,
  hook_id uuid NOT NULL REFERENCES factory.monitoring_hook(id),
  connection_id uuid NOT NULL REFERENCES factory.mcp_connection(id),
  assignment jsonb NOT NULL,
  delegated_by uuid NOT NULL REFERENCES auth."user"(id),
  delegated_at timestamptz NOT NULL DEFAULT now(),
  delegation text NOT NULL CHECK(delegation='application-fix-and-delivery')
);
ALTER TABLE factory.monitoring_hook ADD CONSTRAINT monitoring_current_policy
  FOREIGN KEY(policy_id) REFERENCES factory.monitoring_policy(id) DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER monitoring_policy_immutable BEFORE DELETE OR UPDATE ON factory.monitoring_policy
  FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();
CREATE TABLE factory.monitoring_command (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES factory.project(id),
  hook_id uuid NOT NULL REFERENCES factory.monitoring_hook(id),
  actor_id uuid NOT NULL REFERENCES auth."user"(id),
  input_digest text NOT NULL,
  action text NOT NULL CHECK(action IN ('save','disable','rotate')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER monitoring_command_immutable BEFORE DELETE OR UPDATE ON factory.monitoring_command
  FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();
CREATE TABLE factory.monitoring_incident (
  id uuid PRIMARY KEY,
  hook_id uuid NOT NULL REFERENCES factory.monitoring_hook(id),
  project_id uuid NOT NULL REFERENCES factory.project(id),
  policy_id uuid NOT NULL REFERENCES factory.monitoring_policy(id),
  hook_version bigint NOT NULL,
  fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
  payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
  title text NOT NULL,
  reference text,
  context text NOT NULL CHECK(octet_length(context) <= 64000),
  occurrences bigint NOT NULL DEFAULT 1 CHECK(occurrences > 0),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN (
    'queued','diagnosing','insufficient-context','not-application-defect',
    'implementing','delivered','blocked','uncertain')),
  reason text,
  diagnosis jsonb,
  model_id text,
  model_connection jsonb,
  owner_token uuid,
  owner_expires_at timestamptz,
  ticket_id uuid REFERENCES factory.ticket(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  settled_at timestamptz,
  UNIQUE(hook_id,fingerprint)
);
CREATE INDEX monitoring_pending ON factory.monitoring_incident(project_id,received_at,id)
  WHERE state IN ('queued','diagnosing','implementing');
CREATE UNIQUE INDEX monitoring_ticket ON factory.monitoring_incident(ticket_id) WHERE ticket_id IS NOT NULL;
CREATE TABLE factory.monitoring_evidence (
  id uuid PRIMARY KEY,
  incident_id uuid NOT NULL REFERENCES factory.monitoring_incident(id),
  kind text NOT NULL,
  digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  path text,
  commit_sha text,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER monitoring_evidence_immutable BEFORE DELETE OR UPDATE ON factory.monitoring_evidence
  FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();
ALTER TABLE factory.requirement_approval
  ADD COLUMN monitoring_incident_id uuid REFERENCES factory.monitoring_incident(id),
  ADD COLUMN monitoring_policy_id uuid REFERENCES factory.monitoring_policy(id),
  ADD CONSTRAINT requirement_monitoring_basis CHECK(
    (monitoring_incident_id IS NULL)=(monitoring_policy_id IS NULL));
ALTER TABLE factory.delivery_approval
  ADD COLUMN monitoring_incident_id uuid REFERENCES factory.monitoring_incident(id),
  ADD COLUMN monitoring_policy_id uuid REFERENCES factory.monitoring_policy(id),
  ADD CONSTRAINT delivery_monitoring_basis CHECK(
    (monitoring_incident_id IS NULL)=(monitoring_policy_id IS NULL));
INSERT INTO factory.schema_migration(version) VALUES(12);
COMMIT;
