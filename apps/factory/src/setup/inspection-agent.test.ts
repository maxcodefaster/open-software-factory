import { expect, test } from "bun:test";
import { inspectConfiguration } from "./inspection-agent";

test("native setup inspection has a final-output step after sequential source reads", async () => {
  const paths = ["package.json", "README.md", "src/server.ts", "src/database.ts"];
  const loaded: string[] = [];
  let requests = 0;
  const proposal = {
    purpose: "A source-grounded application requiring configuration",
    services: [{ name: "Web", description: "Web application", port: 3000 }],
    uncertainty: [],
    questions: [
      { id: "database", question: "Which database environment values should be configured?" },
    ],
    files: [],
  };
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { stream?: boolean; messages: unknown[] };
      expect(JSON.stringify(body.messages)).toContain("cap_drop: [NET_RAW, SYS_PTRACE]");
      expect(JSON.stringify(body.messages)).toContain("--cap-drop=NET_RAW");
      expect(JSON.stringify(body.messages)).toContain("..:/workspace/project");
      expect(JSON.stringify(body.messages)).toContain("sleep");
      expect(JSON.stringify(body.messages)).toContain("postCreateCommand");
      expect(JSON.stringify(body.messages)).toContain("Factory starts App commands");
      const path = paths[requests++];
      const message = path
        ? {
            role: "assistant",
            tool_calls: [
              {
                id: `read-${requests}`,
                type: "function",
                function: { name: "read", arguments: JSON.stringify({ path }) },
              },
            ],
          }
        : { role: "assistant", content: JSON.stringify(proposal) };
      const common = { id: `inspection-${requests}`, created: 1, model: "owned-model" };
      const finish_reason = path ? "tool_calls" : "stop";
      if (!body.stream)
        return Response.json({
          ...common,
          object: "chat.completion",
          choices: [{ index: 0, message, finish_reason }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      const chunks = [
        {
          ...common,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: path
                ? {
                    ...message,
                    tool_calls: message.tool_calls?.map((call, index) => ({ ...call, index })),
                  }
                : message,
              finish_reason: null,
            },
          ],
        },
        {
          ...common,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      ];
      return new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    const result = await inspectConfiguration({
      modelID: "owned-model",
      connection: {
        baseURL: `http://127.0.0.1:${provider.port}/v1`,
        apiKey: "owned-inspection-test",
      },
      paths,
      existingConfiguration: [],
      signal: AbortSignal.timeout(5000),
      read: async (path) => {
        loaded.push(path);
        return `Actual source for ${path}`;
      },
    });
    expect(result).toEqual(proposal);
    expect(loaded).toEqual(paths);
    expect(requests).toBe(5);
  } finally {
    await provider.stop(true);
  }
});

test("native setup inspection reserves its last admitted step for questions instead of another read", async () => {
  const paths = Array.from({ length: 8 }, (_, index) => `service-${index}/package.json`);
  const loaded: string[] = [];
  const choices: unknown[] = [];
  const proposal = {
    purpose: "A multi-service application needing human configuration choices",
    services: [],
    uncertainty: ["The bounded inspection has not read every service."],
    questions: [{ id: "services", question: "Which application services should Factory start?" }],
    files: [],
  };
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { stream?: boolean; tool_choice?: unknown };
      choices.push(body.tool_choice);
      const path = body.tool_choice === "none" ? undefined : paths[choices.length - 1];
      const message = path
        ? {
            role: "assistant",
            tool_calls: [
              {
                id: `bounded-read-${choices.length}`,
                type: "function",
                function: { name: "read", arguments: JSON.stringify({ path }) },
              },
            ],
          }
        : { role: "assistant", content: JSON.stringify(proposal) };
      const common = {
        id: `bounded-inspection-${choices.length}`,
        created: 1,
        model: "owned-model",
      };
      const finish_reason = path ? "tool_calls" : "stop";
      if (!body.stream)
        return Response.json({
          ...common,
          object: "chat.completion",
          choices: [{ index: 0, message, finish_reason }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      return new Response(
        [
          {
            ...common,
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: path
                  ? {
                      ...message,
                      tool_calls: message.tool_calls?.map((call, index) => ({ ...call, index })),
                    }
                  : message,
                finish_reason: null,
              },
            ],
          },
          {
            ...common,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ]
          .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
          .join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    const result = await inspectConfiguration({
      modelID: "owned-model",
      connection: {
        baseURL: `http://127.0.0.1:${provider.port}/v1`,
        apiKey: "owned-inspection-test",
      },
      paths,
      existingConfiguration: [],
      signal: AbortSignal.timeout(5000),
      read: async (path) => {
        loaded.push(path);
        return `Actual source for ${path}`;
      },
    });
    expect(result).toEqual(proposal);
    expect(choices).toHaveLength(6);
    expect(choices.at(-1)).toBe("none");
    expect(loaded).toEqual(paths.slice(0, 5));
  } finally {
    await provider.stop(true);
  }
});
