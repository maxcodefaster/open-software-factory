import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { createDeveloperIDEController } from "../../apps/factory/src/workspace/developer-ide-controller";
import { createWorkspaceSourceController } from "../../apps/factory/src/workspace/source-controller";
import {
  createDeveloperIDEEdge,
  type DeveloperEditorSocketData,
} from "../../apps/factory/src/workspace/developer-ide-edge";
import { CommandError } from "../../apps/factory/src/command-error";
import { createDeveloperIDERuntime } from "../../apps/factory/src/workspace/developer-ide-runtime";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import { createRuntimeAccess } from "../../apps/factory/src/access/runtime";
import { createAccountRevocation } from "../../apps/factory/src/access/account-revocation";
import { createAccessRevocation } from "../../apps/factory/src/access/revocation";
import { factoryProcess, eventually } from "../fixtures/factory-process";

const ClientSocket = WebSocket as typeof WebSocket & {
  new (url: string, options: Bun.WebSocketOptions): WebSocket;
};
test("independent editor edge fences origin/user/session/epoch, strips credentials and revokes HTTP/WS/source streams", async () => {
  const fixture = await factoryProcess();
  const database = fixture.connect();
  const userID = crypto.randomUUID();
  const otherUserID = crypto.randomUUID();
  const projectID = crypto.randomUUID();
  const sessionID = crypto.randomUUID();
  const previous = {
    editor: process.env["FACTORY_DEVELOPER_IDE_IMAGE"],
    files: process.env["FACTORY_WORKSPACE_FILES_IMAGE"],
  };
  const image = `registry.invalid/ide@sha256:${"4".repeat(64)}`;
  process.env["FACTORY_DEVELOPER_IDE_IMAGE"] = image;
  process.env["FACTORY_WORKSPACE_FILES_IMAGE"] = image;
  const upstreamHeaders: Headers[] = [];
  const backend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      upstreamHeaders.push(request.headers);
      if (request.headers.get("upgrade") === "websocket") {
        if (server.upgrade(request)) return;
        return new Response(null, { status: 400 });
      }
      if (new URL(request.url).pathname === "/redirect")
        return Response.redirect("https://untrusted.invalid/", 302);
      return new Response("theia proof", {
        headers: {
          "set-cookie":
            new URL(request.url).pathname === "/other-cookie"
              ? "provider_session=must-not-forward"
              : "theia-connection-token=frontend-token; Path=/, provider_session=must-not-forward",
        },
      });
    },
    websocket: {
      message(socket, message) {
        socket.send(message);
      },
    },
  });
  const editors = createDeveloperIDEController(database, {
    async prepare() {
      return { namespaceUID: "namespace", podUID: "pod", ready: true, failed: false };
    },
    async observe() {
      return null;
    },
    async endpoint() {
      return backend.url.origin;
    },
    async stop() {},
    close() {},
  });
  const sources = createWorkspaceSourceController(database, "source-test-secret", {
    async executionNode() {
      throw new Error("No execution");
    },
    async prepare() {
      return {
        namespaceUID: "source-namespace",
        podUID: "source-pod",
        claimUID: "claim",
        storageNode: "node",
        ready: true,
        failed: false,
      };
    },
    async observe() {
      return null;
    },
    async connect() {},
    async request(_input, operation, _request, signal) {
      if (operation === "events")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"kind":"resync","path":""}\n\n'));
              signal.addEventListener("abort", () => controller.close(), { once: true });
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      return Response.json({ content: "aHVtYW4=", version: "version" });
    },
    async stop() {},
    close() {},
  });
  let edge: ReturnType<typeof createDeveloperIDEEdge>;
  const frontend = Bun.serve<DeveloperEditorSocketData>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      try {
        if (request.headers.get("upgrade") === "websocket") {
          const data = await edge.socketData(request);
          if (data instanceof Response) return data;
          if (server.upgrade(request, { data })) return;
          return new Response(null, { status: 400 });
        }
        return await edge.route(request);
      } catch (cause) {
        return Response.json(
          { error: cause instanceof Error ? cause.message : "failed" },
          { status: cause instanceof CommandError ? cause.status : 500 },
        );
      }
    },
    websocket: {
      open(socket) {
        edge.open(socket);
      },
      message(socket, message) {
        edge.message(socket, message);
      },
      close(socket) {
        edge.close(socket);
      },
    },
  });
  const hub = new RuntimeHub(async () => {});
  const noCompute = async (): Promise<never> => {
    throw new Error("Browsing must not start compute");
  };
  edge = createDeveloperIDEEdge(
    database,
    editors,
    sources,
    frontend.url.origin,
    createDeveloperIDERuntime(
      database,
      {
        start: noCompute,
        startPersisted: noCompute,
        processOutput: noCompute,
        processAction: noCompute,
        closeTerminal: noCompute,
      },
      hub,
      createRuntimeAccess(database, (token) => hub.revokeAccess(token)),
    ),
  );
  let socket: WebSocket | undefined;
  try {
    for (const id of [userID, otherUserID])
      await database.client`INSERT INTO auth."user"(id,name,email) VALUES(${id},'Edge fixture',${`${id}@factory.invalid`})`;
    await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by) VALUES(${projectID},${`edge-${projectID}`},'Edge fixture',${`file://${resolve(".factory/runtime-fixture-repository")}`},'main','.devcontainer/devcontainer.json',${userID})`;
    for (const id of [userID, otherUserID])
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by) VALUES(${projectID},${id},'developer',${userID})`;
    await database.client`INSERT INTO auth.session(id,token,user_id,expires_at) VALUES(${sessionID},${crypto.randomUUID()},${userID},now()+interval '1 hour')`;
    await editors.ensure(projectID, userID);
    const source = await sources.ensurePersonal(projectID, userID);
    await eventually(
      () => editors.get(userID),
      (value) => value.state === "ready",
      "Editor did not prepare",
    );
    await eventually(
      () => sources.get(source.workspaceID, userID),
      (value) => value.state === "ready",
      "Source did not prepare",
    );
    const issued = new URL(await edge.issue(userID, sessionID, true, source.workspaceID));
    expect(issued.hostname).toBe(
      `${userID.replaceAll("-", "")}-1-h${frontend.url.port}-editor.runtime.localhost`,
    );
    const redeemed = await edge.route(new Request(issued));
    expect(redeemed.status).toBe(302);
    const setCookie = redeemed.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly; SameSite=None; Secure; Partitioned");
    const cookie = setCookie.split(";")[0] ?? "";
    const editorURL = new URL(redeemed.headers.get("location") ?? "");
    expect(editorURL.searchParams.has("factory-grant")).toBe(false);
    expect((await edge.route(new Request(issued))).status).toBe(401);
    const wrongHost = new URL(editorURL);
    wrongHost.hostname = "127.0.0.1";
    expect((await edge.route(new Request(wrongHost, { headers: { cookie } }))).status).toBe(401);
    const oldHost = new URL(editorURL);
    oldHost.hostname = `${userID.replaceAll("-", "")}.1.editor.runtime.localhost`;
    expect((await edge.route(new Request(oldHost, { headers: { cookie } }))).status).toBe(401);
    const otherListener = new URL(editorURL);
    otherListener.hostname = `${userID.replaceAll("-", "")}.1.h1.editor.runtime.localhost`;
    expect((await edge.route(new Request(otherListener, { headers: { cookie } }))).status).toBe(
      401,
    );
    const wrongUser = new URL(editorURL);
    wrongUser.pathname = wrongUser.pathname.replace(userID, otherUserID);
    expect((await edge.route(new Request(wrongUser, { headers: { cookie } }))).status).toBe(401);
    const response = await edge.route(
      new Request(editorURL, {
        headers: {
          cookie: `${cookie}; theia-connection-token=frontend-token; factory.session_token=do-not-forward`,
          authorization: "Bearer do-not-forward",
          "x-model-key": "must-not-forward",
        },
      }),
    );
    expect(await response.text()).toBe("theia proof");
    expect(response.headers.get("set-cookie")).toContain(`Path=${editorURL.pathname}`);
    expect(response.headers.get("set-cookie")).not.toContain("provider_session");
    expect(upstreamHeaders.at(-1)?.get("cookie")).toBe("theia-connection-token=frontend-token");
    expect(upstreamHeaders.at(-1)?.get("authorization")).toBeNull();
    expect(upstreamHeaders.at(-1)?.get("x-model-key")).toBeNull();
    const otherCookie = await edge.route(
      new Request(new URL("other-cookie", editorURL), { headers: { cookie } }),
    );
    expect(otherCookie.headers.get("set-cookie")).toBeNull();
    await otherCookie.text();
    await expect(
      edge.route(new Request(new URL("redirect", editorURL), { headers: { cookie } })),
    ).rejects.toThrow("external redirect");
    const sourceURL = new URL(`__factory/workspaces/${source.workspaceID}/source/read`, editorURL);
    const runtimeURL = new URL(`__factory/workspaces/${source.workspaceID}/runtime`, editorURL);
    expect(
      await (await edge.route(new Request(runtimeURL, { headers: { cookie } }))).json(),
    ).toEqual({
      workspaceID: source.workspaceID,
      attemptID: null,
      state: "stopped",
      failure: null,
    });
    expect(
      (
        await edge.route(
          new Request(`${runtimeURL}/ensure`, {
            method: "POST",
            headers: { cookie, origin: "https://untrusted.invalid" },
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await edge.route(
          new Request(sourceURL, {
            method: "POST",
            body: '{"path":"src/version.txt"}',
            headers: { cookie, origin: "https://untrusted.invalid" },
          }),
        )
      ).status,
    ).toBe(403);
    const sourceResponse = await edge.route(
      new Request(sourceURL, {
        method: "POST",
        body: '{"path":"src/version.txt"}',
        headers: { cookie, origin: editorURL.origin },
      }),
    );
    expect(await sourceResponse.json()).toEqual({ content: "aHVtYW4=", version: "version" });
    const watcher = await edge.route(
      new Request(new URL(`__factory/workspaces/${source.workspaceID}/source/events`, editorURL), {
        headers: { cookie },
      }),
    );
    const reader = watcher.body?.getReader();
    expect(reader).toBeDefined();
    await reader?.read();
    const closeResult = Promise.withResolvers<void>();
    socket = new ClientSocket(
      `${frontend.url.origin.replace("http:", "ws:")}${editorURL.pathname}socket.io/`,
      {
        headers: {
          host: editorURL.host,
          origin: editorURL.origin,
          cookie: `${cookie}; theia-connection-token=frontend-token; factory.session_token=do-not-forward`,
        },
      },
    );
    const connected = Promise.withResolvers<void>();
    const echoed = Promise.withResolvers<string>();
    socket.addEventListener("open", () => {
      connected.resolve();
      socket?.send("queued immediately");
    });
    socket.addEventListener("message", (event) => echoed.resolve(String(event.data)));
    socket.addEventListener("close", () => closeResult.resolve());
    socket.addEventListener("error", () => connected.reject(new Error("Editor socket failed")));
    await connected.promise;
    expect(await echoed.promise).toBe("queued immediately");
    expect(upstreamHeaders.at(-1)?.get("cookie")).toBe("theia-connection-token=frontend-token");
    const revocations = createAccessRevocation(
      database,
      createAccountRevocation({
        database,
        sweepRuntime: async () => {},
        reconcileEditor: (id) => edge.sweep(id),
        reconcileSources: (id) => sources.reconcileUserAccess(id),
        stopRuntime: noCompute,
        stopAgent: noCompute,
        reconcileForge: async () => {
          throw new Error("Owned unavailable Forge rights reconciliation");
        },
      }),
    );
    try {
      // A failed external reconciliation is retried. The real editor grant,
      // source stream and socket must survive while their authority is unchanged.
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(revocations.drain()).rejects.toThrow(
          "Owned unavailable Forge rights reconciliation",
        );
        expect((await edge.route(new Request(editorURL, { headers: { cookie } }))).status).toBe(
          200,
        );
        const read = await edge.route(
          new Request(sourceURL, {
            method: "POST",
            body: '{"path":"src/version.txt"}',
            headers: { cookie, origin: editorURL.origin },
          }),
        );
        expect(await read.json()).toEqual({ content: "aHVtYW4=", version: "version" });
        expect(socket.readyState).toBe(WebSocket.OPEN);
      }
    } finally {
      await revocations.close();
    }
    await database.client`DELETE FROM auth.session WHERE id=${sessionID}`;
    await edge.sweep();
    await closeResult.promise;
    expect((await reader?.read())?.done).toBe(true);
    expect((await edge.route(new Request(editorURL, { headers: { cookie } }))).status).toBe(401);
    expect(
      await database.client`SELECT id FROM factory.runtime_attempt WHERE project_id=${projectID}`,
    ).toHaveLength(0);
  } finally {
    socket?.close();
    // Bun 1.3.14 leaves the stop promise pending after server-initiated WS close.
    // Assert the real listener shutdown rather than that stale connection counter.
    void frontend.stop(true);
    await backend.stop(true);
    await editors.close();
    await sources.close();
    for (const [key, value] of [
      ["FACTORY_DEVELOPER_IDE_IMAGE", previous.editor],
      ["FACTORY_WORKSPACE_FILES_IMAGE", previous.files],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      await expect(fetch(frontend.url, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
    } finally {
      await database.client.end({ timeout: 2 });
      await fixture.dispose();
    }
  }
}, 30_000);
