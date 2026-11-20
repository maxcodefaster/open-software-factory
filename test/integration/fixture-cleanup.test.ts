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

test("owned fixture cleanup follows an in-flight Ticket save's Ticket-before-Project order", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  const locked = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  let save: Promise<unknown> | undefined;
  let cleanup: Promise<void> | undefined;
  try {
    const work = await fixture(undefined, undefined, database);
    // This fixture does not have an admitted turn. The concurrent operation is
    // the same planning-only Ticket then Project lock sequence as autosave.
    save = database.client.begin(async (sql) => {
      const [connection] = await sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid
        FROM factory.ticket WHERE id=${work.ticketID} FOR UPDATE`;
      if (!connection) throw Error("Owned Ticket save lock required");
      locked.resolve(connection.pid);
      await release.promise;
      await sql`SELECT id FROM factory.project WHERE id=${work.projectID} FOR SHARE`;
    });
    const savePID = await locked.promise;
    cleanup = deleteFactoryProject(work.projectID, database);
    let waiting = false;
    for (let i = 0; i < 500; i++) {
      const blockers = await database.client`SELECT pid FROM pg_stat_activity
        WHERE ${savePID} = ANY(pg_blocking_pids(pid))`;
      if (blockers.length) {
        waiting = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
    release.resolve();
    await save;
    await cleanup;
    expect(
      await database.client`SELECT id FROM factory.project WHERE id=${work.projectID}`,
    ).toHaveLength(0);
  } finally {
    release.resolve();
    await Promise.allSettled([save, cleanup]);
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 30_000);
