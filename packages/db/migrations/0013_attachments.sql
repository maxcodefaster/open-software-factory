BEGIN;
CREATE TABLE factory.attachment_storage (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  id uuid NOT NULL UNIQUE
);
INSERT INTO factory.attachment_storage(singleton,id) VALUES(true,gen_random_uuid());
CREATE TRIGGER attachment_storage_immutable BEFORE DELETE OR UPDATE ON factory.attachment_storage
  FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TABLE factory.attachment (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES factory.project(id),
  owner_id uuid NOT NULL REFERENCES auth."user"(id),
  draft_id uuid,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 240),
  media_type text NOT NULL,
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  byte_length bigint NOT NULL CHECK(byte_length > 0),
  reserved_bytes bigint NOT NULL CHECK(reserved_bytes >= byte_length),
  state text NOT NULL CHECK(state IN ('uploading','ready','failed','deleting','deleted')),
  text_content text NOT NULL DEFAULT '',
  objects jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(objects)='array'),
  failure text,
  upload_token uuid,
  upload_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  deleted_at timestamptz
);
CREATE INDEX attachment_project_storage ON factory.attachment(project_id,state);
CREATE TABLE factory.attachment_draft (
  id uuid NOT NULL,
  owner_id uuid NOT NULL REFERENCES auth."user"(id),
  project_id uuid NOT NULL REFERENCES factory.project(id),
  sequence bigint NOT NULL CHECK(sequence>=0),
  attachment_ids uuid[] NOT NULL,
  PRIMARY KEY(id,owner_id)
);
CREATE TABLE factory.attachment_reference (
  attachment_id uuid NOT NULL REFERENCES factory.attachment(id),
  kind text NOT NULL CHECK(kind IN ('ticket','requirement','knowledge','conversation','feedback','turn')),
  reference_id uuid NOT NULL,
  shared boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(attachment_id,kind,reference_id)
);
CREATE INDEX attachment_reference_target ON factory.attachment_reference(kind,reference_id);
CREATE TRIGGER attachment_reference_immutable BEFORE DELETE OR UPDATE ON factory.attachment_reference
  FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();
