BEGIN;

CREATE TABLE factory.workspace_file_transfer (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES factory.development_workspace(id),
  runtime_attempt_id uuid NOT NULL REFERENCES factory.runtime_attempt(id),
  actor_id uuid NOT NULL REFERENCES auth."user"(id),
  direction text NOT NULL CHECK (direction IN ('upload','download')),
  input_digest text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  path text NOT NULL,
  state text NOT NULL CHECK (state IN ('preparing','active','committing','committed','releasing','released','uncertain')),
  result jsonb,
  commit_attempted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_file_transfer_runtime_idx ON factory.workspace_file_transfer(runtime_attempt_id);

-- Content stays in the Sandbox. Only exact mutation identities and compact outcomes are retained.
CREATE TABLE factory.workspace_file_operation (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES factory.development_workspace(id),
  runtime_attempt_id uuid NOT NULL REFERENCES factory.runtime_attempt(id),
  actor_id uuid NOT NULL REFERENCES auth."user"(id),
  action text NOT NULL CHECK (action IN ('mkdir','delete','rename')),
  input_digest text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

INSERT INTO factory.schema_migration(version) VALUES(20);
COMMIT;
