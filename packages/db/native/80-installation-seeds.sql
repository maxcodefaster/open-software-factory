-- Seed the two installation singletons after tables and native guards.
-- schema_migration registration belongs to the composer and its final source digest.

INSERT INTO factory.installation_maintenance(singleton) VALUES(true);

INSERT INTO factory.attachment_storage(singleton,id) VALUES(true,gen_random_uuid());
