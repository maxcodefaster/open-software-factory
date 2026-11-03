BEGIN;

-- A worker can terminate after checkpoint retirement but before private
-- backing cleanup. Keep each confirmed native receipt, not only the final
-- aggregate, so its successor need not execute an old checkpoint recipe.
ALTER TABLE factory.execution_slot
  ADD COLUMN factorybox_retirement_progress jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(factorybox_retirement_progress)='array'),
  ADD CONSTRAINT slot_retirement_progress_request CHECK (
    factorybox_retirement_progress='[]'::jsonb OR factorybox_retirement_request IS NOT NULL);

CREATE INDEX factorybox_backing_retirement_pending
  ON factory.factorybox_lifecycle_operation(id)
  WHERE action='retire-sandbox' AND completed_at IS NULL;
CREATE INDEX slot_backing_retirement_pending
  ON factory.execution_slot(id)
  WHERE state='deleted' AND factorybox_retirement_request IS NOT NULL
    AND factorybox_retirement_observation IS NULL;

CREATE FUNCTION factory.protect_slot_retirement_progress() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.factorybox_retirement_progress IS DISTINCT FROM OLD.factorybox_retirement_progress
    AND (
      NEW.factorybox_retirement_request IS NULL
      OR NEW.state NOT IN ('retiring','assigned','deleted')
      OR jsonb_array_length(NEW.factorybox_retirement_progress) <
        jsonb_array_length(OLD.factorybox_retirement_progress)
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(OLD.factorybox_retirement_progress)
          WITH ORDINALITY AS original(receipt,ordinal)
        WHERE NEW.factorybox_retirement_progress->((original.ordinal-1)::int)
          IS DISTINCT FROM original.receipt
      )
    )
  THEN RAISE EXCEPTION 'Slot retirement progress is append-only and requires its original request';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER slot_retirement_progress
  BEFORE UPDATE ON factory.execution_slot FOR EACH ROW
  EXECUTE FUNCTION factory.protect_slot_retirement_progress();

INSERT INTO factory.schema_migration(version) VALUES(10);
COMMIT;
