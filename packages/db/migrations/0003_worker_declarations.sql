BEGIN;

ALTER TABLE factory.factorybox_worker_admission ADD COLUMN declaration jsonb
  CHECK (declaration IS NULL OR (jsonb_typeof(declaration)='object' AND profile IS NOT NULL));

CREATE FUNCTION factory.protect_factorybox_declaration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.declaration IS NOT NULL AND NEW.declaration IS DISTINCT FROM OLD.declaration
    THEN RAISE EXCEPTION 'Worker bootstrap declaration is immutable'; END IF;
  IF NEW.declaration IS NOT NULL AND NEW.profile IS NULL
    THEN RAISE EXCEPTION 'Worker declaration requires its pinned profile'; END IF;
  IF NOT OLD.create_attempted AND NEW.create_attempted AND NEW.declaration IS NULL
    THEN RAISE EXCEPTION 'Worker create requires its retained bootstrap declaration'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER factorybox_declaration_identity
  BEFORE UPDATE ON factory.factorybox_worker_admission
  FOR EACH ROW EXECUTE FUNCTION factory.protect_factorybox_declaration();

INSERT INTO factory.schema_migration(version) VALUES(3);
COMMIT;
