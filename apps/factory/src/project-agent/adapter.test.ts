import { expect, test } from "bun:test";
import { requirementsInterviewSkill } from "../skills/reviewed";
import { generateProjectResponse } from "./adapter";
import type { ConversationEntry } from "./conversation-store";

test("native Project Agent preserves structured context and sends current input once", async () => {
  let captured = "";
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: unknown };
      captured = JSON.stringify(body.messages);
      return Response.json({
        id: "chat-context",
        object: "chat.completion",
        created: 1,
        model: "owned-context",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                output: { kind: "answer", message: "Local fixture.", citations: [] },
              }),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      });
    },
  });
  const entry = (ordinal: number, value: Partial<ConversationEntry>): ConversationEntry => ({
    id: crypto.randomUUID(),
    ordinal,
    actor: "project-agent",
    kind: "agent-message",
    mode: "plan",
    body: "",
    payload: {},
    citations: [],
    inReplyToEntryId: null,
    requirementRevisionId: null,
    createdAt: "2026-10-13T00:00:00Z",
    ...value,
  });
  const question = entry(1, {
    kind: "question",
    body: "Choose A or B",
    payload: {
      question: {
        type: "single-select",
        prompt: "Choose A or B",
        allowCustom: true,
        options: [
          { id: "a", label: "A", description: "OPTION_SEMANTICS_REQUIRED" },
          { id: "b", label: "B", description: "Other" },
        ],
      },
    },
  });
  const history = [
    question,
    entry(2, {
      kind: "answer",
      actor: "user",
      body: "A",
      inReplyToEntryId: question.id,
      payload: { answer: { selectedOptionIds: ["a"], customText: "" } },
    }),
    ...Array.from({ length: 26 }, (_, index) => entry(index + 3, { body: "Unrelated chatter" })),
    entry(29, {
      kind: "requirement",
      body: "Proposal ready",
      payload: {
        requirement: {
          summary: "PROPOSAL_SCOPE_REQUIRED",
          acceptanceCriteria: ["Read-only name"],
          nonGoals: [],
        },
      },
    }),
    entry(30, { kind: "user-message", actor: "user", body: "CURRENT_UNIQUE_INPUT" }),
  ];
  try {
    await generateProjectResponse({
      mode: "plan",
      modelId: "owned-context",
      connection: {
        baseURL: `http://127.0.0.1:${model.port}/v1`,
        apiKey: "owned-test-token",
      },
      prompt: "CURRENT_UNIQUE_INPUT",
      history,
      signal: AbortSignal.timeout(4000),
      research: {
        search: async () => [],
        read: async () => {
          throw new Error("Not needed");
        },
      },
    });
    expect(captured).toContain("OPTION_SEMANTICS_REQUIRED");
    expect(captured).toContain(question.id);
    expect(captured).toContain("PROPOSAL_SCOPE_REQUIRED");
    expect(captured.split("CURRENT_UNIQUE_INPUT")).toHaveLength(2);
  } finally {
    await model.stop(true);
  }
});

