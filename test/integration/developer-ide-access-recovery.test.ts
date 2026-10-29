import { expect, test } from "bun:test";
import { CommandError } from "../../apps/factory/src/command-error";
import { developerIDEOrigin } from "../../apps/factory/src/developer-ide-origin";
import {
  createDeveloperIDEAccess,
  developerIDEPath,
} from "../../apps/factory/src/workspace/developer-ide-access";
import type { createDeveloperIDEController } from "../../apps/factory/src/workspace/developer-ide-controller";
import { factoryProcess } from "../fixtures/factory-process";

test("editor access survives Factory replacement without weakening single redemption or revocation", async () => {
  const fixture = await factoryProcess();
  const database = fixture.connect(4);
  const userID = crypto.randomUUID();
  const sessionID = crypto.randomUUID();
  const factoryOrigin = "http://127.0.0.1:3000";
  let epoch = 1;
  let permitted = true;
  const editors = {
    async get() {
      if (!permitted) throw new CommandError("forbidden", "Developer access required");
      return { epoch, state: "ready" };
    },
  } as unknown as ReturnType<typeof createDeveloperIDEController>;
  const revoked: string[] = [];
  const server = () =>
    createDeveloperIDEAccess(database, editors, factoryOrigin, (token) => revoked.push(token));
  const grant = () => ({
    userID,
    sessionID,
    epoch,
    expires: Date.now() + 60_000,
    embedded: true,
  });
  const url = (token?: string) => {
    const result = new URL(
      developerIDEPath(userID, epoch),
      developerIDEOrigin(factoryOrigin, userID, epoch),
    );
    if (token) result.searchParams.set("factory-grant", token);
    return result;
  };
  try {
    await database.client`INSERT INTO auth."user"(id,name,email,email_verified)
      VALUES(${userID},'Owned editor recovery',${`${userID}@owned.invalid`},true)`;
    await database.client`INSERT INTO auth.session(id,token,user_id,expires_at)
      VALUES(${sessionID},${crypto.randomUUID()},${userID},now()+interval '1 hour')`;
    const first = server();
    const exchange = await first.issue(grant());
    const issuedBeforeReplacement = url(exchange);
    // Both unredeemed grants and established cookies must survive a new
    // application service instance on the same retained auth database.
    const replacement = server();
    const redeemed = await replacement.redeem(issuedBeforeReplacement, userID, epoch);
    expect(redeemed?.status).toBe(302);
    const cookie = redeemed?.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("Owned editor grant did not survive service replacement");
    const request = (credential = cookie) =>
      new Request(url(), { headers: { cookie: credential } });
    const next = server();
    expect((await next.authorize(request(), userID, epoch))?.grant.userID).toBe(userID);
    expect(await first.redeem(url(exchange), userID, epoch)).toBeUndefined();
    const simultaneous = await first.issue(grant());
    const redemptions = await Promise.all([
      first.redeem(url(simultaneous), userID, epoch),
      next.redeem(url(simultaneous), userID, epoch),
    ]);
    expect(redemptions.filter((result) => result?.status === 302)).toHaveLength(1);
    expect(
      await next.authorize(request("factory_editor_access=unissued"), userID, epoch),
    ).toBeUndefined();
    const foreign = new Request("https://foreign.invalid/", { headers: { cookie } });
    expect(await next.authorize(foreign, userID, epoch)).toBeUndefined();
    permitted = false;
    expect(await next.authorize(request(), userID, epoch)).toBeUndefined();
    permitted = true;
    expect(await server().authorize(request(), userID, epoch)).toBeUndefined();
    const fresh = await first.issue(grant());
    const freshResponse = await first.redeem(url(fresh), userID, epoch);
    const freshCookie = freshResponse?.headers.get("set-cookie")?.split(";")[0];
    if (!freshCookie) throw new Error("Fresh owned editor access was not issued");
    const freshRequest = new Request(url(), { headers: { cookie: freshCookie } });
    await next.revokeUser(userID);
    await first.sweep(userID);
    expect(first.has(freshCookie.slice("factory_editor_access=".length))).toBe(false);
    expect(await first.authorize(freshRequest, userID, epoch)).toBeUndefined();
    const stale = await first.issue(grant());
    epoch++;
    expect(await server().redeem(url(stale), userID, epoch)).toBeUndefined();
    epoch--;
    const bounded = await Promise.all(Array.from({ length: 40 }, () => first.issue(grant())));
    const rows = await database.client<{ identifier: string; value: string }[]>`
      SELECT identifier,value FROM auth.verification WHERE identifier LIKE ${`factory-editor:${userID}:%`}`;
    expect(rows).toHaveLength(32);
    expect(
      rows.some((row) =>
        bounded.some((token) => row.identifier.includes(token) || row.value.includes(token)),
      ),
    ).toBe(false);
    const expired = await first.issue(grant());
    await database.client`UPDATE auth.verification SET expires_at=now()-interval '1 second'
      WHERE identifier LIKE ${`factory-editor:${userID}:%`}`;
    expect(await server().redeem(url(expired), userID, epoch)).toBeUndefined();
    const logout = await first.issue(grant());
    await database.client`DELETE FROM auth.session WHERE id=${sessionID}`;
    expect(await server().redeem(url(logout), userID, epoch)).toBeUndefined();
  } finally {
    await database.client.end();
    await fixture.dispose();
  }
});
