import { expect, test } from "bun:test";
import { createMCPOAuthCallback } from "./oauth-callback";

test("only the external MCP OAuth callback remains HTTP and binds the authenticated actor", async () => {
  const actor = crypto.randomUUID(),
    calls: unknown[] = [];
  const callback = createMCPOAuthCallback({
    async callback(userID, params) {
      calls.push({ userID, code: params.get("code"), state: params.get("state") });
      return { connected: true };
    },
  });
  const response = await callback(
    new Request("https://factory.test/api/mcp/oauth/callback?code=owned-code&state=owned-state"),
    actor,
  );
  expect(calls).toEqual([{ userID: actor, code: "owned-code", state: "owned-state" }]);
  expect(response?.status).toBe(200);
  expect(response?.headers.get("cache-control")).toBe("no-store");
  expect(response?.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await response?.text()).not.toContain("owned-code");
  expect(
    (
      await callback(
        new Request("https://factory.test/api/mcp/oauth/callback", {
          method: "POST",
        }),
        actor,
      )
    )?.status,
  ).toBe(405);
  for (const path of ["/api/mcp", "/api/mcp/choices", `/api/mcp/${crypto.randomUUID()}/connect`])
    expect(await callback(new Request(`https://factory.test${path}`), actor)).toBeUndefined();
  expect(calls).toHaveLength(1);
});
