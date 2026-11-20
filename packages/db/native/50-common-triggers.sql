-- Common triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER agent_untrashed_ticket BEFORE INSERT ON factory.agent_turn FOR EACH ROW EXECUTE FUNCTION factory.require_untrashed_ticket();

CREATE TRIGGER installation_admission BEFORE INSERT ON factory.agent_turn FOR EACH ROW EXECUTE FUNCTION factory.require_installation_admission();

CREATE TRIGGER installation_admission BEFORE INSERT ON factory.knowledge_generation FOR EACH ROW EXECUTE FUNCTION factory.require_installation_admission();

CREATE TRIGGER installation_admission BEFORE INSERT ON factory.model_role_probe FOR EACH ROW EXECUTE FUNCTION factory.require_installation_admission();

CREATE TRIGGER installation_admission BEFORE INSERT ON factory.project_setup_inspection FOR EACH ROW EXECUTE FUNCTION factory.require_installation_admission();

CREATE TRIGGER runtime_untrashed_ticket BEFORE INSERT ON factory.runtime_attempt FOR EACH ROW EXECUTE FUNCTION factory.require_untrashed_ticket();
