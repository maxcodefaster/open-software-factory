import { expect, test } from "bun:test";
import { createInternalProtocol } from "./internal";

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
