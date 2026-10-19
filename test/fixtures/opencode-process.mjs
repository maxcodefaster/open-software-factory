import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";

// Isolated upstream process fixture. Only explicit live tests supply a native provider.
const modelID = process.env.FACTORY_PROCESS_MODEL_ID ?? "owned-process-model";
const nativeProvider = process.env.FACTORY_PROCESS_NATIVE_PROVIDER
  ? JSON.parse(process.env.FACTORY_PROCESS_NATIVE_PROVIDER)
  : undefined;
if (process.env.FACTORY_PROCESS_SKILL_MANIFEST) {
  const installed = spawnSync(
    "/opt/factory/opencode/musl/bun",
    ["/opt/factory/opencode/server/install-skills.mjs"],
    { input: await readFile(process.env.FACTORY_PROCESS_SKILL_MANIFEST, "utf8"), encoding: "utf8" },
  );
  if (installed.status !== 0)
    throw new Error(`Owned skill installation failed: ${installed.stderr}`);
}
await mkdir("/root/.config/opencode", { recursive: true });
await mkdir("/workspace/project/.git", { recursive: true });
await writeFile(
  "/root/.config/opencode/opencode.json",
  JSON.stringify({
    model: `factory/${modelID}`,
    skills: ["/opt/factory/admitted-skills"],
    providers: {
      factory: {
        package: nativeProvider?.package ?? "@opencode/ai/providers/openai/chat",
        canonical: "openai",
        env: ["FACTORY_OPENCODE_TOKEN"],
        websocket: false,
        name: "Factory process fixture",
        settings: {
          baseURL: process.env.FACTORY_PROCESS_PROVIDER_URL ?? "http://127.0.0.1:4097/v1",
          apiKey: "owned-not-a-secret",
          ...(process.env.FACTORY_PROCESS_PROVIDER_URL && modelID === "gpt-5.6-terra"
            ? { reasoningEffort: "none" }
            : {}),
          ...nativeProvider?.settings,
        },
        models: {
          [modelID]: {
            name: "Controlled response",
            capabilities: {
              tools: true,
              input: process.env.FACTORY_PROCESS_BROWSER_TURN ? ["text", "image"] : ["text"],
              output: ["text"],
            },
            limit: { context: 200000, output: 32000 },
          },
        },
      },
    },
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
  }),
);

const factoryConfig = await readFile("/root/.config/opencode/opencode.json", "utf8");
let processHandle;
let generation = 0;
let providerRequests = 0;
let browserTools = [];
let imageRequests = 0;
let hold = true;
let reportUsage = false;
let failure;
let spawnChild = false;
let runTool = false;
const held = new Map();
function complete(response, coding = true) {
  if (response.destroyed) return;
  response.writeHead(200, { "content-type": "text/event-stream" });
  const browserTurn = process.env.FACTORY_PROCESS_BROWSER_TURN;
  const step = providerRequests;
  const call =
    runTool && coding
      ? {
          name: "shell",
          arguments: JSON.stringify({ command: "true", description: "Owned budget boundary" }),
        }
      : spawnChild
        ? {
            name: "subagent",
            arguments: JSON.stringify({
              agent: "general",
              description: "Owned child usage",
              prompt: "Return one short answer. No tools.",
            }),
          }
        : browserTurn && step <= 2
          ? {
              name: step === 1 ? "shell" : "read",
              arguments: JSON.stringify(
                step === 1
                  ? {
                      command: `printf '%s' '{"name":"browser_screenshot","arguments":{}}' | "$FACTORY_BUILD_BROWSER_COMMAND" browser-client ${browserTurn}`,
                      description: "Capture the fixed declared App screenshot",
                      timeout: 270000,
                    }
                  : { path: `/tmp/factory-build-browser-${browserTurn}/screenshot.jpg` },
              ),
            }
          : undefined;
  if (spawnChild) spawnChild = false;
  if (coding) runTool = false;
  const deltas = call
    ? [
        {
          tool_calls: [
            { index: 0, id: `call_owned_browser_${step}`, type: "function", function: call },
          ],
        },
      ]
    : [{ content: "Owned process response" }, {}];
  for (const delta of deltas) {
    response.write(
      `data: ${JSON.stringify({
        id: "chatcmpl_owned",
        object: "chat.completion.chunk",
        created: 1,
        model: modelID,
        choices: [
          { index: 0, delta, finish_reason: call ? "tool_calls" : delta.content ? null : "stop" },
        ],
      })}\n\n`,
    );
  }
  if (reportUsage)
    response.write(
      `data: ${JSON.stringify({ id: "chatcmpl_owned", object: "chat.completion.chunk", created: 1, model: modelID, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 }, completion_tokens_details: { reasoning_tokens: 5 } } })}\n\n`,
    );
  response.end("data: [DONE]\n\n");
}

