-- Access triggers. Run after all Drizzle tables, indexes and foreign keys.

CREATE TRIGGER check_session_access BEFORE INSERT OR UPDATE ON auth.session FOR EACH ROW EXECUTE FUNCTION factory.check_session_access();

CREATE TRIGGER initialize_account_access AFTER INSERT ON auth."user" FOR EACH ROW EXECUTE FUNCTION factory.initialize_account_access();

CREATE TRIGGER enqueue_account_revocation AFTER UPDATE ON factory.account_access FOR EACH ROW EXECUTE FUNCTION factory.enqueue_access_revocation();

CREATE TRIGGER enqueue_membership_revocation AFTER INSERT OR DELETE OR UPDATE ON factory.project_membership FOR EACH ROW EXECUTE FUNCTION factory.enqueue_access_revocation();

CREATE TRIGGER enqueue_project_access AFTER INSERT ON factory.project FOR EACH ROW EXECUTE FUNCTION factory.enqueue_access_revocation();
