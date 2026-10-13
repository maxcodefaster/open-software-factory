import { expect, test } from "bun:test";
import { factoryProcess } from "../fixtures/factory-process";
import { fixture } from "../fixtures/change-agent-turns";
import { createRuntimeAccess } from "../../apps/factory/src/access/runtime";

test("Contributor permissions and role downgrade cover commands and existing IDE grants", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  try {
    await process.start();
    const cookie = await process.signIn();
    const owned = await fixture(undefined, undefined, database);
    const adminHeaders = { cookie, origin: process.base, "content-type": "application/json" };
    const email = `contributor-${crypto.randomUUID()}@factory.local`;
    const password = "owned-contributor-password-not-a-secret";
    const account = await fetch(`${process.base}/api/admin/users`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ name: "Product contributor", email, password }),
    });
    expect(account.status).toBe(201);
    const { id: userID } = (await account.json()) as { id: string };
    const setRole = async (role: string) => {
      const response = await fetch(`${process.base}/api/projects/${owned.projectID}/members`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ email, role }),
      });
      expect(response.status).toBe(200);
    };
    await setRole("developer");
    const login = await fetch(`${process.base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: process.base, "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    expect(login.status).toBe(200);
    const memberHeaders = {
      ...adminHeaders,
      cookie: login.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; "),
    };
    const [session] = await database.client<
      Array<{ id: string }>
    >`SELECT id FROM auth.session WHERE user_id = ${userID}`;
    if (!session) throw new Error("Owned session missing");
    const revoked: string[] = [];
    const grants = createRuntimeAccess(database, (token) => revoked.push(token));
    const grant = {
      attemptID: owned.attemptID,
      userID,
      sessionID: session.id,
      expires: Date.now() + 60_000,
      mode: "top-level" as const,
    };
    const ide = await grants.issue({ ...grant, channel: "ide" });
    const preview = await grants.issue({ ...grant, channel: "app" });
    await setRole("product-contributor");
    const command = (path: string, method = "GET", body?: unknown) =>
      fetch(`${process.base}${path}`, {
        method,
        redirect: "manual",
        headers: memberHeaders,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    for (const path of [
      `/api/tickets/${owned.ticketID}`,
      `/api/projects/${owned.projectID}/conversation`,
      `/api/changes?projectId=${owned.projectID}`,
      `/api/runtime-attempts?projectId=${owned.projectID}`,
    ])
      expect((await command(path)).status).toBe(200);
    for (const path of [
      `/api/projects/${owned.projectID}/personal-workspace/ensure`,
      `/api/changes/${owned.changeID}/ticket-workspace/ensure`,
      `/api/changes/${owned.changeID}/agent/start`,
      `/api/changes/${owned.changeID}/agent/prompt`,
      `/api/changes/${owned.changeID}/delivery/approve`,
      `/api/changes/${owned.changeID}/cancel`,
      `/api/runtime-attempts/${owned.attemptID}/stop`,
    ])
      expect((await command(path, "POST", {})).status).toBe(403);
    expect(
      (
        await command(
          `/api/runtime-access?path=${encodeURIComponent(`/runtime/${owned.attemptID}/ide/`)}`,
        )
      ).status,
    ).toBe(403);
    await grants.sweep();
    expect(revoked).toEqual([ide]);
    expect(grants.has(preview)).toBe(true);
    await expect(grants.issue({ ...grant, channel: "ide" })).rejects.toThrow(
      "Runtime access required",
    );
    await expect(grants.issue({ ...grant, channel: "app" })).resolves.toBeString();
    const correctionID = crypto.randomUUID();
    const correction = await command(
      `/api/changes/${owned.changeID}/agent/request-changes`,
      "POST",
      {
        commandId: correctionID,
        text: "Correct the bounded check within the approved specification",
      },
    );
    expect(correction.status).toBe(202);
    const [admitted] = await database.client<
      Array<{ kind: string; revisionID: string; sessionID: string }>
    >`
      SELECT turn.input->>'kind' AS kind, turn.authority->>'requirementRevisionId' AS "revisionID", intent.session_id AS "sessionID"
      FROM factory.agent_turn turn JOIN factory.change_agent_turn_intent intent ON intent.turn_id = turn.id
      WHERE turn.command_id = ${correctionID}`;
    expect(admitted?.kind).toBe("change-prompt");
    expect(admitted?.revisionID).toBe(owned.revisionID);
    expect(admitted?.sessionID).toBe(owned.sessionID);
    expect((await command(`/api/changes/${owned.changeID}/agent/stop`, "POST")).status).toBe(202);
    await setRole("developer");
    await expect(grants.issue({ ...grant, channel: "ide" })).resolves.toBeString();
  } finally {
    await database.client.end();
    await process.dispose();
  }
}, 60_000);
