-- Run after all Drizzle tables. Retain the current-promotion projection and invoker security.

CREATE VIEW factory.current_promotion WITH (security_invoker='true') AS
 SELECT DISTINCT ON (change_id) id,
    change_id,
    project_id,
    commit_sha,
    previous_runtime_attempt_id,
    replacement_runtime_attempt_id,
    state,
    last_error,
    requested_at,
    updated_at,
    completed_at,
    ordinal,
    supersedes_id,
    retry_command_id
   FROM factory.promotion_operation
  ORDER BY change_id, ordinal DESC;
