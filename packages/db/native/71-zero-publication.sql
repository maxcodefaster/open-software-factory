-- Run after all Drizzle tables. Only these eight relations belong to Zero replication.

CREATE PUBLICATION factory_zero_publication WITH (publish = 'insert, update, delete, truncate');

ALTER PUBLICATION factory_zero_publication ADD TABLE ONLY factory.epic;

ALTER PUBLICATION factory_zero_publication ADD TABLE ONLY factory.knowledge_page;

ALTER PUBLICATION factory_zero_publication ADD TABLE ONLY factory.knowledge_page_outline;

ALTER PUBLICATION factory_zero_publication ADD TABLE ONLY factory.project;

ALTER PUBLICATION factory_zero_publication ADD TABLE ONLY factory.project_membership;

ALTER PUBLICATION factory_zero_publication ADD TABLE ONLY factory.read_version;

ALTER PUBLICATION factory_zero_publication ADD TABLE ONLY factory.ticket;

ALTER PUBLICATION factory_zero_publication ADD TABLE ONLY factory.ticket_dependency;
