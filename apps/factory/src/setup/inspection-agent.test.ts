import { expect, test } from "bun:test";
import { knownModelRejection } from "../models/execution-policy";
import { inspectConfiguration } from "./inspection-agent";

test("retained proposal text remains inside the existing model input bound", async () => {
  let requests = 0;
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      return Response.json(
        { error: "Oversized input must not reach the provider" },
        { status: 500 },
      );
    },
  });
  try {
    const failure = await inspectConfiguration({
      modelID: "owned-model",
      connection: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "owned-input-bound" },
      signal: AbortSignal.timeout(5000),
      paths: ["package.json"],
      existingConfiguration: [],
      previousProposal: {
        purpose: "Oversized retained configuration",
        services: [],
        uncertainty: [],
        questions: [],
        files: [
          ".devcontainer/devcontainer.json",
          ".devcontainer/Dockerfile",
          ".devcontainer/compose.yaml",
          ".devcontainer/compose.yml",
          ".factory/system.json",
          ".forgejo/workflows/factory-verification.yml",
        ].map((path) => ({ path, content: "x".repeat(64000) })),
      },
      read: async () => '{"name":"owned"}',
    }).catch((cause: unknown) => cause);
    expect(knownModelRejection(failure)).toBe(true);
    expect(requests).toBe(0);
  } finally {
    await provider.stop(true);
  }
});

test("caller Stop still fences a longer setup invocation without starting inference", async () => {
  const abort = new AbortController();
  abort.abort(new DOMException("Owned setup Stop", "AbortError"));
  let reads = 0;
  await expect(
    inspectConfiguration({
      modelID: "owned-model",
      connection: { baseURL: "http://127.0.0.1:9/v1", apiKey: "owned-stop" },
      signal: abort.signal,
      paths: ["README.md"],
      existingConfiguration: [],
      read: async () => {
        reads++;
        return "Owned source";
      },
    }),
  ).rejects.toThrow("Owned setup Stop");
  expect(reads).toBe(0);
});

test("caller Stop interrupts an admitted setup request without another provider request", async () => {
  const abort = new AbortController();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let requests = 0;
  let settled = "";
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      requests++;
      entered.resolve();
      await release.promise;
      return Response.json({ error: "Owned request was interrupted" }, { status: 500 });
    },
  });
  try {
    const generation = inspectConfiguration({
      modelID: "owned-model",
      connection: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "owned-stop" },
      signal: abort.signal,
      paths: ["README.md"],
      existingConfiguration: [],
      usageSink: {
        begin: async () => {},
        record: async () => {},
        settle: async (outcome) => {
          settled = outcome;
        },
      },
      read: async () => "Owned source",
    });
    await entered.promise;
    abort.abort(new DOMException("Owned setup Stop", "AbortError"));
    await expect(generation).rejects.toThrow();
    expect(requests).toBe(1);
    expect(settled).toBe("interrupted");
  } finally {
    release.resolve();
    await provider.stop(true);
  }
});

