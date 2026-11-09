BEGIN;

ALTER TYPE factory.change_commit_source ADD VALUE 'workspace';
ALTER TABLE factory.change_commit_operation DROP CONSTRAINT change_commit_operation_source_check;
ALTER TABLE factory.change_commit_operation ADD CONSTRAINT change_commit_operation_source_check CHECK (
  (source::text IN ('agent','integration','workspace') AND runtime_attempt_id IS NOT NULL AND repository_path IS NULL
    AND repository_blob_sha IS NULL AND repository_content IS NULL AND content_digest IS NULL)
  OR (source::text='repository-document' AND runtime_attempt_id IS NULL AND repository_path IS NOT NULL
    AND repository_blob_sha ~ '^[0-9a-f]{40}$|^[0-9a-f]{64}$' AND repository_content IS NOT NULL AND content_digest ~ '^[0-9a-f]{64}$')
);
CREATE TABLE factory.workspace_submission (
  id uuid PRIMARY KEY REFERENCES factory.change_commit_operation(id),
  workspace_id uuid NOT NULL REFERENCES factory.development_workspace(id),
  actor_id uuid NOT NULL REFERENCES auth."user"(id),
  writer_epoch bigint NOT NULL,
  remote_head text NOT NULL,
  prepare_attempted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO factory.schema_migration(version) VALUES(23);
COMMIT;
