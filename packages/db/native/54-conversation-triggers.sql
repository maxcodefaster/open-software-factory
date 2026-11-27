-- Conversation triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER conversation_context_identity BEFORE UPDATE ON factory.conversation_context FOR EACH ROW EXECUTE FUNCTION factory.guard_immutable_columns('Conversation identity and archived history are immutable', 'lock-on:archived_session', 'archived_session', 'transcript');

CREATE TRIGGER conversation_entry_no_update BEFORE DELETE OR UPDATE ON factory.conversation_entry FOR EACH ROW EXECUTE FUNCTION factory.prevent_conversation_entry_mutation();
