BEGIN;

-- Definitions remain transient. Their keyed digest identifies an exact admitted command
-- without retaining shell text or environment credentials in product history.
CREATE TABLE factory.workspace_command (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES factory.development_workspace(id),
  runtime_attempt_id uuid NOT NULL REFERENCES factory.runtime_attempt(id),
  actor_id uuid NOT NULL REFERENCES auth."user"(id),
  kind text NOT NULL DEFAULT 'shell' CHECK (kind IN ('shell','terminal')),
  input_digest text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'start-intended'
    CHECK (state IN ('start-intended','dispatching','starting','running','exited','cancelled','failed','uncertain','interrupted')),
  dispatch_attempted_at timestamptz,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_command_runtime_idx ON factory.workspace_command(runtime_attempt_id,state);

INSERT INTO factory.schema_migration(version) VALUES(18);
COMMIT;
