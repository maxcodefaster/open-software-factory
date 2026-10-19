import { expect, test } from "bun:test";
import { createOpenCodeClient } from "./opencode-client";
import { connectOpenCodeBrowser } from "./opencode-browser";

test("native browser admission lets the pinned tool update propagate before its fresh readiness read", async () => {
  const calls: Array<{ method: string; path: string; at: number }> = [];
  const client = createOpenCodeClient(async (request, path) => {
    calls.push({ method: request.method, path, at: performance.now() });
    if (request.method === "PUT") {
      expect(await request.json()).toMatchObject({
        config: {
          type: "remote",
          url: "http://factory.test/fixed",
          codemode: false,
          oauth: false,
          headers: { Authorization: "Bearer owned-capability" },
        },
      });
      return new Response(null, { status: 204 });
    }
    return Response.json({ data: [{ name: "factory_browser", status: { status: "connected" } }] });
  });
  await connectOpenCodeBrowser(client, "http://factory.test/fixed", "owned-capability");
  expect(calls.map(({ method }) => method)).toEqual(["PUT", "GET"]);
  const [registration, readiness] = calls;
  if (!registration || !readiness) throw new Error("Native registration/readiness missing");
  expect(readiness.at - registration.at).toBeGreaterThanOrEqual(100);
  expect(calls.some(({ path }) => path.includes("/prompt"))).toBe(false);
});
