const port = Number(process.env["FACTORY_FAKE_MODEL_PORT"] ?? "43123");

let released = false;
let requests = 0;
let agentRequests = 0;
let abortedRequests = 0;
let tools: unknown[] = [];
const waiters = new Set<() => void>();

function release() {
  released = true;
  for (const waiter of waiters) waiter();
  waiters.clear();
}

function stream(chunks: unknown[]) {
  const body =
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, {
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function completion(delta: Record<string, unknown>, finishReason: string | null) {
  return {
    id: "chatcmpl-factory-test",
    object: "chat.completion.chunk",
    created: 1_789_423_600,
    model: "factory-coding-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function toolCall(id: string, name: string, input: Record<string, unknown>, responses = false) {
  if (responses)
    return fakeResponsesOutput({
      type: "function_call",
      id: `fc_${id}`,
      call_id: id,
      name,
      arguments: JSON.stringify(input),
    });
  return stream([
    completion(
      {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id,
            type: "function",
            function: { name, arguments: JSON.stringify(input) },
          },
        ],
      },
      null,
    ),
    completion({}, "tool_calls"),
  ]);
}

function text(value: string, responses = false) {
  if (responses)
    return fakeResponsesOutput({
      type: "message",
      id: "msg_factory_controlled",
      role: "assistant",
      content: [{ type: "output_text", text: value, annotations: [] }],
    });
  return stream([completion({ role: "assistant", content: value }, null), completion({}, "stop")]);
}

async function waitForRelease(request: Request) {
  if (released) return true;
  return new Promise<boolean>((resolve) => {
    const settle = (value: boolean) => {
      request.signal.removeEventListener("abort", abort);
      waiters.delete(allow);
      resolve(value);
    };
    const abort = () => {
      abortedRequests += 1;
      settle(false);
    };
    const allow = () => settle(true);
    request.signal.addEventListener("abort", abort, { once: true });
    waiters.add(allow);
  });
}

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/control/stats") {
      return Response.json({ released, requests, agentRequests, abortedRequests, tools });
    }
    if (url.pathname === "/control/release" && request.method === "POST") {
      release();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/control/reset" && request.method === "POST") {
      released = false;
      requests = 0;
      agentRequests = 0;
      abortedRequests = 0;
      tools = [];
      waiters.clear();
      return new Response(null, { status: 204 });
    }
    const responses = url.pathname === "/v1/responses";
    if ((!responses && url.pathname !== "/v1/chat/completions") || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }
    requests += 1;
    const body = (await request.json()) as {
      messages?: Array<{ role?: string; tool_call_id?: string; content?: string }>;
      input?: Array<{ type?: string }>;
      tools?: unknown[];
    };
    if (
      body.messages?.some((message) => message.content?.includes("FACTORY_KNOWLEDGE_GENERATION"))
    ) {
      return Response.json({
        id: "chatcmpl-factory-knowledge",
        object: "chat.completion",
        created: 1_789_423_600,
        model: "factory-coding-model",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                pages: [
                  {
                    slug: "overview",
                    title: "Runtime fixture overview",
                    body: "# Runtime fixture\n\nThe fixture proves the Factory runtime contract.\n\n## Development\n\nThe primary app runs with its support service.\n",
                    sources: ["README.md", "package.json"],
                  },
                ],
              }),
            },
          },
        ],
      });
    }
    if (!body.tools?.length) return text("Factory test session", responses);
    tools = body.tools;
    agentRequests += 1;
    if (!(await waitForRelease(request))) return new Response(null, { status: 499 });
    const completedTools = responses
      ? (body.input?.filter((item) => item.type === "function_call_output") ?? [])
      : (body.messages?.filter((message) => message.role === "tool") ?? []);
    if (completedTools.length === 0) {
      return toolCall(
        "call_factory_write",
        "write",
        {
          path: "src/version.txt",
          content: "agent\n",
        },
        responses,
      );
    }
    if (completedTools.length === 1) {
      return toolCall(
        "call_factory_check",
        "shell",
        {
          command: "node --check src/server.mjs",
        },
        responses,
      );
    }
    return text("Implementation complete. The local syntax check passed.", responses);
  },
});

console.log(`fake model ready on ${port}`);
import { fakeResponsesOutput } from "./fake-openai-responses";
