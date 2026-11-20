import { expect, spyOn, test } from "bun:test";
import type { OAuthClientProvider } from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createRemoteMCP } from "./remote";

for (const phase of [
  "initialize",
  "notifications/initialized",
  "tools/list",
  "next-page",
  "catalogue-deadline",
  "oauth-discovery",
  "oauth-close",
]) {
  test(`Remote MCP cancellation aborts ${phase} and closes the transport`, async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<Request>();
    const release = Promise.withResolvers<Response>();
    const methods: string[] = [];
    const oauth = phase.startsWith("oauth");
    const paginated = phase === "next-page" || phase === "catalogue-deadline";
    const deadlines: AbortController[] = [];
    const timeout =
      phase === "catalogue-deadline"
        ? spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
            expect(milliseconds).toBe(30_000);
            const deadline = new AbortController();
            deadlines.push(deadline);
            return deadline.signal;
          })
        : undefined;
    const provider: OAuthClientProvider = {
      redirectUrl: "https://factory.example/callback",
      clientMetadata: { redirect_uris: ["https://factory.example/callback"] },
      state: () => "owned-state",
      clientInformation: () => undefined,
      tokens: () => undefined,
      saveTokens: async () => {},
      redirectToAuthorization: async () => {},
      saveCodeVerifier: async () => {},
      codeVerifier: () => "owned-verifier",
    };
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: "Owned cancellation source", version: "1" });
      server.registerTool(
        "read",
        { inputSchema: z.object({}), annotations: { readOnlyHint: true } },
        async () => ({ content: [{ type: "text", text: "Owned read" }] }),
      );
      return server;
    });
    const remote = createRemoteMCP(
      "https://source.example/mcp",
      oauth ? provider : undefined,
      async (input, init) => {
        const request = new Request(input, init);
        const block = () => {
          entered.resolve(request);
          request.signal.addEventListener("abort", () => release.reject(request.signal.reason), {
            once: true,
          });
          return release.promise;
        };
        if (oauth && request.url.includes(".well-known")) return block();
        if (request.method === "POST") {
          const message = await request.clone().json();
          methods.push(message.method);
          if (oauth)
            return new Response(null, {
              status: 401,
              headers: {
                "www-authenticate":
                  'Bearer resource_metadata="https://source.example/.well-known/oauth-protected-resource"',
              },
            });
          if (paginated && message.method === "tools/list" && !message.params?.cursor)
            return Response.json({
              jsonrpc: "2.0",
              id: message.id,
              result: { tools: [], nextCursor: "owned-next-page" },
            });
          if (
            message.method === phase ||
            (paginated && message.method === "tools/list" && message.params?.cursor)
          ) {
            return block();
          }
        }
        return handler.fetch(request);
      },
      controller.signal,
    );
    const close = spyOn(remote.transport, "close");
    const requests = spyOn(remote.client, "request");
    const work = (async () => {
      try {
        await remote.connect();
        await remote.tools();
      } finally {
        await remote.close();
      }
    })();
    // Observe rejection immediately, including failure paths in fixture cleanup.
    void work.catch(() => {});
    try {
      const request = await entered.promise;
      if (phase === "oauth-close") await remote.close();
      else if (phase === "catalogue-deadline") {
        expect(deadlines).toHaveLength(2);
        const pages = requests.mock.calls.filter(([request]) => request.method === "tools/list");
        expect(pages).toHaveLength(2);
        const pageSignals = pages.map(([, options]) =>
          options && "signal" in options ? options.signal : undefined,
        );
        expect(pageSignals[0]).toBeInstanceOf(AbortSignal);
        expect(pageSignals[0]).toBe(pageSignals[1]);
        deadlines[1]?.abort(new Error("Owned catalogue deadline elapsed"));
      } else controller.abort(new Error("Owned caller stopped"));
      if (phase !== "catalogue-deadline") expect(request.signal.aborted).toBe(true);
      await expect(work).rejects.toThrow();
      expect(request.signal.aborted).toBe(true);
      expect(close).toHaveBeenCalled();
      expect(methods).not.toContain("tools/call");
      if (paginated) expect(methods.filter((method) => method === "tools/list")).toHaveLength(2);
    } finally {
      release.reject(new Error("Owned fixture released"));
      await remote.close();
      await work.catch(() => {});
      close.mockRestore();
      requests.mockRestore();
      await handler.close();
      timeout?.mockRestore();
    }
  });
}

test("Remote MCP refuses an already cancelled lifetime before sending a request", async () => {
  const controller = new AbortController();
  controller.abort(new Error("Owned caller already stopped"));
  let requests = 0;
  const remote = createRemoteMCP(
    "https://source.example/mcp",
    undefined,
    async () => {
      requests++;
      throw new Error("A cancelled lifetime must not dispatch");
    },
    controller.signal,
  );
  try {
    await expect(remote.connect()).rejects.toThrow();
    await expect(remote.tools()).rejects.toThrow();
    expect(requests).toBe(0);
  } finally {
    await remote.close();
  }
});
