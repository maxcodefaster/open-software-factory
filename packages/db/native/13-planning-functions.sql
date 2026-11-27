-- Planning routines. Run before Drizzle tables, with check_function_bodies disabled.

CREATE FUNCTION factory.guard_tree_hierarchy() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  has_cycle boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.project_id <> OLD.project_id) THEN
    RAISE EXCEPTION '% identity and Project are immutable', TG_ARGV[0] USING ERRCODE = '23514';
  END IF;
  PERFORM id FROM factory.project WHERE id = NEW.project_id FOR UPDATE;
  IF TG_TABLE_NAME = 'epic' THEN
    SELECT EXISTS (
      WITH RECURSIVE ancestors AS (
        SELECT id, parent_id FROM factory.epic WHERE id = NEW.parent_id AND project_id = NEW.project_id
        UNION
        SELECT parent.id, parent.parent_id FROM factory.epic parent
        JOIN ancestors child ON parent.id = child.parent_id WHERE parent.project_id = NEW.project_id
      )
      -- During a multi-row INSERT the closing Epic might not exist yet.
      SELECT 1 FROM ancestors WHERE id = NEW.id OR parent_id = NEW.id
    ) INTO has_cycle;
  ELSE
    SELECT EXISTS (
      WITH RECURSIVE ancestors AS (
        SELECT id, parent_id FROM factory.knowledge_page WHERE id = NEW.parent_id AND project_id = NEW.project_id
        UNION
        SELECT parent.id, parent.parent_id FROM factory.knowledge_page parent
        JOIN ancestors child ON parent.id = child.parent_id WHERE parent.project_id = NEW.project_id
      )
      SELECT 1 FROM ancestors WHERE id = NEW.id OR parent_id = NEW.id
    ) INTO has_cycle;
  END IF;
  IF has_cycle THEN
    RAISE EXCEPTION '% cannot contain a cycle', TG_ARGV[1] USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

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
      JOIN factory.operation merge ON merge.kind = 'delivery.merge'
        AND merge.scope_type = 'change' AND merge.scope_id = change.id::text
        AND merge.state = 'succeeded'
        AND merge.result->>'mergeSha' = merge.payload->>'commitSha'
      JOIN factory.delivery_approval approval ON approval.id::text = merge.payload->>'approvalId'
        AND approval.change_id = change.id AND approval.commit_sha = merge.payload->>'commitSha'
      JOIN factory.verification verification ON verification.id = approval.verification_id
        AND verification.change_id = change.id AND verification.commit_sha = merge.payload->>'commitSha'
        AND verification.state = 'succeeded'
      JOIN factory.operation promotion ON promotion.kind = 'delivery.promotion'
        AND promotion.scope_type = 'change' AND promotion.scope_id = change.id::text
        AND promotion.payload->>'projectId' = edge.project_id::text
        AND promotion.payload->>'commitSha' = merge.payload->>'commitSha'
        AND promotion.state = 'succeeded'
      WHERE change.ticket_id = prerequisite.id AND change.project_id = edge.project_id
        AND change.state = 'delivered'
    ) AS delivered
  FROM factory.ticket_dependency edge
  JOIN factory.ticket prerequisite ON prerequisite.id = edge.prerequisite_id AND prerequisite.project_id = edge.project_id
  WHERE edge.project_id = project AND edge.ticket_id = dependent
  ORDER BY prerequisite.title, prerequisite.id
$$;
