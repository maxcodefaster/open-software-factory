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
DECLARE targets uuid[]; notify_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'project' THEN
    SELECT ARRAY(
      SELECT user_id FROM factory.administrator
      UNION SELECT user_id FROM factory.project_membership WHERE project_id=NEW.id
    ) INTO targets;
    notify_id := NEW.id;
  ELSIF TG_TABLE_NAME = 'account_access' THEN
    IF NEW.disabled_at IS NOT DISTINCT FROM OLD.disabled_at AND
       NEW.directory_disabled_at IS NOT DISTINCT FROM OLD.directory_disabled_at THEN
      RETURN NEW;
    END IF;
    notify_id := NEW.user_id;
    targets := ARRAY[notify_id];
    IF NEW.disabled_at IS NOT NULL OR NEW.directory_disabled_at IS NOT NULL THEN
      DELETE FROM auth.session WHERE user_id=notify_id;
    END IF;
  ELSE
    IF TG_OP = 'UPDATE' AND NEW.role = OLD.role AND NEW.manage_project = OLD.manage_project THEN
      RETURN NEW;
    END IF;
    notify_id := COALESCE(NEW.user_id, OLD.user_id);
    targets := ARRAY[notify_id];
  END IF;
  INSERT INTO factory.operation(
    id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload,updated_at)
  SELECT gen_random_uuid(),'access.revocation','user',user_id::text,
    'access.revocation:'||user_id::text,NULL,'pending',
    jsonb_build_object('userId',user_id::text,'version',1,'processedVersion',0),now()
  FROM unnest(targets) AS user_id
  ON CONFLICT(idempotency_key) DO UPDATE SET
    state='pending',
    payload=jsonb_set(factory.operation.payload,'{version}',
      to_jsonb(((factory.operation.payload->>'version')::bigint+1))),
    completed_at=NULL,
    updated_at=now();
  PERFORM pg_notify('factory_access_revoked', notify_id::text);
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE FUNCTION factory.initialize_account_access() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO factory.account_access(user_id) VALUES (NEW.id);
  RETURN NEW;
END $$;
