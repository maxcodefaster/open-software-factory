BEGIN;

-- Isolated generations belong to their deterministic product owner, not a
-- shared Project counter. Provisioning keys and binding checks enforce identity.
DROP INDEX factory.runtime_attempt_project_generation_uidx;

INSERT INTO factory.schema_migration(version) VALUES(28);
COMMIT;
