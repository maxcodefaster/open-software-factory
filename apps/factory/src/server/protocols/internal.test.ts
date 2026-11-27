import { expect, test } from "bun:test";
import type postgres from "postgres";
import { drizzleTransaction } from "#db/client";
import { CommandError } from "../../command-error";
import { runtimeSourceCapability } from "../../runtime/git-http";
import { createInternalProtocol } from "./internal";

test("asynchronous internal Source failures return an HTTP error instead of escaping the listener", async () => {
  const attemptID = crypto.randomUUID();
  const protocol = createInternalProtocol({
    factoryOrigin: "https://factory.test",
    workspaceSources: {
      async nativeRestore() {
        throw new CommandError("unavailable", "Owned Source backend unavailable");
      },
    },
  } as unknown as Parameters<typeof createInternalProtocol>[0]);
  const response = await protocol(
    new Request(`https://factory.test/internal/substrate-source/${attemptID}`),
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "unavailable" });
});

test("native Source restore remains available but retired fixture-rescue paths are not routed", async () => {
  const attemptID = "e32ad434-607d-4aae-a5ad-e93c914125a3";
  const calls: string[] = [];
  const workspaceSources = {
    async nativeRestore(_request: Request, id: string) {
      calls.push(`restore:${id}`);
      return Response.json({ restored: true });
    },
    // A trap for the removed adapter, not a compatibility implementation.
    async nativePreservation() {
      calls.push("fixture-rescue");
      return Response.json({ confirmed: true });
    },
  };
  const protocol = createInternalProtocol({
    factoryOrigin: "https://factory.test",
    workspaceSources,
  } as unknown as Parameters<typeof createInternalProtocol>[0]);
  const restored = await protocol(
    new Request(`https://factory.test/internal/substrate-source/${attemptID}`, { method: "POST" }),
  );
  expect(restored.status).toBe(200);
  for (const method of ["POST", "GET"]) {
    const removed = await protocol(
      new Request(`https://factory.test/internal/substrate-source/${attemptID}/preserve`, {
        method,
      }),
    );
    expect(removed.status).toBe(404);
  }
  expect(calls).toEqual([`restore:${attemptID}`]);
});

test.each([
  { kind: null, verificationID: null, provisionKind: "workspace" },
  { kind: "verification", verificationID: crypto.randomUUID(), provisionKind: "verification" },
  { kind: "staging", verificationID: null, provisionKind: "staging" },
  { kind: "publication", verificationID: null, provisionKind: "publication" },
])(
  "runtime Source grant routing preserves lifecycle predicates and transaction binding: %j",
  async ({ kind, verificationID, provisionKind }) => {
    const attemptID = crypto.randomUUID();
    const queries: Array<{ text: string; parameters: unknown[] }> = [];
    const grants: Array<{ text: string; parameters: unknown[] }> = [];
    let found = true;
    let transactions = 0;
    const transaction = ((strings: TemplateStringsArray, ...parameters: unknown[]) => {
      grants.push({ text: strings.join("?"), parameters });
      return Promise.resolve([]);
    }) as unknown as postgres.TransactionSql;
    const client = {
      unsafe(text: string, parameters: unknown[]) {
        queries.push({ text, parameters });
        return {
          values: async () =>
            found ? [["https://owned.invalid/source.git", verificationID, kind]] : [],
        };
      },
      async begin<T>(callback: (sql: postgres.TransactionSql) => Promise<T>) {
        transactions++;
        return callback(transaction);
      },
    } as unknown as postgres.Sql;
    const protocol = createInternalProtocol({
      factoryOrigin: "https://factory.test",
      database: { client, db: drizzleTransaction(client) },
    } as unknown as Parameters<typeof createInternalProtocol>[0]);
    const request = (capability = runtimeSourceCapability(attemptID)) =>
      new Request(
        `https://factory.test/internal/runtime-source/${attemptID}/${capability}/info/refs`,
      );
    const invalid = runtimeSourceCapability(attemptID).startsWith("0") ? "1" : "0";
    expect((await protocol(request(invalid.repeat(64)))).status).toBe(404);
    expect(queries).toHaveLength(0);
    expect(transactions).toBe(0);
    expect((await protocol(request())).status).toBe(404);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toContain('from "factory"."runtime_attempt"');
    expect(queries[0]?.text).toContain(
      'inner join "factory"."project" on "factory"."project"."id" = "factory"."runtime_attempt"."project_id"',
    );
    expect(queries[0]?.text).toContain('"runtime_attempt"."id" = $1');
    expect(queries[0]?.text).toContain('"runtime_attempt"."state" in ($2, $3)');
    expect(queries[0]?.text).toContain('"runtime_attempt"."stop_intended_at" is null');
    expect(queries[0]?.parameters).toEqual([attemptID, "create-intended", "starting", 1]);
    expect(transactions).toBe(1);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.text).toContain("factory.substrate_provision");
    expect(grants[0]?.text).toContain(
      provisionKind === "staging" || provisionKind === "publication"
        ? "isolated_kind IN ('staging','publication')"
        : `provision.kind='${provisionKind}'`,
    );
    expect(grants[0]?.parameters).toContain(attemptID);
    found = false;
    expect((await protocol(request())).status).toBe(404);
    expect(queries).toHaveLength(2);
    expect(transactions).toBe(1);
    expect(grants).toHaveLength(1);
  },
);

test("the retired Project image endpoint cannot read or publish image results", async () => {
  const attemptID = crypto.randomUUID();
  let called = false;
  const protocol = createInternalProtocol({
    factoryOrigin: "https://factory.test",
    projectPreparation: {
      async endpoint() {
        called = true;
        return new Response(null, { status: 204 });
      },
    },
  } as unknown as Parameters<typeof createInternalProtocol>[0]);
  for (const method of ["GET", "POST"]) {
    const response = await protocol(
      new Request(`https://factory.test/internal/project-image/${attemptID}`, { method }),
    );
    expect(response.status).toBe(404);
  }
  expect(called).toBe(false);
});
