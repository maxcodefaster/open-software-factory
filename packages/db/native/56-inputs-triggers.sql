-- Inputs triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER agent_turn_skill_cascade_delete AFTER DELETE ON factory.agent_turn FOR EACH ROW EXECUTE FUNCTION factory.cascade_deleted_agent_turn_skills();

CREATE TRIGGER mcp_library_identity_immutable BEFORE DELETE OR UPDATE ON factory.mcp_library FOR EACH ROW EXECUTE FUNCTION factory.guard_immutable_columns('mcp_library identity is immutable', 'no-delete', 'cover_key', 'cover_version', 'cover_updated_by');

CREATE TRIGGER mcp_revision_immutable BEFORE DELETE OR UPDATE ON factory.mcp_revision FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER model_connection_version_immutable BEFORE INSERT OR DELETE OR UPDATE ON factory.model_connection_version FOR EACH ROW EXECUTE FUNCTION factory.protect_model_connection_version();

CREATE TRIGGER skill_library_identity_immutable BEFORE DELETE OR UPDATE ON factory.skill_library FOR EACH ROW EXECUTE FUNCTION factory.guard_immutable_columns('skill_library identity is immutable', 'no-delete', 'cover_key', 'cover_version', 'cover_updated_by');

CREATE TRIGGER skill_revision_immutable BEFORE DELETE OR UPDATE ON factory.skill_revision FOR EACH ROW EXECUTE FUNCTION factory.guard_immutable_columns('skill_revision content is immutable', 'no-delete', 'published', 'published_updated_by', 'published_updated_at');
