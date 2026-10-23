import { expect, test } from "bun:test";
import { clarifyProjectInput } from "../../apps/factory/src/project-agent/input";
import { mcpSourceAlias } from "../../apps/factory/src/mcp/sources";
import { monitoringFixture } from "../fixtures/monitoring";

for (const { consult, explicit } of [
  { consult: true, explicit: true },
  { consult: false, explicit: true },
  { consult: false, explicit: false },
])
  test(`Input clarification requires selected and inherited-required source evidence: consulted=${consult}, explicit=${explicit}`, async () => {
    const f = await monitoringFixture();
    const incidentId = await f.receive();
    const authority = await f.controller.authorize(incidentId);
    const alias = mcpSourceAlias(f.source.id, "read_issue");
    let requests = 0;
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = await request.json();
        requests++;
        if (requests === 1) expect(body.tool_choice).toBe("required");
        const call = consult && requests === 1;
        return Response.json({
          id: `owned-clarify-${requests}`,
          object: "chat.completion",
          created: 1,
          model: "owned-planning",
          choices: [
            {
              index: 0,
              message: call
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "owned-input-call",
                        type: "function",
                        function: { name: alias, arguments: '{"id":"42"}' },
                      },
                    ],
                  }
                : {
                    role: "assistant",
                    content: JSON.stringify({
                      output: {
                        kind: "requirement",
                        message: "Prepared requirements.",
                        citations: [],
                        ticket: {
                          title: "Handle missing invoices",
                          description: "Avoid dereferencing an absent invoice.",
                        },
                        requirement: {
                          summary: "Return null for missing invoices.",
                          acceptanceCriteria: ["Missing invoices return null."],
                          nonGoals: [],
                        },
                      },
                    }),
                  },
              finish_reason: call ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        });
      },
    });
    try {
      const result = await clarifyProjectInput({
        ...authority,
        database: f.database,
        title: explicit ? "Invoice feedback" : "I".repeat(300),
        context: "Issue 42",
        instructions: "Read issue 42 and prepare requirements.",
        sourceIds: explicit ? [f.source.id] : [],
        modelId: "owned-planning",
        connection: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "owned-key" },
        mcp: f.mcp,
        skills: [],
        skillAssignment: {
          revisionIds: [],
          requiredRevisionIds: [],
          projectContext: {},
          codeAccess: false,
        },
        code: {
          codePaths: async () => {
            throw new Error("No code access");
          },
          code: async () => {
            throw new Error("No code access");
          },
        },
        signal: AbortSignal.timeout(5000),
        authorize: async () => {},
        observe: async () => {},
        usage: { begin: async () => {}, record: async () => {}, settle: async () => {} },
      });
      expect(result.outcome).toBe(consult ? "ticket" : "insufficient-context");
      expect(Boolean(result.requirements)).toBe(consult);
      expect(result.title.length).toBeLessThanOrEqual(200);
      expect(f.sourceCalls()).toBe(consult ? 1 : 0);
      expect(await f.database.client`SELECT id FROM factory.ticket`).toHaveLength(0);
    } finally {
      await provider.stop(true);
      await f.dispose();
    }
  });
