-- Projections routines. Run before Drizzle tables, with check_function_bodies disabled.

CREATE FUNCTION factory.invalidate_factory_reads() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
<<projection>>
DECLARE
  record jsonb := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  project uuid;
  ticket uuid;
  change uuid;
  conversation uuid;
  audience text := 'shared';
  person uuid;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME='agent_turn' THEN
      IF (OLD.state,OLD.outcome_summary) IS NOT DISTINCT FROM (NEW.state,NEW.outcome_summary) THEN RETURN NULL; END IF;
    ELSIF TG_TABLE_NAME='conversation_context' THEN
      IF (to_jsonb(OLD)-ARRAY['transcript','archived_session']) = (to_jsonb(NEW)-ARRAY['transcript','archived_session']) THEN RETURN NULL; END IF;
    ELSIF (to_jsonb(OLD)-ARRAY['updated_at','owner_expires_at','owner_token']) =
          (to_jsonb(NEW)-ARRAY['updated_at','owner_expires_at','owner_token']) THEN RETURN NULL;
    END IF;
  END IF;

  IF TG_TABLE_NAME IN ('inbox_receipt','account_access','administrator') THEN
    person := (record->>'user_id')::uuid;
    FOR project IN
      SELECT id FROM factory.project WHERE EXISTS(
        SELECT 1 FROM factory.project_membership WHERE project_id=id AND user_id=person)
        OR EXISTS(SELECT 1 FROM factory.administrator WHERE user_id=person)
      ORDER BY id
    LOOP
      PERFORM factory.touch_read_version(project,'inbox',project,person::text);
      IF TG_TABLE_NAME<>'inbox_receipt' THEN
        PERFORM factory.touch_read_version(project,'inbox',project);
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;

  project := (record->>'project_id')::uuid;
  ticket := (record->>'ticket_id')::uuid;
  change := (record->>'change_id')::uuid;
  conversation := (record->>'conversation_id')::uuid;
  IF TG_TABLE_NAME='project' THEN project := (record->>'id')::uuid; END IF;
  IF TG_TABLE_NAME='ticket' THEN ticket := (record->>'id')::uuid; END IF;
  IF TG_TABLE_NAME='change' THEN change := (record->>'id')::uuid; END IF;
  IF TG_TABLE_NAME='ticket_conversation' THEN conversation := (record->>'id')::uuid; END IF;
  IF TG_TABLE_NAME='coding_pause' THEN
    SELECT change_id INTO change FROM factory.agent_turn WHERE id=(record->>'turn_id')::uuid;
  END IF;
  IF TG_TABLE_NAME='runtime_compute_wait' THEN
    SELECT project_id,change_id INTO project,change FROM factory.runtime_attempt WHERE id=(record->>'attempt_id')::uuid;
  END IF;
  IF TG_TABLE_NAME='review_feedback_message' THEN
    SELECT change_id INTO change FROM factory.review_feedback WHERE id=(record->>'feedback_id')::uuid;
  END IF;
  IF TG_TABLE_NAME='review_scenario' THEN
    SELECT change_id INTO change FROM factory.candidate_review WHERE id=(record->>'review_id')::uuid;
  END IF;
  IF change IS NOT NULL THEN
    SELECT project_id,ticket_id INTO project,ticket FROM factory.change WHERE id=projection.change;
  ELSIF conversation IS NOT NULL THEN
    SELECT project_id,ticket_id,CASE WHEN ticket_id IS NULL THEN created_by::text ELSE 'shared' END
      INTO project,ticket,audience FROM factory.ticket_conversation WHERE id=projection.conversation;
  ELSIF ticket IS NOT NULL THEN
    SELECT project_id INTO project FROM factory.ticket WHERE id=projection.ticket;
  END IF;
  IF TG_TABLE_NAME='agent_turn' AND ticket IS NULL THEN audience := record->>'created_by'; END IF;
  IF TG_TABLE_NAME='ticket_follow' THEN audience := record->>'user_id'; END IF;
  IF TG_TABLE_NAME='change_editing_request' THEN audience := record->>'owner_id'; END IF;
  IF audience='shared' AND (
    TG_TABLE_NAME='technical_design_revision' OR
    (TG_TABLE_NAME='conversation_entry' AND record->'payload'->>'visibility'='developer') OR
    (TG_TABLE_NAME='conversation_context' AND record->>'kind'='coding') OR
    (TG_TABLE_NAME='agent_turn' AND (
      record->'authority'->>'visibility'='developer' OR
      record->'authority'->>'mode'='build' OR
      record->'input'->>'intent' IN ('technical-planning','full-planning')))
  ) THEN audience := 'developer'; END IF;
  IF project IS NULL OR audience IS NULL THEN RETURN NULL; END IF;

  PERFORM factory.touch_read_version(project,'inbox',project,audience);
  IF TG_TABLE_NAME IN ('conversation_entry','conversation_context','ticket_conversation','agent_turn',
    'ticket','ticket_document_revision','requirement_revision','requirement_approval','technical_design_revision') THEN
    PERFORM factory.touch_read_version(project,'conversation',COALESCE(ticket,project),audience);
  END IF;
  IF ticket IS NOT NULL THEN
    PERFORM factory.touch_read_version(project,'ticket',ticket,audience);
  END IF;
  IF change IS NOT NULL THEN
    PERFORM factory.touch_read_version(project,'review',change,audience);
  END IF;
  IF TG_TABLE_NAME IN ('change','runtime_attempt','runtime_compute_wait','staging_preview','verification','candidate_review',
    'change_agent_session','change_writer','change_editing_decision',
    'coding_pause','delivery_approval','merge_operation','promotion_operation',
    'pull_request_operation','review_feedback','review_feedback_message','review_media','review_scenario','implementation_order','project_delivery_queue')
    OR (TG_TABLE_NAME='agent_turn' AND change IS NOT NULL) THEN
    PERFORM factory.touch_read_version(project,'lifecycle',project);
  END IF;
  IF TG_TABLE_NAME IN ('knowledge_generation','knowledge_page') THEN
    PERFORM factory.touch_read_version(project,'knowledge',project);
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION factory.invalidate_settings_reads() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  record jsonb := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  project uuid;
  library uuid;
  library_scope text;
  target_scope text;
