BEGIN;

CREATE TABLE factory.workspace_terminal_operation (
  id uuid PRIMARY KEY,
  command_id uuid NOT NULL REFERENCES factory.workspace_command(id),
  actor_id uuid NOT NULL REFERENCES auth."user"(id),
  action text NOT NULL CHECK (action IN ('input','resize')),
  input_digest text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

INSERT INTO factory.schema_migration(version) VALUES(20);
COMMIT;
