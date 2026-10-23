BEGIN;

ALTER TABLE factory.project ADD COLUMN desktop_background_key text
  CHECK (desktop_background_key IN (
    'river-landscape','the-harvesters','mountainous-landscape',
    'gulf-of-marseille','scene-on-the-ice','moonlit-landscape'
  ));

-- Preserve the creator's existing choice when moving from personal to shared backgrounds.
UPDATE factory.project project SET desktop_background_key = COALESCE(
  (SELECT desktop_background_key FROM factory.user_ui_preference WHERE user_id=project.created_by),
  'river-landscape'
);
ALTER TABLE factory.project ALTER COLUMN desktop_background_key SET NOT NULL;

CREATE FUNCTION factory.assign_project_background() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER project_background_assignment BEFORE INSERT ON factory.project
  FOR EACH ROW EXECUTE FUNCTION factory.assign_project_background();

INSERT INTO factory.schema_migration(version) VALUES(16);
COMMIT;
