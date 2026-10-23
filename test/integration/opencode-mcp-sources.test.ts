import { expect, test } from "bun:test";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { connectOpenCodeSources } from "../../apps/factory/src/agent/opencode-browser";
import { candidateReviewPermissions } from "../../packages/conversation-domain/src/candidate-review";
import { mcpSourceAlias } from "../../apps/factory/src/mcp/sources";
import { buildModelID } from "../fixtures/change-agent-turns";
import { observe, pinnedOpenCode } from "../fixtures/pinned-opencode";

test("pinned OpenCode consumes Factory MCP source tools natively while independent review cannot call them", async () => {
  let calls = 0;
  let requests = 0;
  const sourceName = mcpSourceAlias(
    crypto.randomUUID(),
    "read_issue_with_a_long_provider_tool_name_that_must_fit_native_limits",
  );
  const nativeName = `factory_sources_${sourceName}`;
  const catalogues: string[][] = [];
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "owned-factory-sources", version: "1" });
    server.registerTool(
      sourceName,
      {
        description: "Read the owned source issue",
        inputSchema: z.object({ id: z.string() }),
        annotations: { readOnlyHint: true },
      },
      async ({ id }) => {
        calls++;
        expect(id).toBe("owned-42");
        return { content: [{ type: "text", text: "Owned source diagnosis" }] };
      },
    );
    return server;
  });
  const endpoint = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    fetch(request) {
      if (request.headers.get("authorization") !== "Bearer owned-turn-capability")
        return new Response(null, { status: 403 });
      return handler.fetch(request);
    },
  });
  const provider = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    async fetch(request) {
      const body = await request.json();
      expect(JSON.stringify(body)).not.toContain("owned-turn-capability");
      catalogues.push(
        (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name),
      );
      requests++;
      const call = requests === 1 || requests === 3;
      const chunk = (delta: unknown, finish_reason: string | null = null) => ({
        id: `owned-source-${requests}`,
        object: "chat.completion.chunk",
        model: buildModelID,
        choices: [{ index: 0, delta, finish_reason }],
      });
      return new Response(
        [
          `data: ${JSON.stringify(
            chunk(
              call
                ? {
                    tool_calls: [
                      {
                        index: 0,
                        id: `owned-tool-${requests}`,
                        type: "function",
                        function: {
                          name: nativeName,
                          arguments: JSON.stringify({ id: "owned-42" }),
                        },
                      },
                    ],
                  }
                : { content: "Owned source proof finished." },
            ),
          )}\n\n`,
          `data: ${JSON.stringify(chunk({}, call ? "tool_calls" : "stop"))}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  let native: Awaited<ReturnType<typeof pinnedOpenCode>> | undefined;
  try {
    native = await pinnedOpenCode(
      undefined,
      undefined,
      undefined,
      `http://host.orb.internal:${provider.port}/v1`,
    );
    await connectOpenCodeSources(
      native.client,
      `http://host.orb.internal:${endpoint.port}/internal/build-browser/owned/turn`,
      "owned-turn-capability",
    );
    const buildId = `ses_sources_${crypto.randomUUID().replaceAll("-", "")}`;
    await native.client.session.create({
      id: buildId,
      title: "Owned native source proof",
      location: { directory: "/workspace/project" },
      model: { providerID: "factory", id: buildModelID },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    });
    await native.client.session.prompt({
      sessionID: buildId,
      id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
      text: "Read the owned source issue.",
      delivery: "queue",
      resume: true,
    });
    await observe(
      () => native!.client.message.list({ sessionID: buildId, limit: 50 }),
      (page) =>
        requests >= 2 &&
        page.data.some(
          (message) => message.type === "assistant" && Boolean(message.time.completed),
        ),
      "Owned native source call did not settle",
      30_000,
    );
    expect(calls).toBe(1);
    expect(catalogues[0]).toContain(nativeName);
    const reviewerId = `ses_sources_review_${crypto.randomUUID().replaceAll("-", "")}`;
    await native.client.session.create({
      id: reviewerId,
      title: "Owned source deny proof",
      location: { directory: "/workspace/project" },
      model: { providerID: "factory", id: buildModelID },
      permissions: candidateReviewPermissions,
    });
    await native.client.session.prompt({
      sessionID: reviewerId,
      id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
      text: "Finish the restricted review.",
      delivery: "queue",
      resume: true,
    });
    await observe(
      () => native!.client.message.list({ sessionID: reviewerId, limit: 50 }),
      (page) =>
        requests >= 4 &&
        page.data.some(
          (message) => message.type === "assistant" && Boolean(message.time.completed),
        ),
      "Owned native source denial did not settle",
      30_000,
    );
    expect(catalogues[2]).not.toContain(nativeName);
    expect(calls).toBe(1);
  } finally {
    await native?.dispose();
    await endpoint.stop(true);
    await provider.stop(true);
    await handler.close();
  }
}, 120_000);
