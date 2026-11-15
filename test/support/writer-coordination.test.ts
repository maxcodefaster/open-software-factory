import { expect, test } from "bun:test";
import type { Sql } from "postgres";
import { guardWriterCoordination } from "../fixtures/writer-coordination";

function stubCoordination(end: () => Promise<void> = async () => {}) {
  const statements: string[] = [];
  return {
    statements,
    create: () =>
      Object.assign(
        async (parts: TemplateStringsArray, _key: string) => {
          statements.push(parts.join("?"));
          return [];
        },
        { end },
      ) as unknown as Sql,
  };
}

// Match the production exclusive operation, including its awaited finally.
async function operation<T>(create: () => Sql, key: string, work: () => Promise<T>) {
  const connection = create();
  try {
    await connection`SELECT pg_advisory_lock(hashtext(${key}))`;
    return await work();
  } finally {
    try {
      await connection`SELECT pg_advisory_unlock(hashtext(${key}))`;
    } finally {
      await connection.end({ timeout: 1 });
    }
  }
}

test("the old deadline reports deadlock for a single operation awaiting delayed close", async () => {
  const closing = Promise.withResolvers<void>();
  const releaseClose = Promise.withResolvers<void>();
  const stub = stubCoordination(async () => {
    closing.resolve();
    await releaseClose.promise;
  });
  const guarded = guardWriterCoordination(stub.create);
  const stale = operation(guarded.coordination, "change-writer-operation:owned", async () => ({
    state: "agent",
  }));
  try {
    await closing.promise;
    await expect(
      Promise.race([
        stale,
        Bun.sleep(1_000).then(() => {
          throw new Error("Stale completion deadlocked");
        }),
      ]),
    ).rejects.toThrow("Stale completion deadlocked");
    expect(guarded.acquisitions).toBe(1);
    expect(guarded.heldKeys).toEqual([]);
    expect(stub.statements).toEqual([
      "SELECT pg_advisory_lock(hashtext(?))",
      "SELECT pg_advisory_unlock(hashtext(?))",
    ]);
  } finally {
    releaseClose.resolve();
    expect(await stale).toEqual({ state: "agent" });
  }
});

test("recursive same-key acquisition fails before SQL and inner cleanup retains the outer owner", async () => {
  const stub = stubCoordination();
  const guarded = guardWriterCoordination(stub.create);
  const key = "change-writer-operation:owned";
  await operation(guarded.coordination, key, async () => {
    await expect(operation(guarded.coordination, key, async () => {})).rejects.toThrow(
      "Reentrant writer coordination lock",
    );
    expect(guarded.heldKeys).toEqual([key]);
  });
  expect(guarded.acquisitions).toBe(1);
  expect(
    stub.statements.filter((statement) => statement.includes("pg_advisory_lock")),
  ).toHaveLength(1);
  expect(guarded.heldKeys).toEqual([]);
  await operation(guarded.coordination, key, async () => {});
  expect(guarded.acquisitions).toBe(2);
});

test("distinct operation keys do not count as recursive acquisition", async () => {
  const guarded = guardWriterCoordination(stubCoordination().create);
  await operation(guarded.coordination, "change-writer-operation:first", async () =>
    operation(guarded.coordination, "change-writer-operation:second", async () => {}),
  );
  expect(guarded.acquisitions).toBe(2);
  expect(guarded.heldKeys).toEqual([]);
});
