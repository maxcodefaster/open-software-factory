-- Common triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER agent_untrashed_ticket BEFORE INSERT ON factory.agent_turn FOR EACH ROW EXECUTE FUNCTION factory.require_untrashed_ticket();

CREATE TRIGGER audit_event_immutable BEFORE UPDATE OR DELETE ON factory.audit_event FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER guard_operation BEFORE INSERT OR DELETE OR UPDATE ON factory.operation FOR EACH ROW EXECUTE FUNCTION factory.guard_operation();

CREATE TRIGGER installation_admission BEFORE INSERT ON factory.agent_turn FOR EACH ROW EXECUTE FUNCTION factory.require_installation_admission();

CREATE TRIGGER runtime_untrashed_ticket BEFORE INSERT ON factory.runtime_attempt FOR EACH ROW EXECUTE FUNCTION factory.require_untrashed_ticket();
