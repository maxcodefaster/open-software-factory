-- Verification triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER verification_job_binding BEFORE UPDATE ON factory.verification FOR EACH ROW EXECUTE FUNCTION factory.protect_verification_job_binding();
