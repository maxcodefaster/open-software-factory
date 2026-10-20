import { expect, test } from "bun:test";
import { createDeveloperIDEEdge } from "./developer-ide-edge";
import { CommandError } from "../command-error";

test("the authenticated Editor edge admits native Theia Socket.IO and keeps origin/path fences", async () => {
  const userID = "abdabd34-6496-40f1-afbf-86187708037c";
  const factoryOrigin = "http://127.0.0.1:3000";
  const edge = createDeveloperIDEEdge(
    { client: async () => [{ id: "fixture-session" }] } as unknown as Parameters<
      typeof createDeveloperIDEEdge
    >[0],
    {
      get: async () => ({ epoch: 1, state: "ready" }),
      connection: async () => "http://127.0.0.1:12345",
    } as unknown as Parameters<typeof createDeveloperIDEEdge>[1],
    {} as Parameters<typeof createDeveloperIDEEdge>[2],
    factoryOrigin,
    { revokeEditor() {} } as unknown as Parameters<typeof createDeveloperIDEEdge>[4],
  );
  const issued = await edge.issue(userID, "fixture-session", false);
  const redeemed = await edge.route(new Request(issued));
  const location = redeemed.headers.get("location");
  const cookie = redeemed.headers.get("set-cookie")?.split(";")[0];
  if (!location || !cookie) throw new Error("Expected the authenticated editor redirect");
  const root = new URL(location);
  const socketURL = new URL("socket.io/?EIO=4&transport=websocket", root);
  const request = (url = socketURL, origin = root.origin, credential = cookie) =>
    new Request(url, {
      headers: { origin, cookie: credential },
    });
  const data = await edge.socketData(request());
  expect(data instanceof Response).toBe(false);
  if (data instanceof Response) throw new Error(`Native Socket.IO was refused: ${data.status}`);
  expect(data.backendURL).toBe("ws://127.0.0.1:12345/socket.io/?EIO=4&transport=websocket");
  expect(data.userID).toBe(userID);
  expect(data.epoch).toBe(1);
  const foreign = await edge.socketData(request(socketURL, "https://foreign.invalid"));
  expect(foreign instanceof Response && foreign.status).toBe(403);
  const unauthorized = await edge.socketData(request(socketURL, root.origin, ""));
  expect(unauthorized instanceof Response && unauthorized.status).toBe(401);
  const other = await edge.socketData(request(new URL("arbitrary-socket", root)));
  expect(other instanceof Response && other.status).toBe(404);
});

test("Workspace presentation uses authenticated source authority without opening compute", async () => {
  const userID = "abdabd34-6496-40f1-afbf-86187708037c";
  const workspaceID = "11111111-1111-4111-8111-111111111111";
  const reads: string[] = [];
  const edge = createDeveloperIDEEdge(
    { client: async () => [{ id: "fixture-session" }] } as unknown as Parameters<
      typeof createDeveloperIDEEdge
    >[0],
    { get: async () => ({ epoch: 1, state: "ready" }) } as unknown as Parameters<
      typeof createDeveloperIDEEdge
    >[1],
    {
      async get(id: string, actor: string) {
        if (id !== workspaceID || actor !== userID) throw Error("Workspace not found");
        reads.push(id);
        return { workspaceID, label: "Ticket · Support requests", state: "ready" };
      },
    } as unknown as Parameters<typeof createDeveloperIDEEdge>[2],
    "http://127.0.0.1:3000",
    {
      revokeEditor() {},
      async route() {
        throw Error("Presentation must not start or observe execution");
      },
    } as unknown as Parameters<typeof createDeveloperIDEEdge>[4],
  );
  const issued = await edge.issue(userID, "fixture-session", false);
  const redeemed = await edge.route(new Request(issued));
  const location = redeemed.headers.get("location");
  const cookie = redeemed.headers.get("set-cookie")?.split(";")[0];
  if (!location || !cookie) throw new Error("Expected the authenticated editor redirect");
  const root = new URL(location);
  const path = `__factory/workspaces/${workspaceID}/source/context`;
  const request = (credential = cookie) =>
    new Request(new URL(path, root), { headers: { cookie: credential } });
  const unauthorized = await edge.route(request(""));
  expect(unauthorized.status).toBe(401);
  expect(reads).toEqual([]);
  const response = await edge.route(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ workspaceID, label: "Ticket · Support requests" });
  expect(reads).toEqual([workspaceID]);
  await expect(
    edge.route(
      new Request(
        new URL("__factory/workspaces/22222222-2222-4222-8222-222222222222/source/context", root),
        { headers: { cookie } },
      ),
    ),
  ).rejects.toThrow("Workspace not found");
});

test("temporary editor preparation keeps its grant and recovers the initial document without a new epoch", async () => {
  const userID = "abdabd34-6496-40f1-afbf-86187708037c";
  let state: "ready" | "preparing" | "stop-intended" = "ready";
  let backendRequests = 0;
  const backend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      backendRequests++;
      return new Response("native editor ready", { headers: { "content-type": "text/html" } });
    },
  });
  const edge = createDeveloperIDEEdge(
    { client: async () => [{ id: "fixture-session" }] } as unknown as Parameters<
      typeof createDeveloperIDEEdge
    >[0],
    {
      get: async () => ({ epoch: 1, state }),
      async connection() {
        if (state !== "ready") throw new CommandError("unavailable", "Editor is preparing");
        return backend.url.origin;
      },
    } as unknown as Parameters<typeof createDeveloperIDEEdge>[1],
    {} as Parameters<typeof createDeveloperIDEEdge>[2],
    "http://127.0.0.1:3000",
    { revokeEditor() {}, route: async () => undefined } as unknown as Parameters<
      typeof createDeveloperIDEEdge
    >[4],
  );
  try {
    const issued = await edge.issue(userID, "fixture-session", false);
    const redeemed = await edge.route(new Request(issued));
    const location = redeemed.headers.get("location");
    const cookie = redeemed.headers.get("set-cookie")?.split(";")[0];
    if (!location || !cookie) throw new Error("Expected the authenticated editor redirect");
    const request = () => new Request(location, { headers: { cookie, accept: "text/html" } });
    state = "preparing";
    const waiting = await edge.route(request());
    expect(waiting.status).toBe(503);
    expect(await waiting.text()).toContain('http-equiv="refresh"');
    expect(backendRequests).toBe(0);
    state = "ready";
    const ready = await edge.route(request());
    expect(ready.status).toBe(200);
    expect(await ready.text()).toBe("native editor ready");
    expect(backendRequests).toBe(1);
    state = "stop-intended";
    expect((await edge.route(request())).status).toBe(401);
    state = "ready";
    // Stop revokes the grant permanently. Readiness recovery cannot revive it.
    expect((await edge.route(request())).status).toBe(401);
    expect(backendRequests).toBe(1);
  } finally {
    await backend.stop(true);
  }
});
