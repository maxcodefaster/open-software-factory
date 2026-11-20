-- Delivery triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER candidate_review_guard BEFORE UPDATE ON factory.candidate_review FOR EACH ROW EXECUTE FUNCTION factory.guard_candidate_review();

CREATE TRIGGER delivery_approval_immutable BEFORE DELETE OR UPDATE ON factory.delivery_approval FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER delivery_policy_identity BEFORE UPDATE ON factory.project_delivery_policy FOR EACH ROW EXECUTE FUNCTION factory.protect_delivery_policy();

CREATE TRIGGER monitoring_command_immutable BEFORE DELETE OR UPDATE ON factory.monitoring_command FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER monitoring_evidence_immutable BEFORE DELETE OR UPDATE ON factory.monitoring_evidence FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER monitoring_policy_immutable BEFORE DELETE OR UPDATE ON factory.monitoring_policy FOR EACH ROW EXECUTE FUNCTION factory.reject_mutation();

CREATE TRIGGER project_release_identity BEFORE UPDATE ON factory.project_release FOR EACH ROW EXECUTE FUNCTION factory.protect_project_release_identity();

CREATE TRIGGER promotion_operation_protection BEFORE INSERT OR UPDATE ON factory.promotion_operation FOR EACH ROW EXECUTE FUNCTION factory.protect_promotion_operation();

CREATE TRIGGER pull_request_operation_immutable BEFORE UPDATE ON factory.pull_request_operation FOR EACH ROW EXECUTE FUNCTION factory.protect_pull_request_operation();

CREATE TRIGGER release_attempt_identity BEFORE UPDATE ON factory.release_attempt FOR EACH ROW EXECUTE FUNCTION factory.protect_release_attempt_identity();

CREATE TRIGGER review_media_guard BEFORE UPDATE ON factory.review_media FOR EACH ROW EXECUTE FUNCTION factory.guard_review_media();

CREATE TRIGGER review_scenario_guard BEFORE INSERT OR UPDATE ON factory.review_scenario FOR EACH ROW EXECUTE FUNCTION factory.guard_review_scenario();

CREATE TRIGGER staging_configuration_immutable BEFORE INSERT OR DELETE OR UPDATE ON factory.staging_configuration FOR EACH ROW EXECUTE FUNCTION factory.protect_staging_configuration();

CREATE TRIGGER substrate_isolated_identity BEFORE INSERT OR DELETE OR UPDATE ON factory.substrate_isolated FOR EACH ROW EXECUTE FUNCTION factory.protect_substrate_isolated();
