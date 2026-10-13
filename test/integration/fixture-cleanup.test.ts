import { expect, test } from "bun:test";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";
import { deleteFactoryProject } from "../support/factory-fixture";

test("owned Project teardown removes dependent admission rows and preserves unrelated work", async () => {
  const owned = await factoryProcess();
  const database = owned.connect();
  try {
    const work = await fixture(undefined, undefined, database);
    const other = await fixture(undefined, undefined, database);
    await database.client`INSERT INTO factory.runtime_compute_wait(attempt_id) VALUES(${work.attemptID})`;
    await database.client`INSERT INTO factory.project_setup_readiness(project_id,task,command_id) VALUES(${work.projectID},'configuration',${crypto.randomUUID()})`;
    await deleteFactoryProject(work.projectID, database);
    expect(
      await database.client`SELECT attempt_id FROM factory.runtime_compute_wait WHERE attempt_id=${work.attemptID}`,
    ).toHaveLength(0);
    expect(
      await database.client`SELECT project_id FROM factory.project_setup_readiness WHERE project_id=${work.projectID}`,
    ).toHaveLength(0);
    expect(
      await database.client`SELECT id FROM factory.project WHERE id=${other.projectID}`,
    ).toHaveLength(1);
    expect(
      await database.client`SELECT id FROM factory.runtime_attempt WHERE id=${other.attemptID}`,
    ).toHaveLength(1);
  } finally {
    await database.client.end({ timeout: 2 });
    await owned.dispose();
  }
}, 30_000);
