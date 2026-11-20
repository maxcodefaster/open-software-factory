-- Coding triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER workspace_submission_intent BEFORE INSERT OR UPDATE ON factory.workspace_submission
    FOR EACH ROW EXECUTE FUNCTION factory.protect_workspace_submission();

CREATE TRIGGER agent_turn_guard BEFORE INSERT OR UPDATE ON factory.agent_turn FOR EACH ROW EXECUTE FUNCTION factory.guard_agent_turn();

CREATE TRIGGER agent_turn_mcp_immutable BEFORE DELETE OR UPDATE ON factory.agent_turn_mcp FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER branch_operation_immutable BEFORE UPDATE ON factory.branch_create_operation FOR EACH ROW EXECUTE FUNCTION factory.protect_branch_operation();

CREATE TRIGGER build_browser_ordinal_guard BEFORE INSERT OR UPDATE ON factory.build_browser_session FOR EACH ROW EXECUTE FUNCTION factory.guard_build_browser_ordinal();

CREATE TRIGGER build_browser_session_guard BEFORE INSERT OR UPDATE ON factory.build_browser_session FOR EACH ROW EXECUTE FUNCTION factory.guard_build_browser_session();

CREATE TRIGGER change_agent_turn_intent_guard BEFORE INSERT OR UPDATE ON factory.change_agent_turn_intent FOR EACH ROW EXECUTE FUNCTION factory.guard_change_agent_turn_intent();

CREATE TRIGGER change_editing_decision_immutable BEFORE DELETE OR UPDATE ON factory.change_editing_decision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER change_identity_immutable BEFORE UPDATE ON factory.change FOR EACH ROW EXECUTE FUNCTION factory.protect_change_identity();

CREATE TRIGGER change_prerequisites_guard BEFORE INSERT ON factory.change FOR EACH ROW EXECUTE FUNCTION factory.guard_change_prerequisites();

CREATE TRIGGER implementation_scope BEFORE UPDATE ON factory.implementation_order FOR EACH ROW EXECUTE FUNCTION factory.protect_implementation_order();

CREATE TRIGGER initialize_change_writer AFTER INSERT ON factory.change FOR EACH ROW EXECUTE FUNCTION factory.initialize_change_writer();

CREATE TRIGGER integration_intent BEFORE UPDATE ON factory.change_commit_operation FOR EACH ROW EXECUTE FUNCTION factory.protect_integration_intent();

CREATE TRIGGER personal_git_operation_immutable BEFORE DELETE OR UPDATE ON factory.personal_git_operation FOR EACH ROW EXECUTE FUNCTION factory.protect_personal_git_operation();

CREATE TRIGGER session_archive_identity BEFORE INSERT OR DELETE OR UPDATE ON factory.session_archive FOR EACH ROW EXECUTE FUNCTION factory.protect_session_archive();

CREATE TRIGGER ticket_execution_revision BEFORE INSERT ON factory.runtime_attempt FOR EACH ROW EXECUTE FUNCTION factory.require_ticket_execution_revision();
