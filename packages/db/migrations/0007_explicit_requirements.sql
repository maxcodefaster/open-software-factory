BEGIN;

-- Planning no longer commissions an Interview. Keep the old entry records as
-- history, without converting them into new model requests. An existing Agent
-- Turn is already admitted work and retains its normal recovery and outcome.
UPDATE factory.requirements_entry_intent intent
SET admitted_at=turn.created_at
FROM factory.agent_turn turn
WHERE turn.command_id=intent.command_id AND intent.admitted_at IS NULL;

UPDATE factory.requirements_entry_intent
SET failure='Automatic Requirements entry is retired. The Ticket is retained; ask AI to clarify explicitly if needed.'
WHERE admitted_at IS NULL AND failure IS NULL;

INSERT INTO factory.schema_migration(version) VALUES (7);
COMMIT;
