import { expect, test } from "bun:test";
import { planningDesign } from "../../../../test/fixtures/technical-planning";
import { generateProjectResponse } from "./adapter";
import { ProjectAgentOutputError } from "./structured-output";

test.each([{ providerTruncates: false }, { providerTruncates: true }])(
  "Technical Planning preserves native output room without replay, providerTruncates=$providerTruncates",
  async ({ providerTruncates }) => {
    const requests: Record<string, unknown>[] = [];
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(new URL(request.url).pathname).toBe("/v1/responses");
        const body = (await request.json()) as Record<string, unknown>;
        requests.push(body);
        const imposedLimit = body["max_output_tokens"];
        const incomplete =
          providerTruncates || (typeof imposedLimit === "number" && imposedLimit <= 6000);
        return Response.json({
          id: "resp-owned-technical-output",
          created_at: 1,
          model: "gpt-6.1-sol",
          status: incomplete ? "incomplete" : "completed",
          ...(incomplete ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
          output: [
            {
              type: "message",
              id: "msg-owned-technical-output",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  annotations: [],
                  text: incomplete
                    ? '{"output":{"kind":"technical-design","message":"Preparing'
                    : JSON.stringify({
                        output: {
                          kind: "technical-design",
                          message: "The complete design is ready for inspection.",
                          design: { ...planningDesign, diagrams: [] },
                          citations: [],
                        },
                      }),
                },
              ],
            },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: incomplete ? 6000 : 6500,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: incomplete ? 5900 : 6100 },
          },
        });
      },
    });
    try {
      const run = generateProjectResponse({
        mode: "plan",
        modelId: "gpt-6.1-sol",
        technicalPlanning: {
          requirementRevisionId: crypto.randomUUID(),
          documentId: null,
          previousDesignId: null,
          sourceCommit: "a".repeat(40),
        },
        connection: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "owned-output" },
        prompt: "Complete the confirmed technical design.",
        history: [],
        signal: AbortSignal.timeout(4000),
        research: {
          search: async () => [],
          read: async () => {
            throw new Error("No research needed in this transport fixture");
          },
        },
      });
      if (providerTruncates) {
        const failure = await run.catch((cause: unknown) => cause);
        expect(failure).toBeInstanceOf(ProjectAgentOutputError);
        if (failure instanceof ProjectAgentOutputError)
          expect(failure.diagnostic).toBe("STRUCTURED_OUTPUT_TRUNCATED");
      } else {
        expect(await run).toMatchObject({
          kind: "technical-design",
          design: { context: planningDesign.context },
        });
      }
      expect(requests).toHaveLength(1);
      expect(requests[0]).not.toHaveProperty("max_output_tokens");
      expect(requests[0]?.["store"]).toBe(false);
    } finally {
      await provider.stop(true);
    }
  },
);