BEGIN
  IF TG_OP='UPDATE' AND
    (to_jsonb(OLD)-ARRAY['updated_at','owner_expires_at','owner_token','received_window','received_count']) =
    (to_jsonb(NEW)-ARRAY['updated_at','owner_expires_at','owner_token','received_window','received_count'])
    THEN RETURN NULL;
  END IF;
  IF TG_TABLE_NAME='project_membership' THEN
    IF TG_OP='UPDATE' AND (OLD.role,OLD.manage_project) IS NOT DISTINCT FROM (NEW.role,NEW.manage_project)
      THEN RETURN NULL;
    END IF;
    project := (record->>'project_id')::uuid;
    -- Cached Settings capabilities must follow current Project authority even
    -- when the member remains authorized to read the same version rows.
    FOREACH target_scope IN ARRAY ARRAY['inputs','sources','releases'] LOOP
      PERFORM factory.touch_read_version(project,target_scope,project);
    END LOOP;
    RETURN NULL;
  ELSIF TG_TABLE_NAME IN ('monitoring_hook','monitoring_incident') THEN
    project := (record->>'project_id')::uuid;
    target_scope := 'inputs';
  ELSIF TG_TABLE_NAME IN ('project_release','release_access') THEN
    project := (record->>'project_id')::uuid;
    target_scope := 'releases';
  ELSIF TG_TABLE_NAME='release_attempt' THEN
    SELECT project_id INTO project FROM factory.project_release WHERE id=(record->>'release_id')::uuid;
    IF project IS NULL THEN RETURN NULL; END IF;
    target_scope := 'releases';
  ELSIF TG_TABLE_NAME='mcp_project_grant' THEN
    project := (record->>'project_id')::uuid;
    target_scope := 'sources';
  ELSIF TG_TABLE_NAME='mcp_choice' THEN
    IF record->>'scope'='personal' THEN RETURN NULL; END IF;
    IF record->>'scope'='project' THEN project := (record->>'context_id')::uuid; END IF;
    target_scope := 'sources';
  ELSE
    library := COALESCE((record->>'library_id')::uuid,(record->>'id')::uuid);
    IF TG_TABLE_NAME='mcp_library' THEN
      project := (record->>'project_id')::uuid;
      library_scope := record->>'scope';
    ELSE
      SELECT scope,project_id INTO library_scope,project FROM factory.mcp_library WHERE id=library;
    END IF;
    IF library_scope IS NULL OR library_scope='personal' THEN RETURN NULL; END IF;
    target_scope := 'sources';
  END IF;
  IF project IS NOT NULL THEN
    PERFORM factory.touch_read_version(project,target_scope,project);
  ELSE
    -- Shared Factory source changes invalidate authorized Project reads, not
    -- personal choices or private connection contents.
    FOR project IN SELECT id FROM factory.project ORDER BY id LOOP
      PERFORM factory.touch_read_version(project,target_scope,project);
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION factory.project_knowledge_page_outline() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    DELETE FROM factory.knowledge_page_outline WHERE id=OLD.id;
  ELSE
    INSERT INTO factory.knowledge_page_outline
      SELECT NEW.id,NEW.project_id,NEW.slug,NEW.title,NEW.parent_id,NEW.sort_order,NEW.icon,
        NEW.metadata_version,NEW.state,NEW.version,NEW.current_revision_id,NEW.created_at,NEW.updated_at
    ON CONFLICT (id) DO UPDATE SET
      project_id=EXCLUDED.project_id,slug=EXCLUDED.slug,title=EXCLUDED.title,parent_id=EXCLUDED.parent_id,sort_order=EXCLUDED.sort_order,
      icon=EXCLUDED.icon,metadata_version=EXCLUDED.metadata_version,state=EXCLUDED.state,
      version=EXCLUDED.version,current_revision_id=EXCLUDED.current_revision_id,updated_at=EXCLUDED.updated_at;
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION factory.touch_read_version(project uuid, target_scope text, resource uuid, target_audience text DEFAULT 'shared'::text) RETURNS void
    LANGUAGE plpgsql
    AS $_$
BEGIN
  IF $1 IS NULL OR $3 IS NULL OR NOT EXISTS(SELECT 1 FROM factory.project WHERE id=$1) THEN RETURN; END IF;
  -- Read projections lock last, after domain writes, and serialize all of a
  -- Project's audiences in one order. They never enter an admission lock chain.
  PERFORM pg_advisory_xact_lock(hashtextextended('read-version:'||$1::text,0));
  INSERT INTO factory.read_version(project_id,audience,scope,resource_id)
    VALUES ($1,$4,$2,$3)
  ON CONFLICT (project_id,audience,scope,resource_id)
    DO UPDATE SET revision=EXCLUDED.revision;
END;
$_$;
