BEGIN;

CREATE TABLE factory.workspace_shared_document (
  workspace_id uuid NOT NULL REFERENCES factory.development_workspace(id),
  path text NOT NULL,
  y_state bytea NOT NULL CHECK (octet_length(y_state)<=8388608),
  disk_version text NOT NULL,
  dirty boolean NOT NULL DEFAULT false,
  conflict boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,path)
);
CREATE TABLE factory.workspace_collaboration_decision (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES factory.development_workspace(id),
  actor_id uuid NOT NULL REFERENCES auth."user"(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO factory.schema_migration(version) VALUES(21);
COMMIT;
