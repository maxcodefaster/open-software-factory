BEGIN;

CREATE TABLE factory.workspace_lifecycle_command (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES factory.development_workspace(id),
  runtime_attempt_id uuid REFERENCES factory.runtime_attempt(id),
  actor_id uuid NOT NULL REFERENCES auth."user"(id),
  action text NOT NULL CHECK (action IN ('start','pause','stop')),
  dispatch_attempted_at timestamptz,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

INSERT INTO factory.schema_migration(version) VALUES(32);
COMMIT;
