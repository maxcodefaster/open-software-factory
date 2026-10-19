BEGIN;

ALTER TABLE factory.change_agent_session
  ADD COLUMN native_session_confirmed_at timestamp with time zone,
  ADD CONSTRAINT change_agent_native_session_confirmation CHECK (
    native_session_confirmed_at IS NULL OR opencode_session_id IS NOT NULL
  );

-- An intended native ID is not evidence that OpenCode created the Session.
-- Preserve retained Sessions whose accepted work or pre-inference usage baseline
-- already proves that the native Session was observed successfully.
UPDATE factory.change_agent_session session
SET native_session_confirmed_at = now()
WHERE session.opencode_session_id IS NOT NULL
  AND (
    session.state IN ('working', 'waiting', 'committed')
    OR session.active_inbox_id IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM factory.change_agent_turn_intent intent
      JOIN factory.usage_operation operation ON operation.id = 'turn:' || intent.turn_id::text
      WHERE intent.change_id = session.change_id
        AND intent.session_id = session.opencode_session_id
        AND operation.engine = 'opencode'
    )
  );

INSERT INTO factory.schema_migration(version) VALUES (3);
COMMIT;
