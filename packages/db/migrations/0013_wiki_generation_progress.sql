BEGIN;

-- Compact, overwritten progress for the running attempt. Existing generations keep NULL.
ALTER TABLE factory.knowledge_generation
  ADD COLUMN progress jsonb,
  ADD CONSTRAINT knowledge_generation_progress_shape CHECK (
    progress IS NULL OR (
      jsonb_typeof(progress)='object'
      AND progress->>'phase' IN ('planning','writing','publishing','done')
      AND jsonb_typeof(progress->'topicsTotal')='number'
      AND jsonb_typeof(progress->'topicsDone')='number'
      AND (progress->>'topicsTotal')::numeric BETWEEN 0 AND 100
      AND (progress->>'topicsDone')::numeric BETWEEN 0 AND 100
      AND jsonb_typeof(progress->'currentTopic') IN ('string','null')
      AND octet_length(progress::text)<=1000
    )
  );

INSERT INTO factory.schema_migration(version) VALUES(13);
COMMIT;
