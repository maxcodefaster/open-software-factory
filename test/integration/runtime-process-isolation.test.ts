import { expect, test } from "bun:test";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";

test("isolated Factory runtime grants stay on its configured listener", async () => {
  const process = await factoryProcess();
  try {
    await process.start();
    const owned = await fixture(undefined, undefined, process.connect());
    try {
      const cookie = await process.signIn();
      for (const channel of ["ide", "app"] as const) {
        const path = `/runtime/${owned.attemptID}/${channel}/`;
        const response = await fetch(
          `${process.base}/api/runtime-access?${new URLSearchParams({ path })}`,
          { headers: { cookie }, redirect: "manual" },
        );
        expect(response.status).toBe(302);
        const destination = new URL(response.headers.get("location") ?? "");
        expect(destination.port).toBe(new URL(process.base).port);
        expect(destination.hostname).toBe(
          `${owned.attemptID.replaceAll("-", "")}-${channel}.runtime.localhost`,
        );
        expect(destination.pathname).toBe(path);
        expect(destination.searchParams.has("factory-grant")).toBe(true);
      }
    } finally {
      await process.shutdown();
      await owned.dispose();
    }
  } finally {
    await process.dispose();
  }
}, 30_000);
