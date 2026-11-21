import { expect, test } from "bun:test";
import { projectAuthorityIn } from "../../apps/factory/src/access/controller";
import type { createDatabase } from "../../packages/db/src/client";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";
import { deleteFactoryProject } from "../support/factory-fixture";

type Database = ReturnType<typeof createDatabase>;

function pauseCleanupAfterContention(database: Database) {
  let contended = false;
  const resume = Promise.withResolvers<void>();
  const client = new Proxy(database.client, {
    get(target, key, receiver) {
      if (key !== "begin") return Reflect.get(target, key, receiver);
      return new Proxy(target.begin, {
        apply(begin, _receiver, args) {
          return Reflect.apply(begin, target, args).catch(async (cause: unknown) => {
            // begin has completed PostgreSQL's rollback before rejecting.
            if (!contended && cause instanceof Error && "code" in cause && cause.code === "55P03") {
              contended = true;
              await resume.promise;
            }
            throw cause;
          });
        },
      });
    },
  });
  return {
    database: { ...database, client },
    contended: () => contended,
    resume: () => resume.resolve(),
  };
}

async function projectRows(database: Database, projectID: string) {
  return database.client`SELECT
    (SELECT count(*)::int FROM factory.project WHERE id=${projectID}) AS projects,
    (SELECT count(*)::int FROM factory.project_membership WHERE project_id=${projectID}) AS members,
    (SELECT count(*)::int FROM factory.ticket WHERE project_id=${projectID}) AS tickets,
    (SELECT count(*)::int FROM factory.change WHERE project_id=${projectID}) AS changes,
    (SELECT count(*)::int FROM factory.runtime_compute_wait wait
      JOIN factory.runtime_attempt attempt ON attempt.id=wait.attempt_id
      WHERE attempt.project_id=${projectID}) AS waits`;
}

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

test("owned fixture cleanup preserves an in-flight Ticket save's Ticket-before-membership order", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  const locked = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const probe = pauseCleanupAfterContention(database);
  let save: Promise<unknown> | undefined;
  let cleanup: Promise<void> | undefined;
  try {
    const work = await fixture(undefined, undefined, database);
    await database.client`INSERT INTO factory.runtime_compute_wait(attempt_id) VALUES(${work.attemptID})`;
    const before = await projectRows(database, work.projectID);
    // The actual document save takes Ticket FOR UPDATE before this authority owner.
    save = database.client.begin(async (sql) => {
      const [connection] = await sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid
        FROM factory.ticket WHERE id=${work.ticketID} FOR UPDATE`;
      if (!connection) throw Error("Owned Ticket save lock required");
      locked.resolve(connection.pid);
      await release.promise;
      await projectAuthorityIn(sql, work.userID, work.projectID);
    });
    const savePID = await locked.promise;
    cleanup = deleteFactoryProject(work.projectID, probe.database);
    const outcomes = Promise.allSettled([save, cleanup]);
    let waiting = false;
    for (let i = 0; i < 500; i++) {
      const blockers = await database.client`SELECT pid FROM pg_stat_activity
        WHERE ${savePID} = ANY(pg_blocking_pids(pid))`;
      if (blockers.length || probe.contended()) {
        waiting = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
    expect(probe.contended()).toBe(true);
    expect(await projectRows(database, work.projectID)).toEqual(before);
    if (probe.contended())
      await database.client.begin(async (sql) => {
        await sql`SELECT user_id FROM factory.project_membership WHERE project_id=${work.projectID}
          FOR UPDATE NOWAIT`;
        await sql`SELECT id FROM factory.change WHERE project_id=${work.projectID} FOR UPDATE NOWAIT`;
      });
    probe.resume();
    release.resolve();
    for (const outcome of await outcomes) if (outcome.status === "rejected") throw outcome.reason;
    expect(
      await database.client`SELECT id FROM factory.project WHERE id=${work.projectID}`,
    ).toHaveLength(0);
  } finally {
    probe.resume();
    release.resolve();
    await Promise.allSettled([save, cleanup]);
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 30_000);

test("owned fixture cleanup follows an attention reader's membership-before-Ticket order", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  const locked = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const probe = pauseCleanupAfterContention(database);
  let reader: Promise<unknown> | undefined;
  let cleanup: Promise<void> | undefined;
  try {
    const work = await fixture(undefined, undefined, database);
    await database.client`INSERT INTO factory.runtime_compute_wait(attempt_id) VALUES(${work.attemptID})`;
    const before = await projectRows(database, work.projectID);
    reader = database.client.begin(async (sql) => {
      // getTicketAttention calls this authority owner before locking its Ticket.
      await projectAuthorityIn(sql, work.userID, work.projectID);
      const [connection] = await sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      if (!connection) throw Error("Owned attention reader connection required");
      locked.resolve(connection.pid);
      await release.promise;
      await sql`SELECT id FROM factory.ticket WHERE id=${work.ticketID} FOR SHARE`;
    });
    const readerPID = await locked.promise;
    cleanup = deleteFactoryProject(work.projectID, probe.database);
    const outcomes = Promise.allSettled([reader, cleanup]);
    let waiting = false;
    for (let i = 0; i < 500; i++) {
      const blockers = await database.client`SELECT pid FROM pg_stat_activity
        WHERE ${readerPID} = ANY(pg_blocking_pids(pid))`;
      if (blockers.length || probe.contended()) {
        waiting = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
    expect(probe.contended()).toBe(true);
    expect(await projectRows(database, work.projectID)).toEqual(before);
    if (probe.contended())
      await database.client.begin(async (sql) => {
        await sql`SELECT id FROM factory.change WHERE project_id=${work.projectID} FOR UPDATE NOWAIT`;
        await sql`SELECT id FROM factory.ticket WHERE id=${work.ticketID} FOR UPDATE NOWAIT`;
      });
    probe.resume();
    release.resolve();
    for (const outcome of await outcomes) if (outcome.status === "rejected") throw outcome.reason;
    expect(
      await database.client`SELECT id FROM factory.project WHERE id=${work.projectID}`,
    ).toHaveLength(0);
  } finally {
    probe.resume();
    release.resolve();
    await Promise.allSettled([reader, cleanup]);
    await database.client.end({ timeout: 2 });
    await host.dispose();
  }
}, 30_000);

test.each(["40P01", "55P03", "CONNECTION_CLOSED"])(
  "owned fixture cleanup does not replay a completed deletion after %s acknowledgement failure",
  async (code) => {
    const host = await factoryProcess();
    const database = host.connect();
    let attempts = 0;
    const failure = Object.assign(new Error("Injected lost cleanup acknowledgement"), { code });
    const client = new Proxy(database.client, {
      get(target, key, receiver) {
        if (key !== "begin") return Reflect.get(target, key, receiver);
        return new Proxy(target.begin, {
          apply(begin, _receiver, args) {
            attempts++;
            return Reflect.apply(begin, target, args).then(() => {
              throw failure;
            });
          },
        });
      },
    });
    try {
      const work = await fixture(undefined, undefined, database);
      await expect(deleteFactoryProject(work.projectID, { ...database, client })).rejects.toBe(
        failure,
      );
      expect(attempts).toBe(1);
      expect(
        await database.client`SELECT id FROM factory.project WHERE id=${work.projectID}`,
      ).toHaveLength(0);
    } finally {
      await database.client.end({ timeout: 2 });
      await host.dispose();
    }
  },
  30_000,
);
