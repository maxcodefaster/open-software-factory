-- Runtime triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER runtime_attempt_identity_immutable BEFORE INSERT OR DELETE OR UPDATE ON factory.runtime_attempt FOR EACH ROW EXECUTE FUNCTION factory.protect_runtime_attempt_identity();

CREATE TRIGGER substrate_source_identity BEFORE INSERT OR DELETE OR UPDATE ON factory.substrate_source FOR EACH ROW EXECUTE FUNCTION factory.protect_substrate_source();

CREATE TRIGGER substrate_provision_identity BEFORE INSERT OR DELETE OR UPDATE ON factory.substrate_provision FOR EACH ROW EXECUTE FUNCTION factory.protect_substrate_provision();
