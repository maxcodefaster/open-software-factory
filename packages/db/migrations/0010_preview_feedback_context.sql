BEGIN;
-- A Preview anchor remains useful when its optional DOM image cannot be rendered.
-- Recording annotations still require immutable media at the command boundary.
ALTER TABLE factory.review_feedback DROP CONSTRAINT review_feedback_check1;
ALTER TABLE factory.review_feedback ADD CONSTRAINT review_feedback_annotation_media
  CHECK (media_id IS NULL OR annotation IS NOT NULL);
INSERT INTO factory.schema_migration(version) VALUES (10);
COMMIT;
