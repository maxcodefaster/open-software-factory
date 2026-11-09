BEGIN;
CREATE TABLE factory.shared_document_resolution (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES factory.development_workspace(id),
  path text NOT NULL,
  actor_id uuid NOT NULL REFERENCES auth."user"(id),
  choice text NOT NULL CHECK(choice IN ('keep-shared','use-saved')),
  document_revision text NOT NULL,
  disk_version text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO factory.schema_migration(version) VALUES(24);
COMMIT;
