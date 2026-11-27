-- Seed the two installation singletons after tables and native guards.
-- schema_migration registration belongs to the composer and its final source digest.

INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload)
VALUES(gen_random_uuid(),'installation.maintenance','installation','00000000-0000-0000-0000-000000000000','installation.maintenance:singleton',NULL,'disabled','{"singleton":true,"enabled":false,"requestedAt":null}'::jsonb);

INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,state,payload)
VALUES(gen_random_uuid(),'attachment.storage','installation','00000000-0000-0000-0000-000000000000','attachment.storage:singleton','ready','{}'::jsonb);
