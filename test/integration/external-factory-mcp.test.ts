import { expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { hashPassword } from "better-auth/crypto";
import { emergencyAdministratorID } from "../../packages/auth/src/policy";
import { personalWorkspaceIdentity } from "../../packages/workspace-domain/src/workspace";
import { factoryProcess } from "../fixtures/factory-process";
import { ownedMCPAuthorization } from "../fixtures/mcp-authorization";

test("public Factory MCP uses explicit OAuth and current Workspace grants through the real SDK", async () => {
  const fixture = await factoryProcess();
  const database = fixture.connect();
  const clients: Client[] = [];
  const connect = async (accessToken: string) => {
    const client = new Client({ name: "owned-external-mcp", version: "1.0.0" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${fixture.base}/api/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
      }),
    );
    return client;
  };
  const value = (result: Awaited<ReturnType<Client["callTool"]>>) => {
    if (!("content" in result)) throw new Error("MCP proof received no tool content");
    const text = result.content.find((part) => part.type === "text");
    if (!text || text.type !== "text") throw new Error("MCP proof received no text");
    return JSON.parse(text.text);
  };
  try {
    await fixture.start();
    const cookie = await fixture.signIn();
    const owner = emergencyAdministratorID;
    const guest = crypto.randomUUID(),
      project = crypto.randomUUID();
    const password = "owned-mcp-guest-password";
    await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${guest},'MCP collaborator',${`${guest}@factory.invalid`})`;
    await database.client`INSERT INTO auth.account(id,user_id,account_id,provider_id,password)
      VALUES(${crypto.randomUUID()},${guest},${guest},'credential',${await hashPassword(password)})`;
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${project},${`external-mcp-${project}`},'Owned external MCP','https://github.com/example/project','main','.devcontainer/devcontainer.json',${owner})`;
    await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${project},${guest},'developer',${owner})`;
    const workspaceID = personalWorkspaceIdentity(project, owner).workspaceID;
    await database.client`INSERT INTO factory.development_workspace(id,project_id,kind,owner_user_id,source_branch,source_revision,created_by)
      VALUES(${workspaceID},${project},'personal',${owner},'main',${"a".repeat(40)},${owner})`;
    const login = await fetch(`${fixture.base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: fixture.base, "content-type": "application/json" },
      body: JSON.stringify({ email: `${guest}@factory.invalid`, password }),
    });
    expect(login.status).toBe(200);
    const guestCookie = login.headers
      .getSetCookie()
      .map((item) => item.split(";")[0])
      .join("; ");
    const ownerGrant = await ownedMCPAuthorization(fixture.base, cookie);
    const guestGrant = await ownedMCPAuthorization(fixture.base, guestCookie);
    const readGrant = await ownedMCPAuthorization(fixture.base, guestCookie, false);
    const ownerClient = await connect(ownerGrant.accessToken);
    const guestClient = await connect(guestGrant.accessToken);
    const readClient = await connect(readGrant.accessToken);
    const tools = await ownerClient.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("runCommand");
    expect(tools.tools.map((tool) => tool.name)).toContain("shareWorkspace");
    expect(tools.tools.map((tool) => tool.name)).toContain("beginFileTransfer");
    expect(tools.tools.map((tool) => tool.name)).toContain("downloadFileChunk");
    expect(tools.tools.map((tool) => tool.name)).toContain("listTicketWorkspaces");
    expect(tools.tools.map((tool) => tool.name)).toContain("takeOverTicketEditing");
    expect(
      value(
        await ownerClient.callTool({ name: "getWorkspaceEditing", arguments: { workspaceID } }),
      ),
    ).toMatchObject({ kind: "personal", canWrite: true });
    expect((await readClient.listTools()).tools.map((tool) => tool.name)).not.toContain(
      "runCommand",
    );
    expect((await readClient.listTools()).tools.map((tool) => tool.name)).not.toContain(
      "beginFileTransfer",
    );
    const containerDenied = await readClient.callTool({
      name: "readFile",
      arguments: { workspaceID, location: "container", path: "/etc/hostname" },
    });
    expect(containerDenied.isError).toBe(true);
    expect(value(containerDenied).error.code).toBe("forbidden");
    const transferURL = `${fixture.base}/api/workspace-transfers/${crypto.randomUUID()}`;
    expect((await fetch(transferURL)).status).toBe(401);
    expect(
      (await fetch(transferURL, { headers: { authorization: `Bearer ${readGrant.accessToken}` } }))
        .status,
    ).toBe(403);
    expect(
      (await fetch(transferURL, { headers: { authorization: `Bearer ${ownerGrant.accessToken}` } }))
        .status,
    ).toBe(404);
    expect(
      value(
        await guestClient.callTool({ name: "listWorkspaces", arguments: { projectID: project } }),
      ).workspaces,
    ).toHaveLength(0);
    const commandID = crypto.randomUUID();
    const shared = await ownerClient.callTool({
      name: "shareWorkspace",
      arguments: {
        commandID,
        workspaceID,
        userID: guest,
        permission: "observe",
        expectedVersion: 0,
      },
    });
    expect(shared.isError).not.toBe(true);
    expect(
      value(
        await guestClient.callTool({ name: "listWorkspaces", arguments: { projectID: project } }),
      ).workspaces,
    ).toHaveLength(1);
    const denied = await guestClient.callTool({
      name: "runCommand",
      arguments: { requestID: crypto.randomUUID(), workspaceID, command: "must-not-run" },
    });
    expect(denied.isError).toBe(true);
    expect(value(denied).error.code).toBe("forbidden");
    expect(
      value(
        await guestClient.callTool({ name: "getWorkspaceEditing", arguments: { workspaceID } }),
      ),
    ).toMatchObject({ kind: "personal", canWrite: false });
    await ownerClient.callTool({
      name: "shareWorkspace",
      arguments: {
        commandID: crypto.randomUUID(),
        workspaceID,
        userID: guest,
        permission: null,
        expectedVersion: 1,
      },
    });
    const kicked = await guestClient.callTool({ name: "getWorkspace", arguments: { workspaceID } });
    expect(kicked.isError).toBe(true);
    expect(value(kicked).error.code).toBe("not-found");
    const anonymous = await fetch(`${fixture.base}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain("oauth-protected-resource");
    const metadata = await fetch(`${fixture.base}/.well-known/oauth-protected-resource/api/mcp`);
    expect(metadata.ok).toBe(true);
    expect((await metadata.json()).resource).toBe(`${fixture.base}/api/mcp`);
    expect(
      await database.client`SELECT id FROM factory.runtime_attempt WHERE project_id=${project}`,
    ).toHaveLength(0);
  } finally {
    for (const client of clients) await client.close();
    await database.client.end({ timeout: 2 });
    await fixture.dispose();
  }
}, 60000);
