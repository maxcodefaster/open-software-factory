import { expect, test } from "bun:test";
import { appRuntimeOrigin } from "../../apps/factory/src/runtime-origins";
import { runtimeAccessCookie } from "../fixtures/runtime-access";

test("runtime fixture cookie ignores retired path deletions instead of shadowing the current origin credential", async () => {
  const attemptID = crypto.randomUUID();
  let base = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/runtime-access")
        return new Response(null, {
          status: 302,
          headers: { location: `${appRuntimeOrigin(base, attemptID, "app")}/?factory-grant=owned` },
        });
      const headers = new Headers({ location: appRuntimeOrigin(base, attemptID, "app") });
      headers.append(
        "set-cookie",
        "factory_runtime_access=owned-current; Path=/; HttpOnly; SameSite=Lax",
      );
      headers.append(
        "set-cookie",
        `factory_runtime_access=; Path=/runtime/${attemptID}/app/; HttpOnly; Max-Age=0`,
      );
      headers.append(
        "set-cookie",
        `factory_runtime_access=; Path=/runtime/${attemptID}/preview/app/; HttpOnly; Max-Age=0`,
      );
      return new Response(null, { status: 302, headers });
    },
  });
  base = server.url.origin;
  try {
    expect(await runtimeAccessCookie(base, "owned-session", attemptID, "app")).toBe(
      "factory_runtime_access=owned-current",
    );
  } finally {
    await server.stop(true);
  }
});
