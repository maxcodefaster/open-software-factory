import { expect, test } from "bun:test";
import { createReviewMediaRoutes } from "./media-routes";

test("only range-capable media and exact still bytes remain Review HTTP protocols", async () => {
  const change = crypto.randomUUID(),
    actor = crypto.randomUUID(),
    id = crypto.randomUUID();
  const calls: unknown[][] = [];
  const routes = createReviewMediaRoutes({
    async read(...args) {
      calls.push(args);
      return new Response("bytes", {
        status: 206,
        headers: { "content-range": "bytes 0-4/5", "cache-control": "no-store" },
      });
    },
    async still(...args) {
      calls.push(args);
      return { id, page: "/invoice" };
    },
  });
  const read = await routes(
    new Request(`https://factory.test/api/changes/${change}/review/media/${id}`, {
      headers: { range: "bytes=0-4" },
    }),
    actor,
  );
  expect(read?.status).toBe(206);
  expect(read?.headers.get("content-range")).toBe("bytes 0-4/5");
  expect(calls).toEqual([[change, actor, id, "bytes=0-4"]]);
  const context = {
    source: "preview",
    attemptId: crypto.randomUUID(),
    representation: "dom-reconstruction",
  };
  const form = new FormData();
  form.set("id", id);
  form.set("context", JSON.stringify(context));
  form.set("frame", new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }), "frame.jpg");
  const stored = await routes(
    new Request(`https://factory.test/api/changes/${change}/review/stills`, {
      method: "POST",
      body: form,
    }),
    actor,
  );
  expect(stored?.status).toBe(201);
  expect(calls[1]).toEqual([change, actor, context, new Uint8Array([1, 2, 3]), id]);
  for (const suffix of ["", "/feedback", "/update", "/send"])
    expect(
      await routes(
        new Request(`https://factory.test/api/changes/${change}/review${suffix}`),
        actor,
      ),
    ).toBeUndefined();
  expect(
    (await routes(new Request(`https://factory.test/api/changes/${change}/review/stills`), actor))
      ?.status,
  ).toBe(405);
});

test("a still upload never reaches media staging above the existing 2 MiB limit", async () => {
  let stored = false;
  const routes = createReviewMediaRoutes({
    read: async () => new Response(),
    still: async () => {
      stored = true;
      return { id: crypto.randomUUID() };
    },
  });
  const form = new FormData();
  form.set("id", crypto.randomUUID());
  form.set("context", JSON.stringify({ source: "preview", attemptId: crypto.randomUUID() }));
  form.set("frame", new Blob([new Uint8Array(2_097_153)], { type: "image/jpeg" }), "too-large.jpg");
  await expect(
    routes(
      new Request(`https://factory.test/api/changes/${crypto.randomUUID()}/review/stills`, {
        method: "POST",
        body: form,
      }),
      crypto.randomUUID(),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(stored).toBe(false);
});
