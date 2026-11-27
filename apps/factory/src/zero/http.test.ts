import { expect, test } from "bun:test";
import { createDatabase } from "#db/client";
import { handleZeroMutate, zeroDatabase } from "./http";

test("Zero retains its schema provider per database, not per request or across installations", async () => {
  const first = createDatabase(1);
  const second = createDatabase(1);
  try {
    expect(zeroDatabase(first)).toBe(zeroDatabase(first));
    expect(zeroDatabase(first)).not.toBe(zeroDatabase(second));
    const denied = await handleZeroMutate(
      new Request("http://localhost/api/zero/mutate", { method: "POST" }),
      first,
      null,
    );
    expect(denied.status).toBe(401);
  } finally {
    await Promise.all([first.client.end(), second.client.end()]);
  }
});