test.each([
  { provider: "openai" as const, modelId: "gpt-6-luna" },
  { provider: "openai" as const, modelId: "owned-chat-model" },
  { provider: "anthropic" as const, modelId: "owned-messages-model" },
  { provider: "deepseek" as const, modelId: "owned-deepseek-model" },
])(
  "native $provider/$modelId Interview uses Ticket provenance and already-loaded guidance",
  async ({ provider, modelId }) => {
    const sourceID = crypto.randomUUID();
    const skillID = crypto.randomUUID();
    const requiredID = crypto.randomUUID();
    const optionalID = crypto.randomUUID();
    const manualID = crypto.randomUUID();
    let requests = 0;
    let providerSchema = "";
    const model = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests++;
        const body = (await request.json()) as {
          text?: { format: { schema: unknown } };
          response_format?: { json_schema?: { schema: unknown } };
          messages?: unknown;
          input?: unknown;
          system?: unknown;
        };
        providerSchema = JSON.stringify(
          body.text?.format.schema ?? body.response_format?.json_schema?.schema ?? {},
        );
        const input = JSON.stringify([body.messages, body.input, body.system]);
        expect(input).toContain("REQUIRED_GUIDANCE_ALREADY_LOADED");
        expect(input).not.toContain("OPTIONAL_GUIDANCE_NOT_PRELOADED");
        expect(input).not.toContain("MANUAL_GUIDANCE_NOT_AUTOLOADED");
        expect(input).toContain(requirementsInterviewSkill.instructions.replaceAll("\n", "\\n"));
        expect(input).toContain(
          requirementsInterviewSkill.references[0]?.body.replaceAll("\n", "\\n") ??
            "missing reference",
        );
        const output = JSON.stringify({
          output: {
            kind: "round",
            message: "One decision remains.",
            questions: [
              {
                type: "free-text",
                prompt: "Where should the account appear?",
                placeholder: "Location",
              },
            ],
            citations: [
              { source: "ticket", id: sourceID, label: "Account summary", reference: null },
            ],
          },
        });
        if (provider === "anthropic")
          return Response.json({
            id: "msg-owned",
            type: "message",
            role: "assistant",
            model: modelId,
            content: [{ type: "text", text: output }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 10 },
          });
        if (modelId !== "gpt-6-luna")
          return Response.json({
            id: "chat-owned",
            object: "chat.completion",
            created: 1,
            model: modelId,
            choices: [
              { index: 0, message: { role: "assistant", content: output }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          });
        return Response.json({
          id: "resp-citation-contract",
          created_at: 1,
          model: "gpt-6-luna",
          status: "completed",
          output: [
            {
              type: "message",
              id: "msg-citation-contract",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  annotations: [],
                  text: output,
                },
              ],
            },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 10,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        });
      },
    });
    try {
      const output = await generateProjectResponse({
        mode: "plan",
        requirementsInterview: true,
        modelId,
        connection: {
          provider,
          baseURL: `http://127.0.0.1:${model.port}/v1`,
          apiKey: "owned-test-token",
        },
        skills: [
          {
            id: skillID,
            revision: 1,
            digest: "a".repeat(64),
            published: true,
            content: requirementsInterviewSkill,
          },
          ...[
            {
              id: requiredID,
              key: "mandatory-rule",
              instructions: "REQUIRED_GUIDANCE_ALREADY_LOADED",
            },
            {
              id: optionalID,
              key: "optional-rule",
              instructions: "OPTIONAL_GUIDANCE_NOT_PRELOADED",
            },
            {
              id: manualID,
              key: "manual-rule",
              instructions: "MANUAL_GUIDANCE_NOT_AUTOLOADED",
              manualOnly: true,
            },
          ].map(({ id, ...content }) => ({
            id,
            revision: 1,
            digest: "b".repeat(64),
            published: true,
            content: { ...requirementsInterviewSkill, references: [], ...content },
          })),
        ],
        requiredSkillRevisionIds: [requiredID, manualID],
        skillsLoaded: async (ids) => {
          expect(ids).toEqual([skillID, requiredID]);
          expect(requests).toBe(0);
        },
        prompt: "Clarify the selected Ticket using its frozen context.",
        history: [],
        signal: AbortSignal.timeout(4000),
        research: {
          search: async () => [],
          read: async () => {
            throw new Error("Not needed");
          },
        },
      });
      expect(output.kind).toBe("round");
      expect(output.citations).toEqual([
        { source: "ticket", id: sourceID, label: "Account summary" },
      ]);
      expect(requests).toBe(1);
      // Non-code variants must not ask a model to invent Git provenance.
      const citationSchemas: Array<Record<string, unknown>> = [];
      function inspect(value: unknown) {
        if (!value || typeof value !== "object") return;
        const object = value as Record<string, unknown>;
        if (object["properties"] && typeof object["properties"] === "object") {
          const properties = object["properties"] as Record<
            string,
            { enum?: string[]; const?: string }
          >;
          if (
            properties["source"]?.enum?.includes("ticket") ||
            properties["source"]?.const === "ticket"
          )
            citationSchemas.push(properties);
        }
        for (const child of Object.values(object)) {
          if (Array.isArray(child)) child.forEach(inspect);
          else inspect(child);
        }
      }
      inspect(JSON.parse(providerSchema));
      if (modelId === "gpt-6-luna") expect(citationSchemas.length).toBeGreaterThan(0);
      for (const properties of citationSchemas) {
        expect(properties).not.toHaveProperty("commitSha");
        expect(properties).not.toHaveProperty("path");
      }
    } finally {
      await model.stop(true);
    }
  },
);

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
            name: "searchProject",
            arguments: JSON.stringify({ query: "draft", source: "knowledge" }),
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
      research: {
        search: async (_query, source) => {
          expect(source).toBe("knowledge");
          searches++;
          return [
            { source: "knowledge", id: sourceID, label: "Drafts", excerpt: "Drafts stay private." },
          ];
        },
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
        "searchProject",
        "readProject",
      ]);
    }
  } finally {
    await model.stop(true);
  }
});

test("native Mastra batches memoized research and rechecks authority without a separate lookup ceiling", async () => {
  let requests = 0,
    loads = 0,
    authorities = 0;
  const sourceID = crypto.randomUUID();
  const queries: string[] = [];
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
          arguments: JSON.stringify({
            query:
              index < 5 ? ["same", " same ", "ｓａｍｅ", "İ", "i\u0307"][index] : `query-${index}`,
          }),
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
      research: {
        authorize: async () => {
          authorities++;
        },
        search: async (query) => {
          loads++;
          queries.push(query);
          return [{ source: "ticket", id: sourceID, label: "Owned", excerpt: "Known" }];
        },
        read: async () => {
          throw new Error("Not needed");
        },
      },
    });
    expect(output.kind).toBe("answer");
    expect(loads).toBe(14);
    expect(queries.filter((query) => query.normalize("NFKC").trim() === "same")).toHaveLength(1);
    // PostgreSQL folds these differently even though JS lowercases them identically.
    expect(queries).toContain("İ");
    expect(queries).toContain("i\u0307");
    expect(authorities).toBe(18); // Every tool call plus each provider step.
    expect(requests).toBe(2);
  } finally {
    await model.stop(true);
  }
});
