-- Learning triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER learning_case_guard BEFORE UPDATE ON factory.learning_case FOR EACH ROW EXECUTE FUNCTION factory.guard_learning_record();

CREATE TRIGGER learning_proposal_guard BEFORE UPDATE ON factory.learning_proposal FOR EACH ROW EXECUTE FUNCTION factory.guard_learning_record();

CREATE TRIGGER learning_review_guard BEFORE UPDATE ON factory.learning_review FOR EACH ROW EXECUTE FUNCTION factory.guard_learning_record();
