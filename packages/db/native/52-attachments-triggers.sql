-- Attachments triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER attachment_identity BEFORE UPDATE ON factory.attachment FOR EACH ROW EXECUTE FUNCTION factory.protect_attachment_identity();

CREATE TRIGGER attachment_reference_immutable BEFORE DELETE OR UPDATE ON factory.attachment_reference FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER attachment_storage_immutable BEFORE DELETE OR UPDATE ON factory.attachment_storage FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER attachment_turn_context_immutable BEFORE DELETE OR UPDATE ON factory.attachment_turn_context FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER conversation_attachments AFTER INSERT ON factory.conversation_entry FOR EACH ROW EXECUTE FUNCTION factory.bind_authored_attachments();

CREATE TRIGGER feedback_attachments AFTER INSERT ON factory.review_feedback_message FOR EACH ROW EXECUTE FUNCTION factory.bind_authored_attachments();

CREATE TRIGGER knowledge_attachments AFTER INSERT ON factory.knowledge_revision FOR EACH ROW EXECUTE FUNCTION factory.bind_authored_attachments();

CREATE TRIGGER requirement_attachments AFTER INSERT ON factory.requirement_revision FOR EACH ROW EXECUTE FUNCTION factory.bind_authored_attachments();

CREATE TRIGGER ticket_attachments AFTER INSERT ON factory.ticket FOR EACH ROW EXECUTE FUNCTION factory.bind_authored_attachments();

CREATE TRIGGER ticket_document_attachments AFTER INSERT ON factory.ticket_document_revision FOR EACH ROW EXECUTE FUNCTION factory.bind_authored_attachments();
