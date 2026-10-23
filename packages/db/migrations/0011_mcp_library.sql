BEGIN;
CREATE TABLE factory.mcp_library (
  id uuid PRIMARY KEY,
  scope text NOT NULL CHECK (scope IN ('personal','project','system')),
  owner_id uuid REFERENCES auth."user"(id),
  project_id uuid REFERENCES factory.project(id),
  CHECK ((scope='personal' AND owner_id IS NOT NULL AND project_id IS NULL)
    OR (scope='project' AND owner_id IS NULL AND project_id IS NOT NULL)
    OR (scope='system' AND owner_id IS NULL AND project_id IS NULL))
);
CREATE TABLE factory.mcp_revision (
  id uuid PRIMARY KEY,
  library_id uuid NOT NULL REFERENCES factory.mcp_library(id),
  revision bigint NOT NULL CHECK (revision > 0),
  content jsonb NOT NULL CHECK (jsonb_typeof(content)='object' AND octet_length(content::text) < 16000),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  created_by uuid NOT NULL REFERENCES auth."user"(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(library_id,revision)
);
CREATE TRIGGER mcp_library_identity_immutable BEFORE DELETE OR UPDATE ON factory.mcp_library FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();
CREATE TRIGGER mcp_revision_immutable BEFORE DELETE OR UPDATE ON factory.mcp_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();
CREATE TABLE factory.mcp_share_proposal (
  id uuid PRIMARY KEY,
  revision_id uuid NOT NULL REFERENCES factory.mcp_revision(id),
  proposed_by uuid NOT NULL REFERENCES auth."user"(id),
  target text NOT NULL CHECK(target IN ('project','system')),
  project_id uuid REFERENCES factory.project(id),
  accepted_library_id uuid REFERENCES factory.mcp_library(id),
  accepted_by uuid REFERENCES auth."user"(id),
  accepted_at timestamptz,
  CHECK ((target='project')=(project_id IS NOT NULL))
);
CREATE TABLE factory.mcp_choice (
  library_id uuid NOT NULL REFERENCES factory.mcp_library(id),
  scope text NOT NULL CHECK (scope IN ('personal','project','system')),
  context_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('planning','build')),
  state text NOT NULL CHECK (state IN ('inherit','enable','disable','required')),
  revision_id uuid NOT NULL REFERENCES factory.mcp_revision(id),
  version bigint NOT NULL CHECK (version > 0),
  PRIMARY KEY(library_id,scope,context_id,user_id,role),
  CHECK (scope != 'personal' OR state != 'required')
);
CREATE TABLE factory.mcp_connection (
  id uuid PRIMARY KEY REFERENCES factory.mcp_library(id),
  revision_id uuid NOT NULL REFERENCES factory.mcp_revision(id),
  state text NOT NULL CHECK (state IN ('disconnected','authorizing','review','ready','reconnect','revoked')),
  version bigint NOT NULL DEFAULT 0,
  secret_key text,
  credential_epoch uuid NOT NULL,
  tools jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(tools)='array' AND octet_length(tools::text) <= 1000000),
  allowed_tools jsonb NOT NULL DEFAULT '[]',
  authorized_by uuid NOT NULL REFERENCES auth."user"(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE factory.mcp_project_grant (
  connection_id uuid NOT NULL REFERENCES factory.mcp_connection(id),
  credential_epoch uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES factory.project(id),
  granted_by uuid NOT NULL REFERENCES auth."user"(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(connection_id,project_id)
);
CREATE TABLE factory.mcp_policy_approval (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES factory.mcp_connection(id),
  revision_id uuid NOT NULL REFERENCES factory.mcp_revision(id),
  credential_epoch uuid NOT NULL,
  version bigint NOT NULL,
  tools jsonb NOT NULL,
  reviewed_by uuid NOT NULL REFERENCES auth."user"(id),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(connection_id,version)
);
CREATE TRIGGER mcp_policy_approval_immutable BEFORE DELETE OR UPDATE ON factory.mcp_policy_approval FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();
CREATE TABLE factory.mcp_access_decision (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES factory.mcp_connection(id),
  credential_epoch uuid NOT NULL,
  project_id uuid REFERENCES factory.project(id),
  action text NOT NULL CHECK(action IN ('grant','revoke','disconnect')),
  decided_by uuid NOT NULL REFERENCES auth."user"(id),
  decided_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER mcp_access_decision_immutable BEFORE DELETE OR UPDATE ON factory.mcp_access_decision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();
CREATE TABLE factory.mcp_secret_write (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES factory.mcp_connection(id),
  base_key text,
  credential_epoch uuid NOT NULL,
  secret_key text NOT NULL UNIQUE,
  digest text NOT NULL,
  state text NOT NULL CHECK (state IN ('intended','committed','superseded')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX mcp_secret_pending ON factory.mcp_secret_write(connection_id) WHERE state='intended';
CREATE TABLE factory.mcp_oauth_flow (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES factory.mcp_connection(id),
  created_by uuid NOT NULL REFERENCES auth."user"(id),
  state_digest text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('pending','exchanging','completed','failed')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE factory.mcp_connect_intent (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES factory.mcp_connection(id),
  revision_id uuid NOT NULL REFERENCES factory.mcp_revision(id),
  created_by uuid NOT NULL REFERENCES auth."user"(id),
  fingerprint text NOT NULL,
  state text NOT NULL CHECK (state IN ('running','completed','failed','uncertain')),
  authorization_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX mcp_connect_running ON factory.mcp_connect_intent(connection_id) WHERE state='running';
CREATE TABLE factory.mcp_token_refresh (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES factory.mcp_connection(id),
  credential_epoch uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('intended','committed','uncertain')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX mcp_refresh_pending ON factory.mcp_token_refresh(connection_id) WHERE state='intended';
CREATE TABLE factory.agent_turn_mcp (
  turn_id uuid NOT NULL REFERENCES factory.agent_turn(id),
  connection_id uuid NOT NULL REFERENCES factory.mcp_connection(id),
  credential_epoch uuid NOT NULL,
  revision_id uuid NOT NULL REFERENCES factory.mcp_revision(id),
  policy_version bigint NOT NULL,
  tools jsonb NOT NULL,
  required boolean NOT NULL,
  PRIMARY KEY(turn_id,connection_id)
);
CREATE TRIGGER agent_turn_mcp_immutable BEFORE DELETE OR UPDATE ON factory.agent_turn_mcp FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();
CREATE TABLE factory.mcp_observation (
  id uuid PRIMARY KEY,
  turn_id uuid NOT NULL REFERENCES factory.agent_turn(id),
  connection_id uuid NOT NULL REFERENCES factory.mcp_connection(id),
  tool_name text NOT NULL,
  tool_digest text NOT NULL,
  result_digest text NOT NULL,
  is_error boolean NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER mcp_observation_immutable BEFORE DELETE OR UPDATE ON factory.mcp_observation FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();
INSERT INTO factory.schema_migration(version) VALUES(11);
COMMIT;
