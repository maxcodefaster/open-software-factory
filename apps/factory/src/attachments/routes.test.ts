import { expect, test } from "bun:test";
import { createAttachmentRoutes } from "./routes";
import type { createAttachmentStore } from "./store";
import { fixtureValue } from "../../../../test/fixtures/value";

test("Attachment HTTP only transfers protected bytes and retains exact upload bounds", async () => {
  const id = crypto.randomUUID(),
    project = crypto.randomUUID(),
    actor = crypto.randomUUID();
  const effects: unknown[][] = [];
  const routes = createAttachmentRoutes({
    limits: { fileBytes: 4, messageBytes: 8 },
    async metadata(...args: unknown[]) {
      effects.push(["metadata", ...args]);
      return { bytes: 3 };
    },
    async upload(...args: unknown[]) {
      effects.push(["upload", ...args]);
      return { state: "ready" };
    },
    async read(...args: unknown[]) {
      effects.push(["read", ...args]);
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "cache-control": "no-store" } });
    },
  } as unknown as ReturnType<typeof createAttachmentStore>);
  for (const [path, method] of [
    [`/api/projects/${project}/attachments`, "GET"],
    [`/api/projects/${project}/attachments`, "POST"],
    [`/api/projects/${project}/attachment-drafts/${id}`, "PUT"],
    [`/api/attachments/${id}/metadata`, "GET"],
  ] as const) {
    expect(
      await routes(new Request(`https://factory.test${path}`, { method }), actor),
    ).toBeUndefined();
  }
  expect(effects).toEqual([]);
  const original = await routes(new Request(`https://factory.test/api/attachments/${id}`), actor);
  expect(new Uint8Array(await fixtureValue(original, "original").arrayBuffer())).toEqual(
    new Uint8Array([1, 2, 3]),
  );
  expect(fixtureValue(original, "original").headers.get("cache-control")).toBe("no-store");
  await routes(new Request(`https://factory.test/api/attachments/${id}/previews/2`), actor);
  expect(effects).toEqual([
    ["read", actor, id, undefined],
    ["read", actor, id, 2],
  ]);
  const upload = await routes(
    new Request(`https://factory.test/api/attachments/${id}`, {
      method: "PUT",
      body: new Uint8Array([9, 8, 7]),
    }),
    actor,
  );
  expect(await fixtureValue(upload, "upload").json()).toEqual({ state: "ready" });
  expect(effects.at(-1)).toEqual(["upload", actor, id, new Uint8Array([9, 8, 7])]);
  const calls = effects.length;
  await expect(
    routes(
      new Request(`https://factory.test/api/attachments/${id}`, {
        method: "PUT",
        body: new Uint8Array([1, 2, 3, 4]),
      }),
      actor,
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(effects.slice(calls)).toEqual([["metadata", actor, id]]);
});
