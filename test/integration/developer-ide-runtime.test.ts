import { expect, test } from "bun:test";
import { createDeveloperIDERuntime } from "../../apps/factory/src/workspace/developer-ide-runtime";
import { createRuntimeAccess } from "../../apps/factory/src/access/runtime";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";

test("independent editor execution is exact-Workspace/Attempt-bound, explicitly prepared and role/session revocable", async () => {
  const process = await factoryProcess();
  const database = process.connect();
  const owned = await fixture(undefined, undefined, database);
  const sessionID = crypto.randomUUID();
  let starts = 0;
  const closed: Array<[string, string]> = [];
  const actions: Array<[string, string, string]> = [];
  const access = createRuntimeAccess(database, (token) => owned.hub.revokeAccess(token));
  const runtime = createDeveloperIDERuntime(
    database,
    {
      async start() {
        starts++;
        return null;
      },
      async startPersisted(changeID, userID) {
        expect(changeID).toBe(owned.changeID);
        expect(userID).toBe(owned.userID);
        starts++;
        return null;
      },
      async processOutput(attemptID) {
        return { processes: [{ name: "app", state: "running" as const, output: attemptID }] };
      },
      async processAction(attemptID, name, action) {
        actions.push([attemptID, name, action]);
        return { processes: [] };
      },
      async closeTerminal(attemptID, terminalID) {
        closed.push([attemptID, terminalID]);
        return { closed: true };
      },
    },
    owned.hub,
    access,
  );
  try {
    const [source] = await database.client<
      Array<{ id: string }>
    >`SELECT id FROM factory.development_workspace WHERE change_id=${owned.changeID}`;
    if (!source) throw new Error("Missing owned Workspace");
    await database.client`INSERT INTO auth.session(id,token,user_id,expires_at) VALUES(${sessionID},${crypto.randomUUID()},${owned.userID},now()+interval '1 hour')`;
    const auth = {
      token: "owned-editor-token",
      grant: {
        userID: owned.userID,
        sessionID,
        epoch: 1,
        expires: Date.now() + 60_000,
        embedded: true,
      },
    };
    const prefix = `/__factory/workspaces/${source.id}/runtime`;
    const request = (method = "GET") => new Request("http://editor.invalid/", { method });
    const current = await runtime.route(prefix, request(), auth);
    expect(await current?.json()).toEqual({
      workspaceID: source.id,
      attemptID: owned.attemptID,
      state: "ready",
      failure: null,
    });
    expect(starts).toBe(0);
    const terminal = `${prefix}/${owned.attemptID}/terminal/terminal-a`;
    const language = `${prefix}/${owned.attemptID}/language/typescript`;
    await expect(runtime.socketData(language, auth)).rejects.toThrow("observation-only");
    await expect(runtime.socketData(terminal, auth)).rejects.toThrow("observation-only");
    await expect(
      runtime.route(`${prefix}/${owned.attemptID}/processes/app/restart`, request("POST"), auth),
    ).rejects.toThrow("observation-only");
    expect(actions).toHaveLength(0);
    await database.client`UPDATE factory.change_writer SET state='human',user_id=${owned.userID} WHERE change_id=${owned.changeID}`;
    const data = await runtime.socketData(terminal, auth);
    expect(data?.kind).toBe("browser");
    if (data?.kind !== "browser" || !data.accessToken)
      throw new Error("Expected bounded runtime grant");
    expect(data.attemptID).toBe(owned.attemptID);
    expect(data.path).toBe("/terminal-a");
    expect(access.has(data.accessToken)).toBe(true);
    expect(await runtime.socketData(terminal, auth)).toEqual(data);
    const tools = await runtime.socketData(language, auth);
    expect(tools).toEqual({ ...data, channel: "language", path: `/typescript/${source.id}` });
    expect(
      await runtime.socketData(`${prefix}/${owned.attemptID}/language/shell`, auth),
    ).toBeUndefined();
    await expect(
      runtime.socketData(language.replace(owned.attemptID, crypto.randomUUID()), auth),
    ).rejects.toThrow("not connected");
    expect(starts).toBe(0);
    const stream = await runtime.route(
      `${prefix}/${owned.attemptID}/processes/events`,
      request(),
      auth,
    );
    const reader = stream?.body?.getReader();
    expect(reader).toBeDefined();
    await reader?.read();
    await runtime.route(
      `${prefix}/${owned.attemptID}/processes/app/restart`,
      request("POST"),
      auth,
    );
    await runtime.route(
      `${prefix}/${owned.attemptID}/terminals/terminal-a`,
      request("DELETE"),
      auth,
    );
    expect(actions).toEqual([[owned.attemptID, "app", "restart"]]);
    expect(closed).toEqual([[owned.attemptID, "terminal-a"]]);
    await expect(
      runtime.socketData(`${prefix}/${crypto.randomUUID()}/terminal/terminal-a`, auth),
    ).rejects.toThrow("not connected");
    await expect(
      runtime.socketData(terminal.replace(source.id, crypto.randomUUID()), auth),
    ).rejects.toThrow("Workspace not found");
    expect(
      await runtime.route(
        `${prefix}/${owned.attemptID}/processes/opencode/stop`,
        request("POST"),
        auth,
      ),
    ).toBeUndefined();
    expect(
      await database.client`SELECT id FROM factory.agent_turn WHERE project_id=${owned.projectID}`,
    ).toHaveLength(0);
    runtime.revokeEditor(auth.token);
    expect(access.has(data.accessToken)).toBe(false);
    expect((await reader?.read())?.done).toBe(true);
    await runtime.route(`${prefix}/ensure`, request("POST"), auth);
    expect(starts).toBe(1);
    await database.client`UPDATE factory.runtime_attempt SET state='stopped' WHERE id=${owned.attemptID}`;
    await expect(runtime.socketData(terminal, auth)).rejects.toThrow("not connected");
    await expect(runtime.socketData(language, auth)).rejects.toThrow("not connected");
    await expect(
      runtime.route(`${prefix}/${owned.attemptID}/terminals/terminal-a`, request("DELETE"), auth),
    ).rejects.toThrow("not connected");
    expect(closed).toHaveLength(1);
    await database.client`UPDATE factory.project_membership SET role='product-contributor' WHERE project_id=${owned.projectID} AND user_id=${owned.userID}`;
    await expect(runtime.route(prefix, request(), auth)).rejects.toThrow(
      "Developer access required",
    );
    await expect(runtime.route(`${prefix}/ensure`, request("POST"), auth)).rejects.toThrow(
      "Developer access required",
    );
    expect(starts).toBe(1);
  } finally {
    await database.client.end({ timeout: 2 });
    await process.dispose();
  }
}, 15_000);
