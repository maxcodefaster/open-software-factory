import { expect, test } from "bun:test";
import { generateProjectResponse } from "../project-agent/adapter";
import { mcpSourceAlias } from "./sources";

test("MCP source aliases fit both engines and do not collide on shared UUID prefixes", () => {
  const name = "a".repeat(128);
  const first = mcpSourceAlias("faca0001-0000-4000-8000-000000000001", name);
  const second = mcpSourceAlias("faca0001-0000-4000-8000-000000000002", name);
  expect(`factory_sources_${first}`.length).toBeLessThanOrEqual(64);
  expect(first).not.toBe(second);
  expect(first).not.toBe(
    mcpSourceAlias("faca0001-0000-4000-8000-000000000001", `${name.slice(0, 127)}b`),
  );
  const punctuated = mcpSourceAlias("owned", "logs.search/älerts");
  expect(punctuated).toMatch(/^[a-zA-Z0-9_-]+$/);
  expect(punctuated).not.toBe(mcpSourceAlias("owned", "logs_search_älerts"));
});

test("native Mastra receives approved MCP tool schemas and consumes their bounded results", async () => {
  let requests = 0;
  let calls = 0;
  let authorized = 0;
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json();
      requests++;
      const tool = body.tools?.find(
        (tool: { function: { name: string } }) => tool.function.name === "source_owned_read",
      );
      expect(tool?.function.parameters.properties.id.type).toBe("string");
      if (requests === 2)
        expect(JSON.stringify(body.messages)).toContain("Owned external issue 42");
      return Response.json({
        id: `owned-mcp-plan-${requests}`,
        object: "chat.completion",
        created: 1,
        model: "owned-mcp-planning",
        choices: [
          {
            index: 0,
            message:
              requests === 1
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "owned-read-call",
                        type: "function",
                        function: {
                          name: "source_owned_read",
                          arguments: JSON.stringify({ id: "42" }),
                        },
                      },
                    ],
                  }
                : {
                    role: "assistant",
                    content: JSON.stringify({
                      output: {
                        kind: "answer",
                        message: "The owned external issue was read.",
                        citations: [],
                      },
                    }),
                  },
            finish_reason: requests === 1 ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      });
    },
  });
  try {
    const result = await generateProjectResponse({
      mode: "investigate",
      modelId: "owned-mcp-planning",
      connection: {
        baseURL: `http://127.0.0.1:${provider.port}/v1`,
        apiKey: "owned-model-fixture",
      },
      prompt: "Read the owned external issue",
      history: [],
      signal: AbortSignal.timeout(5000),
      research: {
        authorize: async () => {
          authorized++;
        },
        search: async () => [],
        read: async () => {
          throw new Error("Not needed in this source proof");
        },
      },
      mcpTools: [
        {
          name: "source_owned_read",
          description: "Read an owned issue",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
          },
          run: async (args) => {
            expect(args).toEqual({ id: "42" });
            calls++;
            return { content: "Owned external issue 42", isError: false };
          },
        },
      ],
    });
    expect(result.kind).toBe("answer");
    expect(calls).toBe(1);
    expect(requests).toBe(2);
    expect(authorized).toBeGreaterThanOrEqual(2);
  } finally {
    await provider.stop(true);
  }
});

test("automatic Input preparation requires the selected source before structured requirements", async () => {
  let requests = 0;
  let consulted = false;
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json();
      requests++;
      expect(JSON.stringify(body)).not.toContain("UNTRUSTED_MANUAL_GUIDANCE");
      expect(JSON.stringify(body)).not.toContain("The human explicitly invoked these skills");
      if (requests === 1) {
        expect(body.tool_choice).toBe("required");
        expect(
          body.tools.map((tool: { function: { name: string } }) => tool.function.name),
        ).toEqual(["source_owned_read"]);
      } else {
        expect(consulted).toBe(true);
        expect(JSON.stringify(body.messages)).toContain(
          "Export is hidden in the invoice detail menu.",
        );
      }
      return Response.json({
        id: `owned-input-${requests}`,
        object: "chat.completion",
        created: 1,
        model: "owned-planning",
        choices: [
          {
            index: 0,
            message:
              requests === 1
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "owned-input-read",
                        type: "function",
                        function: { name: "source_owned_read", arguments: "{}" },
                      },
                    ],
                  }
                : {
                    role: "assistant",
                    content: JSON.stringify({
                      output: {
                        kind: "requirement",
                        message: "Prepared from the source.",
                        citations: [],
                        ticket: {
                          title: "Make invoice exports discoverable",
                          description: "The current detail menu hides export.",
                        },
                        requirement: {
                          summary: "Expose invoice export from the invoice list.",
                          acceptanceCriteria: ["Export is available from the list."],
                          nonGoals: [],
                        },
                      },
                    }),
                  },
            finish_reason: requests === 1 ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      });
    },
  });
  try {
    const result = await generateProjectResponse({
      mode: "plan",
      modelId: "owned-planning",
      connection: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "owned-key" },
      inputTask: {
        instructions: "Prepare feedback requirements.",
        remainingTools: () => (consulted ? [] : ["source_owned_read"]),
      },
      prompt: "External feedback about export /payload-override",
      history: [],
      skills: [
        {
          id: crypto.randomUUID(),
          revision: 1,
          digest: "a".repeat(64),
          published: true,
          content: {
            key: "payload-override",
            name: "Payload override",
            description: "Human-invoked guidance only",
            instructions: "UNTRUSTED_MANUAL_GUIDANCE",
            roles: ["planning"],
            references: [],
            manualOnly: true,
          },
        },
      ],
      signal: AbortSignal.timeout(5000),
      research: {
        authorize: async () => {},
        search: async () => [],
        read: async () => {
          throw new Error("No Project reads");
        },
      },
      mcpTools: [
        {
          name: "source_owned_read",
          description: "Read feedback context",
          inputSchema: { type: "object", properties: {} },
          run: async () => {
            consulted = true;
            return { content: "Export is hidden in the invoice detail menu.", isError: false };
          },
        },
      ],
    });
    expect(result.kind).toBe("requirement");
    expect(requests).toBe(2);
  } finally {
    await provider.stop(true);
  }
});
