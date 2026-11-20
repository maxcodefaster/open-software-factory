-- Conversation triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER conversation_context_identity BEFORE UPDATE ON factory.conversation_context FOR EACH ROW EXECUTE FUNCTION factory.guard_conversation_context();

CREATE TRIGGER conversation_entry_no_update BEFORE DELETE OR UPDATE ON factory.conversation_entry FOR EACH ROW EXECUTE FUNCTION factory.prevent_conversation_entry_mutation();

CREATE TRIGGER ticket_conversation_coding_context BEFORE INSERT OR UPDATE OF active_coding_context_id ON factory.ticket_conversation FOR EACH ROW EXECUTE FUNCTION factory.guard_active_coding_context();

CREATE TRIGGER ticket_conversation_project_guard BEFORE INSERT OR UPDATE OF project_id, ticket_id ON factory.ticket_conversation FOR EACH ROW EXECUTE FUNCTION factory.validate_ticket_conversation_project();
