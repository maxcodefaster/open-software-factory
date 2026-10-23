BEGIN;
-- Retain webhook identities, keys, delegated work and immutable historical policies.
ALTER TABLE factory.monitoring_policy
  ALTER COLUMN connection_id DROP NOT NULL,
  ALTER COLUMN assignment DROP NOT NULL,
  ADD COLUMN instructions text CHECK(length(instructions) BETWEEN 1 AND 6000),
  ADD COLUMN source_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN source_assignments jsonb,
  DROP CONSTRAINT monitoring_policy_delegation_check,
  ADD CONSTRAINT monitoring_policy_delegation_check
    CHECK(delegation IN ('prepare-ticket','application-fix-and-delivery'));
ALTER TABLE factory.monitoring_incident
  ADD COLUMN skill_assignment jsonb,
  DROP CONSTRAINT monitoring_incident_state_check,
  ADD CONSTRAINT monitoring_incident_state_check CHECK(state IN (
    'queued','diagnosing','insufficient-context','not-application-defect',
    'prepared','implementing','delivered','blocked','uncertain'));
INSERT INTO factory.schema_migration(version) VALUES(14);
COMMIT;
