BEGIN;

-- One concrete Workspace writer lease and its last fully confirmed Source
-- object. No runtime lifecycle, transition journal, or project-wide tree.
CREATE TABLE factory.substrate_source (
  workspace_id uuid PRIMARY KEY REFERENCES factory.substrate_workspace(workspace_id),
  actor_uid uuid NOT NULL,
  owner text NOT NULL DEFAULT 'actor' CHECK(owner IN ('actor','service')),
  writer_epoch bigint NOT NULL DEFAULT 1 CHECK(writer_epoch > 0),
  writable boolean NOT NULL DEFAULT true,
  generation bigint NOT NULL DEFAULT 0 CHECK(generation >= 0),
  checkpoint_id uuid,
  checkpoint jsonb,
  service_base uuid,
  CHECK((generation=0)=(checkpoint IS NULL)),
  CHECK(writable=(checkpoint_id IS NULL)),
  CHECK(owner<>'service' OR service_base IS NOT NULL)
);
CREATE FUNCTION factory.protect_substrate_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Source ownership and checkpoints cannot be discarded'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.owner<>'actor' OR NEW.writer_epoch<>1 OR NOT NEW.writable OR NEW.generation<>0
      OR NOT EXISTS(SELECT 1 FROM factory.runtime_attempt a JOIN factory.substrate_binding b ON b.runtime_attempt_id=a.id
        WHERE a.workspace_id=NEW.workspace_id AND a.substrate AND b.actor_uid=NEW.actor_uid
          AND b.delete_intended_at IS NULL AND b.deleted_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt n WHERE n.workspace_id=a.workspace_id AND n.generation>a.generation))
      THEN RAISE EXCEPTION 'Source requires its current original Actor binding'; END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.workspace_id,NEW.actor_uid) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.actor_uid)
    OR NEW.writer_epoch<OLD.writer_epoch OR NEW.writer_epoch>OLD.writer_epoch+1
    OR NEW.generation<OLD.generation OR NEW.generation>OLD.generation+1
    THEN RAISE EXCEPTION 'Source identity/epoch/generation changed'; END IF;
  IF NEW.generation<>OLD.generation THEN
    IF NEW.writable OR NEW.owner<>OLD.owner OR NEW.writer_epoch<>OLD.writer_epoch
      OR NEW.checkpoint_id IS DISTINCT FROM OLD.checkpoint_id
      OR NEW.checkpoint->>'id' IS DISTINCT FROM NEW.checkpoint_id::text
      OR NEW.checkpoint->>'workspaceID' IS DISTINCT FROM NEW.workspace_id::text
      OR NEW.checkpoint->>'actorUID' IS DISTINCT FROM NEW.actor_uid::text
      OR NEW.checkpoint->>'generation' IS DISTINCT FROM NEW.generation::text
      OR NEW.checkpoint->>'writerEpoch' IS DISTINCT FROM NEW.writer_epoch::text
      THEN RAISE EXCEPTION 'Source checkpoint confirmation differs from frozen writer'; END IF;
  ELSIF NEW.checkpoint IS DISTINCT FROM OLD.checkpoint THEN
    RAISE EXCEPTION 'Last confirmed Source is immutable until a new generation';
  END IF;
  IF NEW.owner<>OLD.owner THEN
    IF OLD.writable OR NOT NEW.writable OR NEW.writer_epoch<>OLD.writer_epoch+1
      OR OLD.checkpoint_id IS NULL OR OLD.checkpoint->>'id' IS DISTINCT FROM OLD.checkpoint_id::text
      OR NEW.checkpoint_id IS NOT NULL OR NEW.generation<>OLD.generation
      OR (NEW.owner='service' AND NEW.service_base IS DISTINCT FROM OLD.checkpoint_id)
      THEN RAISE EXCEPTION 'Source transfer requires a completely confirmed frozen generation'; END IF;
    IF NOT EXISTS(SELECT 1 FROM factory.runtime_attempt a JOIN factory.substrate_binding b ON b.runtime_attempt_id=a.id
      WHERE a.workspace_id=NEW.workspace_id AND a.state='paused' AND b.actor_uid=NEW.actor_uid
        AND b.checkpoint->>'actorUID'=NEW.actor_uid::text
        AND b.checkpoint->>'fidelity'='SNAPSHOT_FIDELITY_ROOTFS'
        AND b.checkpoint#>>'{durableSnapshot,state}'='SNAPSHOT_STORAGE_STATE_COMPLETED'
        AND b.observation#>>'{status,state}'='ACTOR_STATE_SUSPENDED'
        AND b.checkpoint->>'generation'=b.observation#>>'{status,lastAssignedGeneration}')
      THEN RAISE EXCEPTION 'Source transfer requires the original durable paused ROOTFS'; END IF;
  ELSIF NEW.writable IS DISTINCT FROM OLD.writable THEN
    IF NOT OLD.writable OR NEW.writable OR NEW.writer_epoch<>OLD.writer_epoch+1 OR NEW.checkpoint_id IS NULL
      THEN RAISE EXCEPTION 'Source freeze must advance the writer epoch'; END IF;
  ELSIF ROW(NEW.writer_epoch,NEW.checkpoint_id,NEW.service_base) IS DISTINCT FROM ROW(OLD.writer_epoch,OLD.checkpoint_id,OLD.service_base) THEN
    RAISE EXCEPTION 'Source lease facts cannot change outside freeze/transfer';
  END IF;
  IF NEW.owner=OLD.owner AND NEW.service_base IS DISTINCT FROM OLD.service_base THEN
    RAISE EXCEPTION 'Source service base is immutable for its ownership interval'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER substrate_source_identity BEFORE INSERT OR UPDATE OR DELETE ON factory.substrate_source
  FOR EACH ROW EXECUTE FUNCTION factory.protect_substrate_source();
INSERT INTO factory.schema_migration(version) VALUES(21);
COMMIT;
