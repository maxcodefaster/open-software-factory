import { expect, test } from "bun:test";
import type { createDatabase } from "../../../../packages/db/src/client";
import { hashConnectorToken } from "../../../../packages/runtime-domain/src/identity";
import { createProjectPreparation } from "./project-preparation";

test("a cancelled prebuild result upload cannot hold a database transaction", async () => {
  let transactions = 0;
  let cancelled = false;
  let writes = 0;
  let body: ReadableStreamDefaultController<Uint8Array> | undefined;
  const sql = async (query: TemplateStringsArray) => {
    if (query.join("").includes("UPDATE")) writes++;
    return [
      {
        generation: 1,
        hash: hashConnectorToken("owned-token"),
        jobID: "owned-job",
        revision: "a",
        jobRevision: "a",
        version: 0,
        jobVersion: 0,
        environment: "development",
        jobEnvironment: "development",
      },
    ];
  };
  const database = {
    client: {
      begin: async (work: (connection: typeof sql) => Promise<unknown>) => {
        transactions++;
        return work(sql);
      },
    },
  } as unknown as ReturnType<typeof createDatabase>;
  const preparation = createProjectPreparation({
    database,
    head: async () => "",
    start: async () => {},
  });
  const abort = new AbortController();
  const request = new Request("http://factory.invalid/internal/project-image/owned", {
    method: "POST",
    signal: abort.signal,
    headers: { authorization: "Bearer owned-token", "x-factory-runtime-generation": "1" },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        body = controller;
      },
      cancel() {
        cancelled = true;
      },
    }),
  });
  const pending = preparation.endpoint(request, "owned");
  try {
    await Bun.sleep(10);
    abort.abort();
    const response = await Promise.race([
      pending,
      Bun.sleep(500).then(() => {
        throw new Error("Cancelled upload kept the transaction waiting");
      }),
    ]);
    expect(response.status).toBe(503);
    expect(cancelled).toBe(true);
    expect(transactions).toBe(0);
    expect(writes).toBe(0);
  } finally {
    if (!cancelled) body?.close();
    await pending;
  }
});
