import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { connectOpenCodeBrowser } from "../../apps/factory/src/agent/opencode-browser";
import { createBuildBrowserEndpoint } from "../../apps/factory/src/agent/browser-endpoint";
import {
  confirmSettledOpenCodeInput,
  ensureOpenCodeMessageBoundary,
} from "../../apps/factory/src/agent/opencode-client";
import {
  buildBrowserCallInput,
  buildBrowserToolCatalogue,
} from "../../packages/conversation-domain/src/browser-tools";
import { buildModelID } from "../fixtures/change-agent-turns";
import { observe, pinnedOpenCode } from "../fixtures/pinned-opencode";
import { ownedBrowserJPEG } from "../fixtures/browser-image";

test("pinned native MCP registration delivers browser images without a shell/read detour or source config", async () => {
  let authorized = true;
  const calls: string[] = [];
  let protectedCalls = 0;
  const session = {
    id: crypto.randomUUID(),
    turnID: crypto.randomUUID(),
    changeID: crypto.randomUUID(),
    attemptID: crypto.randomUUID(),
    generation: 1,
    agentSessionID: "ses_owned_mcp",
    ownerID: "owned",
    state: "active" as const,
  };
  const facade = createBuildBrowserEndpoint({
    authorize: async (id, authorization) =>
      authorized && id === session.id && authorization === "Bearer owned-native-mcp-capability"
        ? { session, ownerToken: "owned" }
        : null,
    authorizeRuntime: async () => null,
    call: async (_session, _owner, call) => {
      expect(buildBrowserCallInput.parse(call).name).toBe("browser_screenshot");
      protectedCalls++;
      return {
        content: [{ type: "image", mimeType: "image/jpeg", data: ownedBrowserJPEG }],
        structuredContent: {
          sessionId: session.id,
          turnId: session.turnID,
          changeId: session.changeID,
          runtimeAttemptId: session.attemptID,
          generation: 1,
          app: "app",
          headCommit: "a".repeat(40),
          workingTreeModified: false,
          observedAt: new Date().toISOString(),
        },
      };
    },
  });
  const endpoint = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    async fetch(request) {
      if (request.method === "POST") {
        const rpc = (await request.clone().json()) as { method: string };
        calls.push(rpc.method);
      }
      return facade(request, session.id);
    },
  });
  const target = await pinnedOpenCode().catch(async (cause) => {
    await endpoint.stop(true);
    throw cause;
  });
  try {
    const filesBefore = await readdir(resolve(target.scratch, "project"));
    const sessionID = `ses_owned_mcp_${crypto.randomUUID().replaceAll("-", "")}`;
    await target.client.session.create({
      id: sessionID,
      title: "Native restricted browser",
      location: { directory: "/workspace/project" },
      model: { providerID: "factory", id: buildModelID },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    });
    await ensureOpenCodeMessageBoundary(target.client, sessionID);
    await target.control("/release", "POST");
    // Match retained Build sessions: the native tool registry has already been
    // used before Factory registers the browser immediately before a new turn.
    const warmPromptID = `msg_warm_${crypto.randomUUID().replaceAll("-", "")}`;
    await target.client.session.prompt({
      sessionID,
      id: warmPromptID,
      text: "Reply briefly without using tools.",
      delivery: "queue",
      resume: true,
    });
    await observe(
      () => target.client.message.list({ sessionID, limit: 20 }),
      (page) =>
        page.data.some(
          (message) => message.type === "assistant" && Boolean(message.time.completed),
        ),
    );
    await observe(
      () => confirmSettledOpenCodeInput(target.client, sessionID, warmPromptID),
      Boolean,
    );
    const previousRequests = (await target.control()).providerRequests;
    await connectOpenCodeBrowser(
      target.client,
      `http://host.orb.internal:${endpoint.port}/fixed`,
      "owned-native-mcp-capability",
    );
    expect(calls).toContain("initialize");
    expect(calls).toContain("tools/list");
    await target.control("/browser-mcp", "POST");
    await target.client.session.prompt({
      sessionID,
      id: `msg_owned_mcp_${crypto.randomUUID().replaceAll("-", "")}`,
      text: "Use the native browser screenshot tool and inspect its image, then finish.",
      delivery: "queue",
      resume: true,
    });
    const state = await observe(
      () => target.control(),
      (state) => {
        if (state.providerRequests > previousRequests && !state.browserTools.length)
          throw new Error(`Native browser tools absent: ${JSON.stringify(state)}`);
        if (state.providerRequests >= previousRequests + 2 && !state.imageRequests)
          throw new Error("The native tool result reached the model without an image");
        return state.imageRequests > 0;
      },
      "Native MCP image did not reach the model",
      30_000,
    );
    expect(state.imageRequests).toBe(1);
    expect(state.browserContextRequests).toBe(1);
    expect(state.browserTools).toHaveLength(buildBrowserToolCatalogue.length);
    expect(calls.filter((method) => method === "tools/call")).toHaveLength(1);
    expect(protectedCalls).toBe(1);
    const messages = await target.client.message.list({ sessionID, limit: 20 });
    const tools = messages.data.flatMap((message) =>
      message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
    );
    expect(tools.some((part) => part.name.includes("browser_screenshot"))).toBe(true);
    expect(tools.some((part) => part.name === "shell" || part.name === "read")).toBe(false);
    expect(await readdir(resolve(target.scratch, "project"))).toEqual(filesBefore);
    // No Project config is created, including hidden config subdirectories.
    expect(await Bun.file(resolve(target.scratch, "project/opencode.json")).exists()).toBe(false);
    expect(
      await readFile(resolve(target.scratch, "project/.git/factory-opencode.db")),
    ).toBeTruthy();
    authorized = false;
    const rejected = await fetch(`http://127.0.0.1:${endpoint.port}/fixed`, {
      method: "POST",
      headers: {
        authorization: "Bearer owned-native-mcp-capability",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "after-revocation",
        method: "tools/call",
        params: { name: "browser_screenshot", arguments: {} },
      }),
    });
    expect(rejected.status).toBe(403);
    expect(protectedCalls).toBe(1);
    await target.client.mcp.remove({
      server: "factory_browser",
      location: { directory: "/workspace/project" },
    });
    expect(
      (await target.client.mcp.list({ location: { directory: "/workspace/project" } })).data,
    ).toEqual([]);
  } catch (cause) {
    console.error(
      "Owned native MCP diagnostic",
      JSON.stringify(await target.control()),
      await target.diagnostics(),
    );
    throw cause;
  } finally {
    try {
      await target.dispose();
    } finally {
      await endpoint.stop(true);
    }
  }
}, 120_000);
