-- Verification triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER substrate_verification_identity BEFORE INSERT OR DELETE OR UPDATE ON factory.substrate_verification FOR EACH ROW EXECUTE FUNCTION factory.protect_substrate_verification();

CREATE TRIGGER verification_job_binding BEFORE UPDATE ON factory.verification FOR EACH ROW EXECUTE FUNCTION factory.protect_verification_job_binding();
