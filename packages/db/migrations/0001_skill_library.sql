BEGIN;
CREATE TABLE factory.skill_library (
  id uuid PRIMARY KEY,
  storage_key text NOT NULL UNIQUE,
  scope text NOT NULL CHECK (scope IN ('system', 'project', 'personal')),
  owner_id uuid REFERENCES auth."user"(id),
  project_id uuid REFERENCES factory.project(id),
  CHECK ((scope = 'personal' AND owner_id IS NOT NULL AND project_id IS NULL)
    OR (scope = 'project' AND owner_id IS NULL AND project_id IS NOT NULL)
    OR (scope = 'system' AND owner_id IS NULL AND project_id IS NULL))
);
CREATE TABLE factory.skill_library_revision (
  library_id uuid NOT NULL REFERENCES factory.skill_library(id),
  revision_id uuid PRIMARY KEY REFERENCES factory.skill_revision(id),
  copied_from uuid REFERENCES factory.skill_revision(id)
);
CREATE TABLE factory.skill_library_choice (
  library_id uuid NOT NULL REFERENCES factory.skill_library(id),
  scope text NOT NULL CHECK (scope IN ('system', 'project', 'personal')),
  context_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('planning', 'build')),
  state text NOT NULL CHECK (state IN ('inherit', 'enable', 'disable', 'required')),
  revision_id uuid NOT NULL REFERENCES factory.skill_revision(id),
  version bigint NOT NULL CHECK (version > 0),
  PRIMARY KEY (library_id, scope, context_id, user_id, role),
  CHECK (state != 'required' OR scope != 'personal')
);
CREATE TABLE factory.skill_share_proposal (
  id uuid PRIMARY KEY,
  revision_id uuid NOT NULL REFERENCES factory.skill_revision(id),
  proposed_by uuid NOT NULL REFERENCES auth."user"(id),
  target text NOT NULL CHECK (target IN ('system', 'project')),
  project_id uuid REFERENCES factory.project(id),
  accepted_library_id uuid REFERENCES factory.skill_library(id),
  CHECK ((target = 'project') = (project_id IS NOT NULL))
);
INSERT INTO factory.skill_library(id, storage_key, scope)
  SELECT (substr(md5('factory-legacy-skill:' || skill_key),1,12) || '4' || substr(md5('factory-legacy-skill:' || skill_key),14,3) || '8' || substr(md5('factory-legacy-skill:' || skill_key),18,15))::uuid, skill_key, 'system'
  FROM factory.skill_revision GROUP BY skill_key;
INSERT INTO factory.skill_library_revision(library_id, revision_id)
  SELECT library.id, revision.id FROM factory.skill_revision revision
  JOIN factory.skill_library library ON library.storage_key = revision.skill_key;
CREATE TRIGGER skill_library_identity_immutable BEFORE DELETE OR UPDATE ON factory.skill_library FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();
CREATE TRIGGER skill_library_revision_immutable BEFORE DELETE OR UPDATE ON factory.skill_library_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();
-- Existing immutable content and legacy settings remain byte-for-byte intact.
ALTER TABLE factory.skill_revision DROP CONSTRAINT skill_revision_content_check;
ALTER TABLE factory.skill_revision ADD CONSTRAINT skill_revision_content_check CHECK
  (jsonb_typeof(content) = 'object' AND octet_length(content::text) <= 2100000);
INSERT INTO factory.schema_migration(version) VALUES (1);
ALTER TABLE factory.change_agent_turn_intent ADD COLUMN skill_loading text NOT NULL DEFAULT 'eager' CHECK (skill_loading IN ('eager', 'native'));
ALTER TABLE factory.change_agent_turn_intent ADD COLUMN skill_manifest jsonb;
ALTER TABLE factory.change_agent_turn_intent ADD COLUMN skill_attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE FUNCTION factory.guard_native_skill_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.skill_loading, NEW.skill_manifest, NEW.skill_attachments) IS DISTINCT FROM ROW(OLD.skill_loading, OLD.skill_manifest, OLD.skill_attachments) THEN
    RAISE EXCEPTION 'Admitted skill package is immutable';
  END IF;
  IF (NEW.skill_loading = 'native') != (NEW.skill_manifest IS NOT NULL) THEN RAISE EXCEPTION 'Native skill package is required'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER native_skill_intent_guard BEFORE INSERT OR UPDATE ON factory.change_agent_turn_intent FOR EACH ROW EXECUTE FUNCTION factory.guard_native_skill_intent();
COMMIT;