CREATE TABLE factory.attachment_turn_context (
  turn_id uuid NOT NULL REFERENCES factory.agent_turn(id),
  source text NOT NULL DEFAULT 'admission',
  content text NOT NULL,
  PRIMARY KEY(turn_id,source)
);
CREATE TRIGGER attachment_turn_context_immutable BEFORE DELETE OR UPDATE ON factory.attachment_turn_context
  FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE FUNCTION factory.bind_attachment_references(
  project uuid, actor uuid, reference_kind text, target uuid, content text, is_shared boolean
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE matched text[]; asset factory.attachment; authored text;
BEGIN
  authored := regexp_replace(COALESCE(content,''),'```.*?```|~~~.*?~~~','','gs');
  authored := regexp_replace(authored,'`[^`]*`','','g');
  FOR matched IN SELECT regexp_matches(authored,$ref$/api/attachments/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?=[/)\s"'\\]|$)$ref$,'gi') LOOP
    SELECT * INTO asset FROM factory.attachment WHERE id=matched[1]::uuid FOR SHARE;
    IF NOT FOUND OR asset.project_id<>project OR asset.state<>'ready' OR
      (asset.owner_id IS DISTINCT FROM actor AND NOT EXISTS(
        SELECT 1 FROM factory.attachment_reference r WHERE r.attachment_id=asset.id AND r.shared
      )) THEN
      RAISE EXCEPTION 'Attachment is unavailable in this document context' USING ERRCODE='23514';
    END IF;
    INSERT INTO factory.attachment_reference(attachment_id,kind,reference_id,shared)
      VALUES(asset.id,reference_kind,target,is_shared) ON CONFLICT DO NOTHING;
  END LOOP;
END $$;

CREATE FUNCTION factory.bind_authored_attachments() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE project uuid; actor uuid; target uuid; reference_kind text; content text; shared boolean := true;
BEGIN
  actor := (to_jsonb(NEW)->>'created_by')::uuid;
  IF TG_TABLE_NAME='knowledge_revision' THEN
    SELECT project_id INTO project FROM factory.knowledge_page WHERE id=NEW.page_id;
    reference_kind := 'knowledge'; target := NEW.id; content := NEW.body;
  ELSIF TG_TABLE_NAME='ticket_document_revision' THEN
    SELECT project_id INTO project FROM factory.ticket WHERE id=NEW.ticket_id;
    reference_kind := 'ticket'; target := NEW.id;
    content := NEW.description || COALESCE(NEW.canonical_content,'');
  ELSIF TG_TABLE_NAME='requirement_revision' THEN
    SELECT project_id INTO project FROM factory.ticket WHERE id=NEW.ticket_id;
    reference_kind := 'requirement'; target := NEW.id; content := NEW.canonical_content;
  ELSIF TG_TABLE_NAME='ticket' THEN
    project := NEW.project_id; reference_kind := 'ticket'; target := NEW.id; content := NEW.description;
  ELSIF TG_TABLE_NAME='conversation_entry' THEN
    SELECT project_id,(ticket_id IS NOT NULL) INTO project,shared
      FROM factory.ticket_conversation WHERE id=NEW.conversation_id;
    IF actor IS NULL THEN
      SELECT created_by INTO actor FROM factory.ticket_conversation WHERE id=NEW.conversation_id;
    END IF;
    reference_kind := 'conversation'; target := NEW.conversation_id; content := NEW.body;
  ELSE
    SELECT c.project_id INTO project FROM factory.review_feedback f
      JOIN factory.change c ON c.id=f.change_id WHERE f.id=NEW.feedback_id;
    actor := NEW.author_id; reference_kind := 'feedback'; target := NEW.id; content := NEW.body;
  END IF;
  PERFORM factory.bind_attachment_references(project,actor,reference_kind,target,content,shared);
  IF TG_TABLE_NAME='ticket' THEN
    DELETE FROM factory.attachment_draft WHERE id=NEW.id AND owner_id=NEW.created_by AND project_id=NEW.project_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER knowledge_attachments AFTER INSERT ON factory.knowledge_revision
  FOR EACH ROW EXECUTE FUNCTION factory.bind_authored_attachments();
CREATE TRIGGER ticket_document_attachments AFTER INSERT ON factory.ticket_document_revision
  FOR EACH ROW EXECUTE FUNCTION factory.bind_authored_attachments();
CREATE TRIGGER requirement_attachments AFTER INSERT ON factory.requirement_revision
  FOR EACH ROW EXECUTE FUNCTION factory.bind_authored_attachments();
CREATE TRIGGER ticket_attachments AFTER INSERT ON factory.ticket
  FOR EACH ROW EXECUTE FUNCTION factory.bind_authored_attachments();
CREATE TRIGGER conversation_attachments AFTER INSERT ON factory.conversation_entry
  FOR EACH ROW EXECUTE FUNCTION factory.bind_authored_attachments();
CREATE TRIGGER feedback_attachments AFTER INSERT ON factory.review_feedback_message
  FOR EACH ROW EXECUTE FUNCTION factory.bind_authored_attachments();

CREATE FUNCTION factory.protect_attachment_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.project_id,NEW.owner_id,NEW.draft_id,NEW.name,NEW.media_type,NEW.sha256,NEW.byte_length)
    IS DISTINCT FROM ROW(OLD.id,OLD.project_id,OLD.owner_id,OLD.draft_id,OLD.name,OLD.media_type,OLD.sha256,OLD.byte_length)
    OR (OLD.completed_at IS NOT NULL AND ROW(NEW.objects,NEW.text_content,NEW.reserved_bytes,NEW.completed_at)
      IS DISTINCT FROM ROW(OLD.objects,OLD.text_content,OLD.reserved_bytes,OLD.completed_at)) THEN
    RAISE EXCEPTION 'Attachment content and ownership are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attachment_identity BEFORE UPDATE ON factory.attachment
  FOR EACH ROW EXECUTE FUNCTION factory.protect_attachment_identity();
INSERT INTO factory.schema_migration(version) VALUES(13);
COMMIT;
