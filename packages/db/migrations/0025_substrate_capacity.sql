BEGIN;

-- WorkerPool creation facts. The native controller still creates and schedules
-- workers; Factory never resizes or replaces the retained installation pool.
CREATE TABLE factory.substrate_worker_capacity (
  owner text NOT NULL CHECK(owner ~ '^[a-f0-9]{32}$'),
  node_uid uuid NOT NULL,
  intent jsonb NOT NULL CHECK(jsonb_typeof(intent)='object'),
  attempted_at timestamptz,
  rejected boolean NOT NULL DEFAULT false,
  pool jsonb CHECK(pool IS NULL OR jsonb_typeof(pool)='object'),
  PRIMARY KEY(owner,node_uid),
  CHECK(pool IS NULL OR attempted_at IS NOT NULL)
);
CREATE FUNCTION factory.protect_substrate_worker_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Native worker capacity names cannot be reused'; END IF;
  IF TG_OP='INSERT' AND (
    NEW.intent->>'database' IS DISTINCT FROM current_database()
    OR NEW.intent#>>'{node,uid}' IS DISTINCT FROM NEW.node_uid::text
    OR NEW.intent#>>'{pool,metadata,name}' IS DISTINCT FROM 'factory-native-'||substring(encode(digest(NEW.owner||':'||NEW.node_uid::text,'sha256'),'hex') from 1 for 32)
    OR NEW.intent#>>'{pool,metadata,labels,factory.dev/native-capacity}' IS DISTINCT FROM NEW.owner
    OR NEW.intent#>>'{pool,metadata,annotations,factory.dev/creation-intent}' IS NULL)
    THEN RAISE EXCEPTION 'Native worker capacity requires deterministic installation and node intent'; END IF;
  IF TG_OP='UPDATE' AND (
    ROW(NEW.owner,NEW.node_uid,NEW.intent) IS DISTINCT FROM ROW(OLD.owner,OLD.node_uid,OLD.intent)
    OR (OLD.attempted_at IS NOT NULL AND NEW.attempted_at IS DISTINCT FROM OLD.attempted_at)
    OR (OLD.rejected AND NOT NEW.rejected)
    OR (OLD.pool IS NOT NULL AND NEW.pool IS DISTINCT FROM OLD.pool))
    THEN RAISE EXCEPTION 'Native worker capacity intent and creation facts are immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER substrate_worker_capacity_identity BEFORE INSERT OR UPDATE OR DELETE ON factory.substrate_worker_capacity
  FOR EACH ROW EXECUTE FUNCTION factory.protect_substrate_worker_capacity();

INSERT INTO factory.schema_migration(version) VALUES(25);
COMMIT;
