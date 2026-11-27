import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForPostgres } from "../src/db/readiness.ts";

test("ready PostgreSQL needs one query and no retry delay", async () => {
  let probes = 0;
  await waitForPostgres(
    async () => {
      probes++;
    },
    async () => {
      assert.fail("A successful readiness query must not wait");
    },
  );
  assert.equal(probes, 1);
});

test("only failed SQL readiness is retried, with a pause before each later query", async () => {
  const events: string[] = [];
  let probes = 0;
  await waitForPostgres(
    async () => {
      events.push("query");
      if (++probes < 3) throw new Error("PostgreSQL is starting");
    },
    async () => {
      events.push("wait");
    },
  );
  assert.deepEqual(events, ["query", "wait", "query", "wait", "query"]);
});

test("permanent failure is bounded and does not expose a credential-bearing driver error", async () => {
  let probes = 0;
  let pauses = 0;
  await assert.rejects(
    waitForPostgres(
      async () => {
        probes++;
        throw new Error("Driver error includes a protected connection URL");
      },
      async () => {
        pauses++;
      },
    ),
    { message: "Starter PostgreSQL did not become ready" },
  );
  assert.equal(probes, 30);
  assert.equal(pauses, 29);
});

test("cancellation during the readiness wait never dispatches another query", async () => {
  let probes = 0;
  await assert.rejects(
    waitForPostgres(
      async () => {
        probes++;
        throw new Error("Starting");
      },
      async () => {
        throw new Error("Cancelled");
      },
    ),
    { message: "Cancelled" },
  );
  assert.equal(probes, 1);
});
