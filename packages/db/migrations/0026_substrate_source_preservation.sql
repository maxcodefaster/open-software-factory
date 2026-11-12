BEGIN;

-- A complete private recovery-archive reference for a failed initial personal
-- bootstrap. It neither creates a normal Source generation nor transfers its
-- writer, and cannot authorize continuation of the failed bootstrap.
ALTER TABLE factory.substrate_source ADD COLUMN preservation jsonb
  CHECK(preservation IS NULL OR jsonb_typeof(preservation)='object');

CREATE FUNCTION factory.protect_substrate_source_preservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.preservation IS NOT NULL THEN
      RAISE EXCEPTION 'Source preservation requires its existing frozen Actor owner';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.preservation IS NOT NULL THEN
    IF NEW.preservation IS DISTINCT FROM OLD.preservation
      OR ROW(NEW.owner,NEW.writer_epoch,NEW.writable,NEW.generation,NEW.checkpoint_id,NEW.checkpoint,NEW.service_base)
        IS DISTINCT FROM ROW(OLD.owner,OLD.writer_epoch,OLD.writable,OLD.generation,OLD.checkpoint_id,OLD.checkpoint,OLD.service_base)
      THEN RAISE EXCEPTION 'Preserved initial Source stays fenced with its original Actor'; END IF;
  ELSIF NEW.preservation IS NOT NULL THEN
    IF NEW.owner<>'actor' OR NEW.writable OR NEW.writer_epoch<=1 OR NEW.generation<>0
      OR NEW.checkpoint_id IS NULL OR NEW.checkpoint IS NOT NULL OR NEW.service_base IS NOT NULL
      OR NEW.preservation->>'version' IS DISTINCT FROM '1'
      OR NEW.preservation->>'workspaceID' IS DISTINCT FROM NEW.workspace_id::text
      OR NEW.preservation->>'actorUID' IS DISTINCT FROM NEW.actor_uid::text
      OR NEW.preservation->>'checkpointID' IS DISTINCT FROM NEW.checkpoint_id::text
      OR NEW.preservation->>'writerEpoch' IS DISTINCT FROM NEW.writer_epoch::text
      OR NEW.preservation->>'sourceGeneration' IS DISTINCT FROM '0'
      OR NEW.preservation#>>'{bundle,version}' IS DISTINCT FROM '2'
      OR COALESCE(NEW.preservation->>'manifestSHA256','') !~ '^[a-f0-9]{64}$'
      OR NOT EXISTS(SELECT 1 FROM factory.runtime_attempt a
        JOIN factory.development_workspace w ON w.id=a.workspace_id
        JOIN factory.substrate_binding b ON b.runtime_attempt_id=a.id
        WHERE a.workspace_id=NEW.workspace_id AND a.substrate AND w.substrate AND w.kind='personal'
          AND a.change_id IS NULL AND w.change_id IS NULL AND w.owner_user_id=a.created_by
          AND a.state IN ('failed','pausing') AND a.ready_at IS NULL AND a.failure IS NOT NULL
          AND a.stop_intended_at IS NULL AND b.actor_uid=NEW.actor_uid
          AND NOT b.create_rejected AND b.delete_intended_at IS NULL AND b.deleted_at IS NULL
          AND b.checkpoint IS NULL
          AND NEW.preservation->>'projectID'=a.project_id::text
          AND NEW.preservation->>'attemptID'=a.id::text
          AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt n WHERE n.workspace_id=w.id AND n.generation>a.generation)
          AND NOT EXISTS(SELECT 1 FROM factory.change_agent_turn_intent i WHERE i.runtime_attempt_id=a.id))
      THEN RAISE EXCEPTION 'Source preservation requires the exact frozen failed initial personal owner'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER substrate_source_preservation_identity BEFORE INSERT OR UPDATE ON factory.substrate_source
  FOR EACH ROW EXECUTE FUNCTION factory.protect_substrate_source_preservation();

INSERT INTO factory.schema_migration(version) VALUES(26);
COMMIT;
