-- Coding triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER agent_turn_guard BEFORE INSERT OR UPDATE ON factory.agent_turn FOR EACH ROW EXECUTE FUNCTION factory.guard_agent_turn();

CREATE TRIGGER build_browser_session_guard BEFORE INSERT OR UPDATE ON factory.build_browser_session FOR EACH ROW EXECUTE FUNCTION factory.guard_build_browser_session();

CREATE TRIGGER change_agent_turn_intent_guard BEFORE INSERT OR UPDATE ON factory.change_agent_turn_intent FOR EACH ROW EXECUTE FUNCTION factory.guard_change_agent_turn_intent();

CREATE TRIGGER change_identity_immutable BEFORE UPDATE ON factory.change FOR EACH ROW EXECUTE FUNCTION factory.guard_immutable_columns('Change identity and source intent are immutable', 'update-only', 'state', 'version', 'cancel_requested_at', 'cancelled_at', 'failure', 'runtime_attempt_id', 'delivery_waiting_sha', 'delivery_waiting_policy_id');

CREATE TRIGGER change_prerequisites_guard BEFORE INSERT ON factory.change FOR EACH ROW EXECUTE FUNCTION factory.guard_change_prerequisites();

CREATE TRIGGER initialize_change_writer AFTER INSERT ON factory.change FOR EACH ROW EXECUTE FUNCTION factory.initialize_change_writer();

CREATE TRIGGER integration_intent BEFORE UPDATE ON factory.change_commit_operation FOR EACH ROW EXECUTE FUNCTION factory.guard_immutable_columns('Commit intent and integrated source are immutable', 'update-only', 'commit_sha', 'observed_remote_sha', 'state', 'last_error', 'updated_at', 'completed_at');

CREATE TRIGGER ticket_execution_revision BEFORE INSERT ON factory.runtime_attempt FOR EACH ROW EXECUTE FUNCTION factory.require_ticket_execution_revision();
