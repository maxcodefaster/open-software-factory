import { mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";
import { createDeveloperIDEEdge } from "../../apps/factory/src/workspace/developer-ide-edge";
import { CommandError } from "../../apps/factory/src/command-error";

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Owned editor listener missing");
  return `http://127.0.0.1:${address.port}`;
}

async function fixture() {
  const userID = crypto.randomUUID();
  const state = {
    editor: "ready" as "ready" | "preparing" | "stop-intended",
    backendReady: false,
    documents: 0,
    writes: 0,
  };
  const backend = createServer((request, response) => {
    if (request.method !== "GET") state.writes++;
    if (request.url === "/") state.documents++;
    response.writeHead(state.backendReady ? 200 : 503, { "content-type": "text/html" });
    response.end(
      state.backendReady
        ? "<!doctype html><html><body><h1>Editor ready</h1><label>Unsaved editor buffer<input></label></body></html>"
        : "Controlled editor backend is temporarily unavailable",
    );
  });
  const backendOrigin = await listen(backend);
  let edge: ReturnType<typeof createDeveloperIDEEdge>;
  const frontend = createServer(async (request, response) => {
    try {
      if (request.method !== "GET") state.writes++;
      const result = await edge.route(
        new Request(`http://${request.headers.host}${request.url}`, {
          headers: Object.fromEntries(
            Object.entries(request.headers).flatMap(([name, value]) =>
              typeof value === "string" ? [[name, value]] : [],
            ),
          ),
        }),
      );
      response.writeHead(result.status, {
        ...Object.fromEntries(result.headers),
        ...(result.headers.getSetCookie().length
          ? { "set-cookie": result.headers.getSetCookie() }
          : {}),
      });
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (cause) {
      response.writeHead(cause instanceof CommandError ? cause.status : 500, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ error: "Controlled editor connection failed" }));
    }
  });
  const origin = await listen(frontend);
  edge = createDeveloperIDEEdge(
    { client: async () => [{ id: "owned-session" }] } as unknown as Parameters<
      typeof createDeveloperIDEEdge
    >[0],
    {
      get: async () => ({ epoch: 1, state: state.editor }),
      async connection() {
        if (state.editor !== "ready") throw new CommandError("unavailable", "Editor preparing");
        return backendOrigin;
      },
    } as unknown as Parameters<typeof createDeveloperIDEEdge>[1],
    {} as Parameters<typeof createDeveloperIDEEdge>[2],
    origin,
    { revokeEditor() {}, route: async () => undefined } as unknown as Parameters<
      typeof createDeveloperIDEEdge
    >[4],
  );
  return {
    state,
    url: await edge.issue(userID, "owned-session", false),
    async dispose() {
      for (const server of [frontend, backend]) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };
}

test("an unavailable initial editor reconnects without reloading a later dirty editor", async ({
  page,
}) => {
  const owned = await fixture();
  try {
    await page.goto(owned.url);
    await expect(page.getByRole("status")).toHaveText("Reconnecting to your editor…");
    await mkdir(".factory/test-results/editor-auto-recovery", { recursive: true });
    await page.screenshot({
      path: ".factory/test-results/editor-auto-recovery/initial-wait-wide.png",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: ".factory/test-results/editor-auto-recovery/initial-wait-narrow.png",
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    owned.state.editor = "preparing";
    await expect(page.getByRole("status")).toBeVisible();
    owned.state.editor = "ready";
    owned.state.backendReady = true;
    await expect(page.getByRole("heading", { name: "Editor ready", exact: true })).toBeVisible({
      timeout: 5_000,
    });
    const buffer = page.getByRole("textbox", { name: "Unsaved editor buffer", exact: true });
    await buffer.fill("Retain this dirty buffer");
    const loaded = owned.state.documents;
    owned.state.backendReady = false;
    owned.state.editor = "preparing";
    // Cross the waiting document's retry interval. A live editor has no such timer.
    await page.waitForTimeout(1_500);
    await expect(buffer).toHaveValue("Retain this dirty buffer");
    expect(owned.state.documents).toBe(loaded);
    expect(owned.state.writes).toBe(0);
  } finally {
    await owned.dispose();
  }
});

test("Stop ends initial editor recovery and readiness cannot revive its revoked grant", async ({
  page,
}) => {
  const owned = await fixture();
  try {
    await page.goto(owned.url);
    await expect(page.getByRole("status")).toHaveText("Reconnecting to your editor…");
    owned.state.editor = "stop-intended";
    await expect(page.locator("body")).toContainText("Editor access required", {
      timeout: 5_000,
    });
    const loaded = owned.state.documents;
    owned.state.editor = "ready";
    owned.state.backendReady = true;
    await page.waitForTimeout(1_500);
    await expect(page.getByRole("heading", { name: "Editor ready", exact: true })).toHaveCount(0);
    expect(owned.state.documents).toBe(loaded);
    expect(owned.state.writes).toBe(0);
  } finally {
    await owned.dispose();
  }
});
