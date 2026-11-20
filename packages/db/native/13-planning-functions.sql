-- Planning routines. Run before Drizzle tables, with check_function_bodies disabled.

CREATE FUNCTION factory.assign_project_background() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.desktop_background_key IS NULL THEN
    -- Both registration paths and concurrent creates share one allocation boundary.
    PERFORM pg_advisory_xact_lock(hashtextextended('factory-project-background-allocation',0));
    SELECT catalogue.key INTO NEW.desktop_background_key
    FROM unnest(ARRAY[
      'river-landscape','the-harvesters','mountainous-landscape',
      'gulf-of-marseille','scene-on-the-ice','moonlit-landscape'
    ]) AS catalogue(key)
    LEFT JOIN factory.project project ON project.desktop_background_key=catalogue.key
      AND (
        EXISTS(SELECT 1 FROM factory.administrator WHERE user_id=NEW.created_by)
        OR EXISTS(SELECT 1 FROM factory.project_membership
          WHERE project_id=project.id AND user_id=NEW.created_by)
      )
    GROUP BY catalogue.key
    ORDER BY count(project.id), random()
    LIMIT 1;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION factory.guard_epic_hierarchy() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.project_id <> OLD.project_id) THEN
    RAISE EXCEPTION 'Epic identity and Project are immutable' USING ERRCODE = '23514';
  END IF;
  PERFORM id FROM factory.project WHERE id = NEW.project_id FOR UPDATE;
  IF EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_id FROM factory.epic WHERE id = NEW.parent_id AND project_id = NEW.project_id
      UNION
      SELECT parent.id, parent.parent_id FROM factory.epic parent
      JOIN ancestors child ON parent.id = child.parent_id WHERE parent.project_id = NEW.project_id
    )
    -- During a multi-row INSERT the closing Epic might not exist yet.
    SELECT 1 FROM ancestors WHERE id = NEW.id OR parent_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'Epic hierarchy cannot contain a cycle' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.guard_knowledge_hierarchy() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id) THEN
    RAISE EXCEPTION 'Wiki page identity and Project are immutable' USING ERRCODE='23514';
  END IF;
  PERFORM id FROM factory.project WHERE id=NEW.project_id FOR UPDATE;
  IF EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT id,parent_id FROM factory.knowledge_page WHERE id=NEW.parent_id AND project_id=NEW.project_id
      UNION
      SELECT parent.id,parent.parent_id FROM factory.knowledge_page parent
      JOIN ancestors child ON parent.id=child.parent_id WHERE parent.project_id=NEW.project_id
    ) SELECT 1 FROM ancestors WHERE id=NEW.id OR parent_id=NEW.id
  ) THEN
    RAISE EXCEPTION 'Wiki pages cannot contain a cycle' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.guard_project_repository_intent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (NEW.command_id,NEW.setup_id,NEW.user_id,NEW.project_id,NEW.name,NEW.slug,NEW.kind,
      NEW.source_url,NEW.credential_key,NEW.fingerprint,NEW.created_at)
    IS DISTINCT FROM (OLD.command_id,OLD.setup_id,OLD.user_id,OLD.project_id,OLD.name,OLD.slug,OLD.kind,
      OLD.source_url,OLD.credential_key,OLD.fingerprint,OLD.created_at)
    OR (OLD.state='committed' AND (NEW.state,NEW.default_branch,NEW.completed_at)
      IS DISTINCT FROM (OLD.state,OLD.default_branch,OLD.completed_at))
    OR (OLD.credential_removed_at IS NOT NULL AND NEW.credential_removed_at IS DISTINCT FROM OLD.credential_removed_at)
  THEN RAISE EXCEPTION 'Project repository intent is immutable'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION factory.guard_setup_inspection() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (NEW.id,NEW.project_id,NEW.source_commit,NEW.model_id,NEW.connection_id,NEW.connection_version,NEW.created_by,NEW.created_at,NEW.parent_id,NEW.answers)
    IS DISTINCT FROM (OLD.id,OLD.project_id,OLD.source_commit,OLD.model_id,OLD.connection_id,OLD.connection_version,OLD.created_by,OLD.created_at,OLD.parent_id,OLD.answers)
    OR (OLD.output IS NOT NULL AND NEW.output IS DISTINCT FROM OLD.output)
    OR (OLD.state IN ('confirmed','complete') AND NEW.state<>OLD.state)
  THEN RAISE EXCEPTION 'Setup inspection intent and published proposal are immutable'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION factory.guard_ticket_dependency() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Remove and add a dependency explicitly; its identity is immutable' USING ERRCODE = '23514';
  END IF;
  -- A graph lock avoids locking the Project row, which Change creation references after its Ticket lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('ticket-dependencies:' || NEW.project_id::text, 0));
  PERFORM id FROM factory.ticket WHERE id = NEW.ticket_id AND project_id = NEW.project_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM factory.change WHERE ticket_id = NEW.ticket_id) THEN
    RAISE EXCEPTION 'Implementation has already been admitted. Create a new Ticket for new prerequisites.' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    WITH RECURSIVE prerequisites AS (
      SELECT prerequisite_id FROM factory.ticket_dependency
        WHERE ticket_id = NEW.prerequisite_id AND project_id = NEW.project_id
      UNION
      SELECT edge.prerequisite_id FROM factory.ticket_dependency edge
        JOIN prerequisites previous ON edge.ticket_id = previous.prerequisite_id
        WHERE edge.project_id = NEW.project_id
    )
    SELECT 1 FROM prerequisites WHERE prerequisite_id = NEW.ticket_id
  ) THEN
    RAISE EXCEPTION 'Ticket dependencies cannot contain a cycle' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.research_vector(title text, body text) RETURNS tsvector
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
    SELECT setweight(to_tsvector('simple',coalesce(title,'')),'A') ||
      setweight(to_tsvector('simple',coalesce(body,'')),'B');
  $$;

CREATE FUNCTION factory.ticket_prerequisites(project uuid, dependent uuid) RETURNS TABLE(prerequisite_id uuid, title text, state factory.ticket_state, delivered boolean)
    LANGUAGE sql STABLE
    AS $$
  SELECT prerequisite.id, prerequisite.title, prerequisite.state,
    prerequisite.state = 'done' AND EXISTS (
      SELECT 1 FROM factory.change change
      JOIN factory.merge_operation merge ON merge.change_id = change.id
        AND merge.state = 'succeeded' AND merge.observed_default_sha = merge.commit_sha
      JOIN factory.delivery_approval approval ON approval.id = merge.delivery_approval_id
        AND approval.change_id = change.id AND approval.commit_sha = merge.commit_sha
      JOIN factory.verification verification ON verification.id = approval.verification_id
        AND verification.change_id = change.id AND verification.commit_sha = merge.commit_sha
        AND verification.state = 'succeeded'
      JOIN factory.promotion_operation promotion ON promotion.change_id = change.id
        AND promotion.project_id = edge.project_id AND promotion.commit_sha = merge.commit_sha
        AND promotion.state = 'succeeded'
      WHERE change.ticket_id = prerequisite.id AND change.project_id = edge.project_id
        AND change.state = 'delivered'
    ) AS delivered
  FROM factory.ticket_dependency edge
  JOIN factory.ticket prerequisite ON prerequisite.id = edge.prerequisite_id AND prerequisite.project_id = edge.project_id
  WHERE edge.project_id = project AND edge.ticket_id = dependent
  ORDER BY prerequisite.title, prerequisite.id
$$;
