-- Run after all Drizzle tables. Retain the current-promotion projection and invoker security.

CREATE VIEW factory.current_promotion WITH (security_invoker='true') AS
 SELECT DISTINCT ON (scope_id) id,
    scope_id::uuid AS change_id,
    (payload->>'projectId')::uuid AS project_id,
    payload->>'commitSha' AS commit_sha,
    NULLIF(payload->>'previousRuntimeAttemptId', '')::uuid AS previous_runtime_attempt_id,
    NULLIF(payload->>'replacementRuntimeAttemptId', '')::uuid AS replacement_runtime_attempt_id,
    state,
    error AS last_error,
    created_at AS requested_at,
    updated_at,
    completed_at,
    (payload->>'ordinal')::integer AS ordinal,
    NULLIF(payload->>'supersedesId', '')::uuid AS supersedes_id,
    NULLIF(payload->>'retryCommandId', '')::uuid AS retry_command_id
   FROM factory.operation
  WHERE kind = 'delivery.promotion' AND scope_type = 'change'
  ORDER BY scope_id, (payload->>'ordinal')::integer DESC;
