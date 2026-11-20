-- Learning triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER learning_application_guard BEFORE UPDATE ON factory.learning_application FOR EACH ROW EXECUTE FUNCTION factory.guard_learning_record();

CREATE TRIGGER learning_case_guard BEFORE UPDATE ON factory.learning_case FOR EACH ROW EXECUTE FUNCTION factory.guard_learning_record();

CREATE TRIGGER learning_command_guard BEFORE UPDATE ON factory.learning_command FOR EACH ROW EXECUTE FUNCTION factory.guard_learning_record();

CREATE TRIGGER learning_proposal_guard BEFORE UPDATE ON factory.learning_proposal FOR EACH ROW EXECUTE FUNCTION factory.guard_learning_record();

CREATE TRIGGER learning_review_guard BEFORE UPDATE ON factory.learning_review FOR EACH ROW EXECUTE FUNCTION factory.guard_learning_record();

CREATE TRIGGER learning_source_artifact_guard BEFORE UPDATE ON factory.learning_source_artifact FOR EACH ROW EXECUTE FUNCTION factory.guard_learning_record();

CREATE TRIGGER learning_trial_guard BEFORE UPDATE ON factory.learning_trial FOR EACH ROW EXECUTE FUNCTION factory.guard_learning_record();

CREATE TRIGGER learning_trial_step_guard BEFORE UPDATE ON factory.learning_trial_step FOR EACH ROW EXECUTE FUNCTION factory.guard_learning_record();
