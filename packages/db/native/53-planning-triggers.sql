-- Planning triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER epic_hierarchy_guard BEFORE INSERT OR UPDATE OF id, project_id, parent_id ON factory.epic FOR EACH ROW EXECUTE FUNCTION factory.guard_tree_hierarchy('Epic', 'Epic hierarchy');

CREATE TRIGGER knowledge_hierarchy_guard BEFORE INSERT OR UPDATE OF id, project_id, parent_id ON factory.knowledge_page FOR EACH ROW EXECUTE FUNCTION factory.guard_tree_hierarchy('Wiki page', 'Wiki pages');

CREATE TRIGGER knowledge_revision_immutable BEFORE DELETE OR UPDATE ON factory.knowledge_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER requirement_approval_immutable BEFORE DELETE OR UPDATE ON factory.requirement_approval FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER requirement_revision_immutable BEFORE DELETE OR UPDATE ON factory.requirement_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER technical_design_revision_immutable BEFORE DELETE OR UPDATE ON factory.technical_design_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER ticket_dependency_guard BEFORE INSERT OR UPDATE ON factory.ticket_dependency FOR EACH ROW EXECUTE FUNCTION factory.guard_ticket_dependency();

CREATE TRIGGER ticket_document_revision_immutable BEFORE DELETE OR UPDATE ON factory.ticket_document_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();
