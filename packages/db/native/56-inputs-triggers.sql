-- Inputs triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER agent_turn_skill_guard BEFORE INSERT OR DELETE OR UPDATE ON factory.agent_turn_skill FOR EACH ROW EXECUTE FUNCTION factory.guard_loaded_skill();

CREATE TRIGGER mcp_access_decision_immutable BEFORE DELETE OR UPDATE ON factory.mcp_access_decision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER mcp_library_identity_immutable BEFORE DELETE OR UPDATE ON factory.mcp_library FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER mcp_observation_immutable BEFORE DELETE OR UPDATE ON factory.mcp_observation FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER mcp_policy_approval_immutable BEFORE DELETE OR UPDATE ON factory.mcp_policy_approval FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER mcp_revision_immutable BEFORE DELETE OR UPDATE ON factory.mcp_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER model_connection_version_immutable BEFORE INSERT OR DELETE OR UPDATE ON factory.model_connection_version FOR EACH ROW EXECUTE FUNCTION factory.protect_model_connection_version();

CREATE TRIGGER model_connection_write_guard BEFORE DELETE OR UPDATE ON factory.model_connection_write FOR EACH ROW EXECUTE FUNCTION factory.protect_model_connection_write();

CREATE TRIGGER model_role_probe_guard BEFORE DELETE OR UPDATE ON factory.model_role_probe FOR EACH ROW EXECUTE FUNCTION factory.protect_model_role_probe();

CREATE TRIGGER native_skill_intent_guard BEFORE INSERT OR UPDATE ON factory.change_agent_turn_intent FOR EACH ROW EXECUTE FUNCTION factory.guard_native_skill_intent();

CREATE TRIGGER skill_library_identity_immutable BEFORE DELETE OR UPDATE ON factory.skill_library FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER skill_library_revision_immutable BEFORE DELETE OR UPDATE ON factory.skill_library_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER skill_revision_immutable BEFORE DELETE OR UPDATE ON factory.skill_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();
