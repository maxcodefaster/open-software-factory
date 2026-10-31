BEGIN;

-- A Workspace's Source seed stays immutable. Replaceable Ticket execution
-- instead pins the latest submitted commit, including its App configuration.
ALTER TABLE factory.runtime_attempt
  DROP CONSTRAINT runtime_attempt_change_revision_fk;

CREATE FUNCTION factory.require_ticket_execution_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.change_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM factory.change WHERE id=NEW.change_id AND project_id=NEW.project_id
  ) AND NOT EXISTS (
    SELECT 1 FROM factory.change change
    WHERE change.id=NEW.change_id AND change.project_id=NEW.project_id
      AND NEW.revision=COALESCE(
        (SELECT commit_sha FROM factory.change_commit_operation
          WHERE change_id=change.id AND state='succeeded' ORDER BY sequence DESC LIMIT 1),
        change.base_sha)
  ) THEN
    RAISE EXCEPTION 'Ticket execution revision must match the latest submitted Change commit or its initial base'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER ticket_execution_revision BEFORE INSERT ON factory.runtime_attempt
  FOR EACH ROW EXECUTE FUNCTION factory.require_ticket_execution_revision();

INSERT INTO factory.schema_migration(version) VALUES(6);
COMMIT;
