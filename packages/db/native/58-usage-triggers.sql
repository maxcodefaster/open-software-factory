-- Usage triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER execution_policy_command_immutable BEFORE UPDATE ON factory.execution_policy_command FOR EACH ROW EXECUTE FUNCTION factory.guard_usage_entry();

CREATE TRIGGER guard_usage_entry BEFORE UPDATE ON factory.usage_entry FOR EACH ROW EXECUTE FUNCTION factory.guard_usage_entry();

CREATE TRIGGER guard_usage_operation BEFORE UPDATE ON factory.usage_operation FOR EACH ROW EXECUTE FUNCTION factory.guard_usage_operation();