test("native setup inspection has a final-output step after sequential source reads", async () => {
  const paths = ["package.json", "README.md", "src/server.ts", "src/database.ts"];
  const loaded: string[] = [];
  let requests = 0;
  const previousProposal = {
    purpose: "Retained configuration under explicit review",
    services: [],
    uncertainty: [],
    questions: [],
    files: [
      {
        path: ".devcontainer/Dockerfile" as const,
        content: "FROM node:24\n# preserve-this-retained-installer\n",
      },
    ],
  };
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
      const body = (await request.json()) as {
        stream?: boolean;
        messages: { role: string; content: string | { text: string }[] }[];
      };
      expect(JSON.stringify(body.messages)).toContain("cap_drop: [NET_RAW, SYS_PTRACE]");
      expect(JSON.stringify(body.messages)).toContain("--cap-drop=NET_RAW");
      expect(JSON.stringify(body.messages)).toContain("..:/workspace/project");
      expect(JSON.stringify(body.messages)).toContain("sleep");
      expect(JSON.stringify(body.messages)).toContain("postCreateCommand");
      expect(JSON.stringify(body.messages)).toContain("Factory starts App commands");
      expect(JSON.stringify(body.messages)).toContain(
        "Setup readiness means a reproducible launch and Verification, not application/browser acceptance",
      );
      expect(JSON.stringify(body.messages)).toContain("must never be claimed resolved");
      const userText = body.messages
        .filter((message) => message.role === "user")
        .flatMap((message) =>
          typeof message.content === "string"
            ? [message.content]
            : message.content.map((part) => part.text),
        )
        .join("\n");
      expect(userText).toContain(
        '"missingConfiguration":[".devcontainer/devcontainer.json",".factory/system.json",".forgejo/workflows/factory-verification.yml"]',
      );
      expect(userText).toContain('"previousProposal":');
      expect(userText).toContain("preserve-this-retained-installer");
      expect(JSON.stringify(body.messages)).toContain(
        "write standard installation commands for already-established system tools and exact approved versions",
      );
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
      previousProposal,
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

test.each([
  { name: "known source", path: "tools/forms-dev.mjs", allowed: true },
  { name: "excluded environment file", path: ".env.local", allowed: false },
])("the bounded setup index does not replace source authorization: $name", async (entry) => {
  const loaded: string[] = [];
  let requests = 0;
  const proposal = {
    purpose: "An application with a referenced setup script",
    services: [],
    uncertainty: [],
    questions: [{ id: "services", question: "Which application services should be exposed?" }],
    files: [],
  };
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { stream?: boolean; messages: unknown[] };
      requests++;
      if (requests === 1) expect(JSON.stringify(body.messages)).not.toContain(entry.path);
      const reading = requests === 1;
      const message = reading
        ? {
            role: "assistant",
            tool_calls: [
              {
                id: "referenced-source",
                type: "function",
                function: { name: "read", arguments: JSON.stringify({ path: entry.path }) },
              },
            ],
          }
        : { role: "assistant", content: JSON.stringify(proposal) };
      const common = { id: `source-index-${requests}`, created: 1, model: "owned-model" };
      const finish_reason = reading ? "tool_calls" : "stop";
      if (!body.stream)
        return Response.json({
          ...common,
          object: "chat.completion",
          choices: [{ index: 0, message, finish_reason }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      return new Response(
        `${[
          {
            ...common,
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: reading
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
          .join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    const output = inspectConfiguration({
      modelID: "owned-model",
      connection: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "owned-index-test" },
      signal: AbortSignal.timeout(5000),
      paths: ["README.md"],
      availablePaths: ["README.md", "tools/forms-dev.mjs"],
      existingConfiguration: [],
      read: async (path) => {
        loaded.push(path);
        return "Actual existing setup script";
      },
    });
    if (entry.allowed) {
      expect(await output).toEqual(proposal);
      expect(loaded).toEqual([entry.path]);
      expect(requests).toBe(2);
    } else {
      await expect(output).rejects.toThrow();
      expect(loaded).toEqual([]);
    }
  } finally {
    await provider.stop(true);
  }
});

test.each([
  { name: "parallel small files", batches: [12], source: "Small source", unicode: 0 },
  { name: "sequential small batches", batches: [4, 4, 4], source: "Small source", unicode: 0 },
  { name: "UTF-8 byte limit", batches: [7], source: "界".repeat(9000), unicode: 28000 },
  { name: "file count remains bounded", batches: [12, 1], source: "Small source", blocked: 12 },
  {
    name: "total bytes remain bounded",
    batches: [9, 1],
    source: "§".repeat(20000),
    blocked: 9,
    unicode: 50000,
    marker: "§",
  },
])("source byte accounting: $name", async (entry) => {
  const paths = Array.from({ length: 13 }, (_, index) => `source-${index}.ts`);
  const loaded: string[] = [];
  let requests = 0;
  let cursor = 0;
  let observedUnicode = 0;
  let sourceBoundReached = false;
  const proposal = {
    purpose: "An application inspected within the original source limits",
    services: [],
    uncertainty: [],
    questions: [{ id: "services", question: "Which services should be exposed?" }],
    files: [],
  };
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { stream?: boolean; messages: unknown[] };
      const observed = JSON.stringify(body.messages);
      observedUnicode = observed.split(entry.marker ?? "界").length - 1;
      sourceBoundReached ||= observed.includes("Inspection source bound reached");
      const count = entry.batches[requests++];
      const selected = paths.slice(cursor, cursor + (count ?? 0));
      cursor += count ?? 0;
      const reading = selected.length > 0;
      const message = reading
        ? {
            role: "assistant",
            tool_calls: selected.map((path) => ({
              id: `source-bytes-${path}`,
              type: "function",
              function: { name: "read", arguments: JSON.stringify({ path }) },
            })),
          }
        : { role: "assistant", content: JSON.stringify(proposal) };
      const common = { id: `source-bytes-${requests}`, created: 1, model: "owned-model" };
      const finish_reason = reading ? "tool_calls" : "stop";
      if (!body.stream)
        return Response.json({
          ...common,
          object: "chat.completion",
          choices: [{ index: 0, message, finish_reason }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      return new Response(
        `${[
          {
            ...common,
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: reading
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
          .join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    const output = inspectConfiguration({
      modelID: "owned-model",
      connection: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "owned-byte-bound" },
      signal: AbortSignal.timeout(5000),
      paths,
      existingConfiguration: [],
      read: async (path) => {
        loaded.push(path);
        return entry.source;
      },
    });
    expect(await output).toEqual(proposal);
    if (entry.blocked !== undefined) {
      expect(loaded).toHaveLength(entry.blocked);
      expect(sourceBoundReached).toBe(true);
      if (entry.unicode !== undefined) expect(observedUnicode).toBe(entry.unicode);
    } else {
      expect(loaded).toHaveLength(entry.batches.reduce((sum, count) => sum + count, 0));
      expect(observedUnicode).toBe(entry.unicode);
      expect(requests).toBe(entry.batches.length + 1);
    }
  } finally {
    await provider.stop(true);
  }
});
