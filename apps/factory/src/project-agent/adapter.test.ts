import { expect, test } from "bun:test";
import { generateProjectResponse } from "./adapter";

test("Luna uses Responses with reasoning, retained search tools and no provider storage", async () => {
  const requests: Array<Record<string, unknown>> = [];
  let searches = 0;
  const sourceID = crypto.randomUUID();
  const model = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/v1/responses");
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      const call = requests.length === 1;
      const item = call
        ? {
            type: "function_call",
            id: "fc-owned",
            call_id: "call-owned",
            name: "knowledgeTool",
            arguments: JSON.stringify({ query: "draft" }),
          }
        : { type: "message", id: "msg-owned" };
      const output = {
        output: {
          kind: "answer",
          message: "Drafts stay private.",
          citations: [{ source: "knowledge", id: sourceID, label: "Drafts" }],
        },
      };
      if (!body["stream"])
        return Response.json({
          id: "resp-owned",
          created_at: 1,
          model: "gpt-6-luna",
          status: "completed",
          output: [
            call
              ? item
              : {
                  ...item,
                  role: "assistant",
                  content: [{ type: "output_text", text: JSON.stringify(output), annotations: [] }],
                },
          ],
          usage: {
            input_tokens: 20,
            output_tokens: 10,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 2 },
          },
        });
      const events: unknown[] = [
        {
          type: "response.created",
          response: { id: "resp-owned", created_at: 1, model: "gpt-6-luna" },
        },
        { type: "response.output_item.added", output_index: 0, item },
        ...(call
          ? []
          : [
              {
                type: "response.output_text.delta",
                item_id: "msg-owned",
                output_index: 0,
                delta: JSON.stringify(output),
              },
            ]),
        {
          type: "response.output_item.done",
          output_index: 0,
          item: call
            ? item
            : {
                ...item,
                role: "assistant",
                content: [{ type: "output_text", text: JSON.stringify(output), annotations: [] }],
              },
        },
        {
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 20,
              output_tokens: 10,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 2 },
            },
          },
        },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  try {
    const output = await generateProjectResponse({
      mode: "investigate",
      modelId: "gpt-6-luna",
      connection: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "owned-test-token" },
      prompt: "How do our drafts work?",
      history: [],
      signal: AbortSignal.timeout(4000),
      searchKnowledge: async () => {
        searches++;
        return [{ id: sourceID, label: "Drafts", excerpt: "Drafts stay private." }];
      },
      searchTickets: async () => [],
      research: {
        search: async () => [],
        read: async () => {
          throw new Error("No source in this fixture");
        },
      },
    });
    expect(output.kind).toBe("answer");
    expect(searches).toBe(1);
    expect(requests).toHaveLength(2);
    for (const body of requests) {
      expect(body["reasoning"]).toMatchObject({ effort: "low" });
      expect(body["store"]).toBe(false);
      expect((body["tools"] as Array<{ name: string }>).map((tool) => tool.name)).toEqual([
        "knowledgeTool",
        "ticketTool",
        "searchProject",
        "readProject",
      ]);
    }
  } finally {
    await model.stop(true);
  }
});

test("native Mastra batches memoized research, rechecks authority and bounds distinct lookups", async () => {
  let requests = 0,
    loads = 0,
    authorities = 0;
  const sourceID = crypto.randomUUID();
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { stream?: boolean };
      requests++;
      const calls = Array.from({ length: 16 }, (_, index) => ({
        id: `call-${index}`,
        type: "function",
        function: {
          name: "searchProject",
          arguments: JSON.stringify({ query: index < 3 ? "same" : `query-${index}` }),
        },
      }));
      const message =
        requests === 1
          ? { role: "assistant", tool_calls: calls }
          : {
              role: "assistant",
              content: JSON.stringify({
                output: {
                  kind: "answer",
                  message: "Research complete; unresolved facts remain unknown",
                  citations: [],
                },
              }),
            };
      if (!body.stream)
        return Response.json({
          id: "owned-bound",
          object: "chat.completion",
          created: 1,
          model: "owned-model",
          choices: [{ index: 0, message, finish_reason: requests === 1 ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      const common = {
        id: "owned-bound",
        object: "chat.completion.chunk",
        created: 1,
        model: "owned-model",
      };
      const chunks = [
        {
          ...common,
          choices: [
            {
              index: 0,
              delta:
                requests === 1
                  ? {
                      role: "assistant",
                      tool_calls: calls.map((call, index) => ({ ...call, index })),
                    }
                  : message,
              finish_reason: null,
            },
          ],
        },
        {
          ...common,
          choices: [{ index: 0, delta: {}, finish_reason: requests === 1 ? "tool_calls" : "stop" }],
        },
      ];
      return new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    const output = await generateProjectResponse({
      mode: "investigate",
      modelId: "owned-model",
      connection: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "owned-not-a-secret" },
      prompt: "Research",
      history: [],
      signal: AbortSignal.timeout(5000),
      searchKnowledge: async () => [],
      searchTickets: async () => [],
      research: {
        authorize: async () => {
          authorities++;
        },
        search: async () => {
          loads++;
          return [{ source: "ticket", id: sourceID, label: "Owned", excerpt: "Known" }];
        },
        read: async () => {
          throw new Error("Not needed");
        },
      },
    });
    expect(output.kind).toBe("answer");
    expect(loads).toBe(12);
    expect(authorities).toBe(16);
    expect(requests).toBe(2);
  } finally {
    await model.stop(true);
  }
});
