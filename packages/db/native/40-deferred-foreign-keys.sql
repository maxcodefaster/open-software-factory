-- Run after Drizzle creates these named FKs. Change attributes without duplicating definitions.

ALTER TABLE ONLY factory.knowledge_page
    ALTER CONSTRAINT knowledge_page_parent_project DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY factory.monitoring_hook
    ALTER CONSTRAINT monitoring_current_policy DEFERRABLE INITIALLY DEFERRED;
