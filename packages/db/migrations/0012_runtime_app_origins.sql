BEGIN;

-- Existing intents retain NULL and therefore their exact original assignments.
ALTER TABLE factory.runtime_artifact_intent
  ADD COLUMN public_factory_origin text,
  ADD CONSTRAINT runtime_artifact_public_origin CHECK (
    public_factory_origin IS NULL OR (
      role<>'verification' AND octet_length(public_factory_origin)<=2048
      AND public_factory_origin ~ '^https?://[^/@?#[:space:]]+$'
    )
  );

INSERT INTO factory.schema_migration(version) VALUES(12);
COMMIT;
