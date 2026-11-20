-- Access routines. Run before Drizzle tables, with check_function_bodies disabled.

CREATE FUNCTION factory.check_session_access() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE access factory.account_access;
BEGIN
  SELECT * INTO access FROM factory.account_access WHERE user_id=NEW.user_id FOR SHARE;
  IF NOT FOUND OR access.disabled_at IS NOT NULL OR access.directory_disabled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Account access is disabled' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION factory.enqueue_access_revocation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE target uuid;
BEGIN
  IF TG_TABLE_NAME = 'account_access' THEN
    IF NEW.disabled_at IS NOT DISTINCT FROM OLD.disabled_at AND
       NEW.directory_disabled_at IS NOT DISTINCT FROM OLD.directory_disabled_at THEN
      RETURN NEW;
    END IF;
    target := NEW.user_id;
    IF NEW.disabled_at IS NOT NULL OR NEW.directory_disabled_at IS NOT NULL THEN
      DELETE FROM auth.session WHERE user_id=target;
    END IF;
  ELSE
    IF TG_OP = 'UPDATE' AND NEW.role = OLD.role AND NEW.manage_project = OLD.manage_project THEN
      RETURN NEW;
    END IF;
    target := COALESCE(NEW.user_id, OLD.user_id);
  END IF;
  INSERT INTO factory.access_revocation(user_id) VALUES(target)
    ON CONFLICT(user_id) DO UPDATE SET version=access_revocation.version+1,updated_at=now();
  PERFORM pg_notify('factory_access_revoked', target::text);
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE FUNCTION factory.enqueue_project_access() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO factory.access_revocation(user_id)
    SELECT user_id FROM factory.administrator
    UNION SELECT user_id FROM factory.project_membership WHERE project_id=NEW.id
    ON CONFLICT(user_id) DO UPDATE SET version=access_revocation.version+1,updated_at=now();
  PERFORM pg_notify('factory_access_revoked', NEW.id::text);
  RETURN NEW;
END $$;

CREATE FUNCTION factory.initialize_account_access() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO factory.account_access(user_id) VALUES (NEW.id);
  RETURN NEW;
END $$;
