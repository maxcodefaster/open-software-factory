-- Usage routines. Run before Drizzle tables, with check_function_bodies disabled.

CREATE FUNCTION factory.guard_usage_entry() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN RAISE EXCEPTION 'Usage observations are immutable'; END;
$$;

CREATE FUNCTION factory.guard_usage_operation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (to_jsonb(NEW)-'settled_at'-'outcome') IS DISTINCT FROM (to_jsonb(OLD)-'settled_at'-'outcome')
    OR (OLD.settled_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Usage attribution and rate snapshots are immutable';
  END IF;
  RETURN NEW;
END;
$$;
