-- Runtime triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER developer_ide_intent_immutable BEFORE UPDATE ON factory.developer_ide FOR EACH ROW EXECUTE FUNCTION factory.protect_developer_ide_intent();

CREATE TRIGGER development_workspace_identity_immutable BEFORE UPDATE ON factory.development_workspace FOR EACH ROW EXECUTE FUNCTION factory.protect_development_workspace_identity();

CREATE TRIGGER project_image_preparation_immutable BEFORE UPDATE ON factory.project_image_preparation FOR EACH ROW EXECUTE FUNCTION factory.protect_project_image_preparation();

CREATE TRIGGER repository_mirror_command_identity BEFORE UPDATE ON factory.repository_mirror_command FOR EACH ROW EXECUTE FUNCTION factory.protect_repository_mirror_command();

CREATE TRIGGER runtime_attempt_identity_immutable BEFORE UPDATE ON factory.runtime_attempt FOR EACH ROW EXECUTE FUNCTION factory.protect_runtime_attempt_identity();

CREATE TRIGGER runtime_environment_intent_immutable BEFORE INSERT OR UPDATE ON factory.runtime_environment_intent FOR EACH ROW EXECUTE FUNCTION factory.protect_runtime_environment_intent();

CREATE CONSTRAINT TRIGGER substrate_attempt_binding AFTER INSERT OR UPDATE ON factory.runtime_attempt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factory.require_substrate_binding();

CREATE TRIGGER substrate_binding_identity BEFORE INSERT OR DELETE OR UPDATE ON factory.substrate_binding FOR EACH ROW EXECUTE FUNCTION factory.protect_substrate_binding();

CREATE TRIGGER substrate_prebuild_identity BEFORE INSERT OR DELETE OR UPDATE ON factory.substrate_prebuild FOR EACH ROW EXECUTE FUNCTION factory.protect_substrate_prebuild();

CREATE TRIGGER substrate_source_identity BEFORE INSERT OR DELETE OR UPDATE ON factory.substrate_source FOR EACH ROW EXECUTE FUNCTION factory.protect_substrate_source();

CREATE TRIGGER substrate_worker_capacity_identity BEFORE INSERT OR DELETE OR UPDATE ON factory.substrate_worker_capacity FOR EACH ROW EXECUTE FUNCTION factory.protect_substrate_worker_capacity();

CREATE TRIGGER substrate_workspace_identity BEFORE INSERT OR DELETE OR UPDATE ON factory.substrate_workspace FOR EACH ROW EXECUTE FUNCTION factory.protect_substrate_workspace();

CREATE TRIGGER substrate_input_stop_identity BEFORE INSERT OR UPDATE OR DELETE
ON factory.substrate_input_stop FOR EACH ROW EXECUTE FUNCTION factory.protect_substrate_input_stop();

CREATE TRIGGER substrate_actor_rpc_identity BEFORE INSERT OR UPDATE OR DELETE
ON factory.substrate_actor_rpc FOR EACH ROW EXECUTE FUNCTION factory.protect_substrate_actor_rpc();

CREATE TRIGGER substrate_capacity_installation_identity BEFORE INSERT OR UPDATE OR DELETE
ON factory.substrate_capacity_installation
FOR EACH ROW EXECUTE FUNCTION factory.protect_substrate_capacity_installation();
