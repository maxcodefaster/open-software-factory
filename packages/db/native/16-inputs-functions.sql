-- Inputs routines. Run before Drizzle tables, with check_function_bodies disabled.

CREATE FUNCTION factory.cascade_deleted_agent_turn_skills() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  DELETE FROM factory.operation
  WHERE kind = 'coding.turn_skill' AND scope_type = 'agent_turn' AND scope_id = OLD.id::text;
  RETURN OLD;
END;
$$;

CREATE FUNCTION factory.protect_model_connection_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Model connection versions are immutable' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM factory.operation WHERE kind='models.connection_write'
    AND scope_type='connection' AND scope_id=NEW.connection_id::text
    AND (payload->>'baseVersion')::bigint=NEW.version-1
    AND payload->>'provider'=NEW.provider AND payload->>'endpoint'=NEW.endpoint
    AND payload->>'secretKey'=NEW.secret_key AND created_by=NEW.created_by
    AND state='write-intended') THEN
    RAISE EXCEPTION 'Model connection requires its exact write intent' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
