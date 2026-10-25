import { expect, test } from "bun:test";
import { factoryProcess } from "../fixtures/factory-process";
import { fixture } from "../fixtures/change-agent-turns";
import { createRuntimeAccess } from "../../apps/factory/src/access/runtime";
import { callFactoryFunction } from "../fixtures/server-functions";
import { serverCall } from "../../apps/factory/src/server-functions/result";

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
    const { id: userID } = await serverCall(
      callFactoryFunction(
        process.base,
        "createAccount",
        [{ name: "Product contributor", email, password }],
        adminHeaders,
      ),
    );
    const setRole = async (role: "developer" | "product-contributor") => {
      const response = await callFactoryFunction(
        process.base,
        "saveProjectMember",
        [owned.projectID, { email, role }],
        adminHeaders,
      );
      expect(response.ok).toBe(true);
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
    expect(
      await callFactoryFunction(process.base, "getTicketDetail", [owned.ticketID], memberHeaders),
    ).toMatchObject({ ok: true });
    expect(
      await callFactoryFunction(process.base, "getConversation", [owned.projectID], memberHeaders),
    ).toMatchObject({ ok: true });
    expect(
      await callFactoryFunction(process.base, "getChanges", [owned.projectID], memberHeaders),
    ).toMatchObject({ ok: true });
    expect(
      await callFactoryFunction(
        process.base,
        "getRuntimeAttempts",
        [owned.projectID],
        memberHeaders,
      ),
    ).toMatchObject({ ok: true });
    expect(
      await callFactoryFunction(process.base, "approveDelivery", [owned.changeID], memberHeaders),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      await callFactoryFunction(
        process.base,
        "startPersonalWorkspace",
        [owned.projectID],
        memberHeaders,
      ),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      await callFactoryFunction(
        process.base,
        "startTicketWorkspace",
        [owned.changeID],
        memberHeaders,
      ),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      await callFactoryFunction(
        process.base,
        "startCoding",
        [owned.changeID, { commandId: crypto.randomUUID() }],
        memberHeaders,
      ),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      await callFactoryFunction(
        process.base,
        "sendCodingPrompt",
        [
          owned.changeID,
          {
            commandId: crypto.randomUUID(),
            text: "Denied direct Coding prompt",
          },
        ],
        memberHeaders,
      ),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      await callFactoryFunction(process.base, "cancelChange", [owned.changeID], memberHeaders),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      await callFactoryFunction(
        process.base,
        "stopRuntimeAttempt",
        [owned.attemptID],
        memberHeaders,
      ),
    ).toMatchObject({ ok: false, status: 403 });
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
    const correction = await callFactoryFunction(
      process.base,
      "requestCodingChanges",
      [
        owned.changeID,
        {
          commandId: correctionID,
          text: "Correct the bounded check within the approved specification",
        },
      ],
      memberHeaders,
    );
    expect(correction).toMatchObject({ ok: true });
    const [admitted] = await database.client<
      Array<{ kind: string; revisionID: string; sessionID: string }>
    >`
      SELECT turn.input->>'kind' AS kind, turn.authority->>'requirementRevisionId' AS "revisionID", intent.session_id AS "sessionID"
      FROM factory.agent_turn turn JOIN factory.change_agent_turn_intent intent ON intent.turn_id = turn.id
      WHERE turn.command_id = ${correctionID}`;
    expect(admitted?.kind).toBe("change-prompt");
    expect(admitted?.revisionID).toBe(owned.revisionID);
    expect(admitted?.sessionID).toBe(owned.sessionID);
    expect(
      await callFactoryFunction(process.base, "stopCoding", [owned.changeID], memberHeaders),
    ).toMatchObject({ ok: true });
    await setRole("developer");
    await expect(grants.issue({ ...grant, channel: "ide" })).resolves.toBeString();
  } finally {
    await database.client.end();
    await process.dispose();
  }
}, 60_000);
