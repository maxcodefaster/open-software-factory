-- Install after the Drizzle-owned auth and factory schemas, before types, routines and tables.
-- Compose functions before Drizzle tables/indexes/FKs, then native constraints/triggers/views/publication/seeds.
-- The composer owns BEGIN/COMMIT, search_path and the final schema_migration digest.

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA factory;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA factory;
