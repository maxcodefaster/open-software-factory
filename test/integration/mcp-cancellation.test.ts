import { expect, test } from "bun:test";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { MCPAssignment } from "#conversation-domain/mcp-library";
import { createMCPConnections } from "../../apps/factory/src/mcp/connections";
import { factoryProcess } from "../fixtures/factory-process";

for (const phase of ["initialize", "tools/list", "tools/call"] as const) {
  test(`MCP calls propagate cancellation through ${phase} without later dispatch`, async () => {
    const host = await factoryProcess();
    const database = host.connect();
    const userId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const id = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const controller = new AbortController();
    const entered = Promise.withResolvers<Request>();
    const release = Promise.withResolvers<Response>();
    let blocking = false;
    let calls = 0;
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: "Owned cancellation source", version: "1" });
      server.registerTool(
        "read",
        { inputSchema: z.object({}), annotations: { readOnlyHint: true } },
        async () => {
          calls++;
          return { content: [{ type: "text", text: "Owned read" }] };
        },
      );
      return server;
    });
    const connections = createMCPConnections(
      database,
      {
        configured: false,
        read: async () => undefined,
        create: async () => {
          throw new Error("The owned cancellation source has no credentials");
        },
      },
      "owned-cancellation-key",
      "https://factory.example",
      async (input, init) => {
        const request = new Request(input, init);
        if (blocking && request.method === "POST") {
          const message = await request.clone().json();
          if (message.method === phase) {
            entered.resolve(request);
            request.signal.addEventListener("abort", () => release.reject(request.signal.reason), {
              once: true,
            });
            return release.promise;
          }
        }
        return handler.fetch(request);
      },
    );
    let work: Promise<unknown> | undefined;
    try {
      await database.client`INSERT INTO auth."user"(id,name,email,email_verified)
        VALUES(${userId},'Owned cancellation manager',${`${userId}@cancellation.test`},true)`;
      await database.client`INSERT INTO factory.administrator(user_id) VALUES(${userId})`;
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by)
        VALUES(${projectId},${`owned-cancellation-${projectId}`},'Owned cancellation Project',
          'https://forge.example/owned/cancellation.git','main','.factory/actor-template.json',${userId})`;
      await connections.library.save(
        {
          libraryId: id,
          revisionId,
          expectedRevision: 0,
          scope: "project",
          projectId,
          content: {
            name: "Owned cancellation source",
            description: "Owned controlled transport",
            endpoint: "https://source.example/mcp",
            provider: "custom",
            authentication: "none",
            roles: ["planning"],
          },
        },
        userId,
      );
      await connections.connect(id, userId, {
        commandId: crypto.randomUUID(),
        revisionId,
        expectedVersion: 0,
      });
      const full = await database.client.begin((sql) => connections.library.connectionIn(sql, id));
      const tool = full.tools[0];
      if (!tool) throw new Error("Owned read tool missing");
      await connections.library.review(id, userId, full.version, [
        { name: tool.name, digest: tool.digest },
      ]);
      const assignment: MCPAssignment = {
        connectionId: id,
        revisionId,
        credentialEpoch: full.credentialEpoch,
        policyVersion: full.version + 1,
        tools: [tool],
        required: true,
      };
      const call = (signal: AbortSignal, authorize: () => Promise<void> = async () => {}) =>
        connections.call(assignment, projectId, userId, "read", {}, authorize, signal);
      blocking = true;
      work = call(controller.signal);
      void work.catch(() => {});
      const request = await entered.promise;
      controller.abort(new Error("Owned caller stopped"));
      expect(request.signal.aborted).toBe(true);
      await expect(work).rejects.toThrow();
      expect(calls).toBe(0);
      expect(
        (await database.client.begin((sql) => connections.library.connectionIn(sql, id))).state,
      ).toBe("ready");
      blocking = false;
      await expect(call(controller.signal)).rejects.toThrow();
      expect(calls).toBe(0);
      // Cancellation while checking authority must not open another transport.
      const duringAuthorization = new AbortController();
      await expect(
        call(duringAuthorization.signal, async () => duringAuthorization.abort()),
      ).rejects.toThrow();
      expect(calls).toBe(0);
      expect(await call(new AbortController().signal)).toEqual({
        content: "Owned read",
        isError: false,
      });
      expect(calls).toBe(1);
    } finally {
      release.reject(new Error("Owned fixture released"));
      await work?.catch(() => {});
      await handler.close();
      await database.client.end();
      await host.dispose();
    }
  }, 60_000);
}
