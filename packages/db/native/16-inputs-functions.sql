-- Inputs routines. Run before Drizzle tables, with check_function_bodies disabled.

CREATE FUNCTION factory.guard_loaded_skill() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM factory.agent_turn WHERE id = OLD.turn_id) THEN
    RETURN OLD;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Loaded Skill identities are immutable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM factory.agent_turn WHERE id = NEW.turn_id
    AND state IN ('dispatching', 'running') AND authority->'skillRevisionIds' ? NEW.revision_id::text) THEN
    RAISE EXCEPTION 'Loaded Skill revision was not admitted';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.guard_native_skill_intent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.skill_loading, NEW.skill_manifest, NEW.skill_attachments) IS DISTINCT FROM ROW(OLD.skill_loading, OLD.skill_manifest, OLD.skill_attachments) THEN
    RAISE EXCEPTION 'Admitted skill package is immutable';
  END IF;
  IF (NEW.skill_loading = 'native') != (NEW.skill_manifest IS NOT NULL) THEN RAISE EXCEPTION 'Native skill package is required'; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.protect_model_connection_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Model connection versions are immutable' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM factory.model_connection_write WHERE connection_id=NEW.connection_id
    AND base_version=NEW.version-1 AND provider=NEW.provider AND endpoint=NEW.endpoint
    AND secret_key=NEW.secret_key AND created_by=NEW.created_by AND state='write-intended') THEN
    RAISE EXCEPTION 'Model connection requires its exact write intent' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.protect_model_connection_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR OLD.state <> 'write-intended' OR NEW.state <> 'committed'
    OR (to_jsonb(NEW) - 'state' - 'committed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'committed_at')
    OR NEW.committed_at IS NULL THEN
    RAISE EXCEPTION 'Model connection write identity and outcome are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION factory.protect_model_role_probe() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP <> 'UPDATE' OR OLD.state <> 'probing' OR NEW.state NOT IN ('finished','uncertain')
    OR (to_jsonb(NEW) - 'state' - 'result' - 'finished_at') IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'result' - 'finished_at')
    OR NEW.finished_at IS NULL THEN
    RAISE EXCEPTION 'Model probe intent and result are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
