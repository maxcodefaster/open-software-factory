import { expect, test } from "bun:test";
import type { MCPAssignment } from "../../../../packages/conversation-domain/src/mcp-library";
import { mcpSourceAlias } from "../mcp/sources";
import { diagnoseMonitoringIncident } from "./diagnosis";

for (const scenario of ["grounded", "ungrounded", "missing", "exhausted"] as const) {
  test(`monitoring diagnosis gates native tools and rejects ungrounded fixes: ${scenario}`, async () => {
    const grounded = scenario === "grounded";
    const missing = scenario === "missing";
    const exhausted = scenario === "exhausted";
    const noFix = missing || exhausted;
    const connectionId = crypto.randomUUID();
    const commit = "a".repeat(40);
    const source = mcpSourceAlias(connectionId, "read_issue");
    const assignment: MCPAssignment = {
      connectionId,
      credentialEpoch: crypto.randomUUID(),
      revisionId: crypto.randomUUID(),
      policyVersion: 1,
      required: true,
      tools: [
        {
          name: "read_issue",
          description: "Read an issue",
          inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          digest: "b".repeat(64),
          readOnlyHint: true,
        },
      ],
    };
    let requests = 0;
    let sourceReads = 0;
    let usageBegins = 0;
    let usageSettles = 0;
    const observations: unknown[] = [];
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = await request.json();
        const offered = body.tools ?? [];
        const discovery = offered.find(
          (tool: { function: { name: string } }) => tool.function.name === "find_application_code",
        );
        if (discovery) {
          expect(discovery.function.description).toContain("filename filter, not semantic");
          expect(discovery.function.parameters.properties.query.description).toContain(
            "Literal file path or filename fragment only",
          );
        }
        const names = offered.map((tool: { function: { name: string } }) => tool.function.name);
        if (requests === 0) {
          expect(names).toEqual([source]);
          expect(body.tool_choice).toBe("required");
        } else if ((missing && requests >= 3) || (exhausted && requests >= 5)) {
          expect(names).toEqual([]);
          // The native provider adapter omits tool_choice when no tools remain.
          expect(body.tools).toBeUndefined();
        } else if (requests === 1 || noFix) {
          expect(names).toContain("find_application_code");
          expect(names).not.toContain("read_application_code");
        } else {
          expect(names).toContain("read_application_code");
        }
        requests++;
        expect(JSON.stringify(body.messages)).not.toContain("provider-reusable-token");
        const next =
          exhausted && requests <= 5
            ? { name: source, args: { id: "42" } }
            : grounded || missing
              ? [
                  { name: source, args: { id: "42" } },
                  { name: "find_application_code", args: { query: "invoice" } },
                  missing
                    ? { name: "find_application_code", args: { query: "" } }
                    : {
                        name: "read_application_code",
                        args: {
                          commitSha: commit,
                          path: "src/invoice.ts",
                          startLine: 1,
                          lineCount: 80,
                        },
                      },
                ][requests - 1]
              : undefined;
        return Response.json({
          id: `owned-diagnosis-${requests}`,
          object: "chat.completion",
          created: 1,
          model: "owned-monitoring",
          choices: [
            {
              index: 0,
              finish_reason: next ? "tool_calls" : "stop",
              message: next
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: `owned-call-${requests}`,
                        type: "function",
                        function: { name: next.name, arguments: JSON.stringify(next.args) },
                      },
                    ],
                  }
                : {
                    role: "assistant",
                    content: JSON.stringify({
                      diagnosis: {
                        outcome: noFix ? "insufficient-context" : "fix",
                        title: "Handle an absent invoice",
                        explanation:
                          "The monitored stack and inspected code dereference an absent invoice.",
                        requirements: noFix
                          ? null
                          : {
                              summary:
                                "Return the existing not-found result for an absent invoice.",
                              acceptanceCriteria: [
                                "Absent invoices return not found without throwing.",
                                "Existing invoices keep their current result.",
                              ],
                              nonGoals: [],
                            },
                        code: noFix ? [] : [{ commitSha: commit, path: "src/invoice.ts" }],
                      },
                    }),
                  },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        });
      },
    });
    try {
      const result = diagnoseMonitoringIncident({
        title: "Invoice error",
        reference: "https://source.example/issues/42",
        context: "invoice is null",
        projectId: crypto.randomUUID(),
        userId: crypto.randomUUID(),
        modelId: "owned-monitoring",
        assignment,
        connection: {
          baseURL: `http://127.0.0.1:${provider.port}/v1`,
          apiKey: "owned-model-fixture",
        },
        mcp: {
          call: async (selected, _project, _user, name, args) => {
            expect(selected).toEqual(assignment);
            expect(name).toBe("read_issue");
            expect(args).toEqual({ id: "42" });
            sourceReads++;
            return {
              content: "Owned issue 42: invoice is null at src/invoice.ts:1",
              isError: false,
            };
          },
        },
        code: {
          codePaths: async () => ({
            commitSha: commit,
            paths: missing ? [] : ["src/invoice.ts", "scripts/deploy.ts"],
            truncated: false,
          }),
          code: async (_project, value) => ({
            ...(value as { commitSha: string; path: string; startLine: number; lineCount: number }),
            body: "1: return invoice.id;",
            truncated: false,
            url: `https://forge.example/src/${commit}/src/invoice.ts`,
          }),
        },
        signal: AbortSignal.timeout(5_000),
        authorize: async () => {},
        usage: {
          begin: async () => {
            usageBegins++;
          },
          record: async () => {},
          settle: async () => {
            usageSettles++;
          },
        },
        observe: async (value) => {
          observations.push(value);
        },
      });
      if (grounded) {
        expect((await result).requirements?.nonGoals).toContain(
          "Do not weaken, skip or remove checks or regression coverage.",
        );
        expect(requests).toBe(4);
        expect(sourceReads).toBe(1);
        expect(observations).toHaveLength(2);
      } else if (noFix) {
        expect((await result).outcome).toBe("insufficient-context");
        expect(requests).toBe(exhausted ? 6 : 4);
        expect(sourceReads).toBe(exhausted ? 5 : 1);
        expect(observations).toHaveLength(exhausted ? 5 : 1);
      } else {
        await expect(result).rejects.toThrow("did not establish");
        expect(requests).toBe(1);
        expect(sourceReads).toBe(0);
      }
      expect(usageBegins).toBe(1);
      expect(usageSettles).toBe(1);
    } finally {
      await provider.stop(true);
    }
  });
}
