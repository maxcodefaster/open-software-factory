BEGIN;

-- Runtime-only values cannot affect the isolated image build. Missing or
-- uncommitted secret metadata is not evidence that a build is credential-free.
CREATE FUNCTION factory.image_build_is_public(secret_key text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT $1 IS NULL OR EXISTS (
    SELECT 1 FROM factory.environment_write write
    WHERE write.secret_key=$1 AND write.state='committed'
      AND write.manifest->'registries'='[]'::jsonb
      AND jsonb_typeof(write.manifest->'variables')='array'
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(write.manifest->'variables') variable
        WHERE variable->'build' IS DISTINCT FROM 'false'::jsonb
      )
  )
$$;

INSERT INTO factory.schema_migration(version) VALUES(8);
COMMIT;
