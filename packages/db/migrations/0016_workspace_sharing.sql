BEGIN;

ALTER TABLE factory.development_workspace ADD COLUMN collaboration_enabled boolean NOT NULL DEFAULT false;

-- Sharing changes access to the retained Workspace, never its owner or runtime identity.
CREATE TABLE factory.workspace_share (
  workspace_id uuid NOT NULL REFERENCES factory.development_workspace(id),
  user_id uuid NOT NULL REFERENCES auth."user"(id),
  permission text NOT NULL CHECK (permission IN ('observe','collaborate')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  granted_by uuid NOT NULL REFERENCES auth."user"(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (workspace_id,user_id)
);

CREATE TABLE factory.workspace_share_decision (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES factory.development_workspace(id),
  user_id uuid NOT NULL REFERENCES auth."user"(id),
  actor_id uuid NOT NULL REFERENCES auth."user"(id),
  permission text CHECK (permission IN ('observe','collaborate')),
  expected_version bigint NOT NULL CHECK (expected_version >= 0),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  access_reconciled_at timestamptz
);

INSERT INTO factory.schema_migration(version) VALUES(16);
COMMIT;