function start() {
  if (processHandle && processHandle.exitCode === null && processHandle.signalCode === null)
    throw new Error("Owned OpenCode process is already running");
  generation += 1;
  processHandle = spawn(
    process.env.FACTORY_PROCESS_PACKAGED_SERVER
      ? "/opt/factory/opencode/musl/bun"
      : "/opt/factory/opencode",
    process.env.FACTORY_PROCESS_PACKAGED_SERVER
      ? ["/opt/factory/opencode/server/server.mjs"]
      : process.env.FACTORY_PROCESS_NATIVE_SERVER
        ? ["/owned-server/server.mjs"]
        : ["serve", "--hostname", "0.0.0.0", "--port", "4096"],
    {
      cwd: "/workspace/project",
      env: {
        ...process.env,
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DB: "/workspace/project/.git/factory-opencode.db",
        OPENCODE_PASSWORD: "owned-opencode-server-password",
        FACTORY_OPENCODE_TOKEN: nativeProvider?.settings?.apiKey ?? "owned-not-a-secret",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        FACTORY_OPENCODE_HOST: "0.0.0.0",
        FACTORY_OPENCODE_CONFIG: factoryConfig,
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  processHandle.on("error", (error) => console.error(error.message));
}

const control = createServer(async (request, response) => {
  try {
    if (request.url === "/control/usage" && request.method === "POST") reportUsage = true;
    if (request.url === "/control/deny" && request.method === "POST")
      failure =
        "Factory Coding allowance paused subsequent inference. Existing code is retained; resume explicitly after reset or an allowance increase.";
    if (request.url === "/control/fail" && request.method === "POST")
      failure = "Unrelated provider access failure";
    if (request.url === "/control/child" && request.method === "POST") spawnChild = true;
    if (request.url === "/control/tool" && request.method === "POST") runTool = true;
    if (request.url === "/v1/chat/completions" && request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      if (
        input.messages?.some(
          (message) =>
            Array.isArray(message.content) &&
            message.content.some((part) => part.type === "image_url"),
        )
      )
        imageRequests += 1;
      browserTools = (input.tools ?? [])
        .map((tool) => tool.function?.name)
        .filter((name) => typeof name === "string" && name.includes("browser"));
      providerRequests += 1;
      const coding = Boolean(input.tools?.length);
      if (failure) {
        response.writeHead(403, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: failure, type: "access_denied" } }));
        return;
      }
      if (hold) {
        held.set(response, coding);
        response.on("close", () => held.delete(response));
      } else complete(response, coding);
      return;
    }
    if (request.url === "/control/kill" && request.method === "POST") {
      const child = processHandle;
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise((resolve) => {
          child.once("exit", resolve);
          child.kill("SIGKILL");
        });
      }
    } else if (request.url === "/control/restart" && request.method === "POST") start();
    else if (request.url === "/control/release" && request.method === "POST") {
      hold = false;
      for (const [item, coding] of held) complete(item, coding);
      held.clear();
    } else if (request.url === "/control/release-aux" && request.method === "POST") {
      for (const [item, coding] of held) {
        if (coding) continue;
        complete(item, false);
        held.delete(item);
      }
    } else if (request.url === "/control/hold" && request.method === "POST") hold = true;
    else if (request.url === "/control/clear" && request.method === "POST") failure = undefined;
    else if (
      ![
        "/control",
        "/control/usage",
        "/control/deny",
        "/control/fail",
        "/control/child",
        "/control/tool",
      ].includes(request.url)
    ) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        generation,
        pid: processHandle?.pid,
        running: processHandle?.exitCode === null && processHandle?.signalCode === null,
        providerRequests,
        heldRequests: held.size,
        heldCodingRequests: [...held.values()].filter(Boolean).length,
        browserTools,
        imageRequests,
      }),
    );
  } catch (error) {
    response.writeHead(500);
    response.end(error.message);
  }
});
control.listen(4097, "0.0.0.0", start);
