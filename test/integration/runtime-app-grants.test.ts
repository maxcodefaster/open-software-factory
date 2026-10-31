import { expect, test } from "bun:test";
import { createRuntimeAccess } from "../../apps/factory/src/access/runtime";
import { appRuntimeOrigin } from "../../apps/factory/src/runtime-origins";
import { fixture } from "../fixtures/change-agent-turns";
import { fixtureValue } from "../fixtures/value";

test("App grants bind the exact declared App and expire obsolete path cookies on redemption", async () => {
  const owned = await fixture();
  const sessionID = crypto.randomUUID();
  const revoked: string[] = [];
  const access = createRuntimeAccess(owned.database, (token) => revoked.push(token));
  try {
    await owned.database.client`INSERT INTO auth.session(id,token,user_id,expires_at)
      VALUES(${sessionID},${crypto.randomUUID()},${owned.userID},now()+interval '1 hour')`;
    const grant = {
      attemptID: owned.attemptID,
      channel: "app" as const,
      userID: owned.userID,
      sessionID,
      expires: Date.now() + 60_000,
      mode: "embedded" as const,
      appChannel: "app-forms",
    };
    const token = await access.issue(grant);
    const origin = appRuntimeOrigin("https://factory.example", owned.attemptID, "app-forms");
    const destination = new URL(
      `${origin}/runtime/${owned.attemptID}/preview/app-forms/?factory-grant=${token}`,
    );
    expect(
      await access.redeem(new URL(destination), owned.attemptID, "app", "/", "app"),
    ).toBeUndefined();
    expect(access.has(token)).toBe(true);
    const response = fixtureValue(
      await access.redeem(destination, owned.attemptID, "app", "/", "app-forms"),
      "redeemed App response",
    );
    expect(response.status).toBe(302);
    const cookies = response.headers.getSetCookie();
    expect(cookies[0]).toContain("Path=/; HttpOnly; SameSite=None; Secure; Partitioned");
    expect(cookies.filter((cookie) => cookie.includes("Max-Age=0"))).toHaveLength(2);
    expect(
      cookies
        .slice(1)
        .every((cookie) => cookie.startsWith("factory_runtime_access=; Path=/runtime/")),
    ).toBe(true);
    expect(response.headers.get("location")).not.toContain("factory-grant");
    expect(access.has(token)).toBe(false);
    const cookie = fixtureValue(cookies.at(0), "App credential cookie").split(";")[0] ?? "";
    expect(cookie).not.toBe("");
    const request = new Request(`${origin}/api/session`, { headers: { cookie } });
    const admitted = fixtureValue(
      await access.authorize(request, owned.attemptID, "app", "app-forms"),
      "App access token",
    );
    expect(await access.authorize(request, owned.attemptID, "app", "app")).toBeUndefined();
    expect(await access.authorize(request, owned.attemptID, "app", "app-other")).toBeUndefined();
    expect(await access.authorize(request, owned.attemptID, "ide")).toBeUndefined();
    await owned.database.client`DELETE FROM auth.session WHERE id=${sessionID}`;
    expect(await access.authorize(request, owned.attemptID, "app", "app-forms")).toBeUndefined();
    expect(revoked).toContain(admitted);
  } finally {
    await owned.dispose();
  }
});
