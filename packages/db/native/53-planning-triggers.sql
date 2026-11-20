-- Planning triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER epic_confirmation_immutable BEFORE DELETE OR UPDATE ON factory.epic_confirmation FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER epic_hierarchy_guard BEFORE INSERT OR UPDATE ON factory.epic FOR EACH ROW EXECUTE FUNCTION factory.guard_epic_hierarchy();

CREATE TRIGGER knowledge_hierarchy_guard BEFORE INSERT OR UPDATE OF id, project_id, parent_id ON factory.knowledge_page FOR EACH ROW EXECUTE FUNCTION factory.guard_knowledge_hierarchy();

CREATE TRIGGER knowledge_revision_immutable BEFORE DELETE OR UPDATE ON factory.knowledge_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER project_repository_intent_guard BEFORE UPDATE ON factory.project_repository_intent FOR EACH ROW EXECUTE FUNCTION factory.guard_project_repository_intent();

CREATE TRIGGER requirement_approval_immutable BEFORE DELETE OR UPDATE ON factory.requirement_approval FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER requirement_revision_immutable BEFORE DELETE OR UPDATE ON factory.requirement_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER setup_confirmation_immutable BEFORE DELETE OR UPDATE ON factory.project_setup_confirmation FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER setup_inspection_guard BEFORE UPDATE ON factory.project_setup_inspection FOR EACH ROW EXECUTE FUNCTION factory.guard_setup_inspection();

CREATE TRIGGER technical_design_revision_immutable BEFORE DELETE OR UPDATE ON factory.technical_design_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER ticket_dependency_guard BEFORE INSERT OR UPDATE ON factory.ticket_dependency FOR EACH ROW EXECUTE FUNCTION factory.guard_ticket_dependency();

CREATE TRIGGER ticket_document_revision_immutable BEFORE DELETE OR UPDATE ON factory.ticket_document_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER ticket_follow_up_immutable BEFORE DELETE OR UPDATE ON factory.ticket_follow_up FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();
