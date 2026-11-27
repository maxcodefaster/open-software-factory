-- Delivery triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER candidate_review_guard BEFORE UPDATE ON factory.candidate_review FOR EACH ROW EXECUTE FUNCTION factory.guard_candidate_review();

CREATE TRIGGER delivery_approval_immutable BEFORE DELETE OR UPDATE ON factory.delivery_approval FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER monitoring_policy_immutable BEFORE DELETE OR UPDATE ON factory.monitoring_policy FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER project_release_identity BEFORE UPDATE ON factory.project_release FOR EACH ROW EXECUTE FUNCTION factory.protect_project_release_identity();
