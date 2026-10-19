import { expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  observeOpenCodeWork,
  promptRecordedOpenCodeInput,
} from "../../apps/factory/src/agent/opencode-client";
import { openCodeModelConfiguration } from "../../packages/runtime-kubernetes/src/opencode-model";
import { pinnedOpenCode } from "../fixtures/pinned-opencode";
import { codingReasoningInput } from "../../packages/conversation-domain/src/model-settings";

test.skipIf(process.env["FACTORY_OPENCODE_SOL_LIVE"] !== "1")(
  "pinned OpenCode implements and tests an owned goal using Azure Sol and selected reasoning",
  async () => {
    const apiKey = process.env["FACTORY_MODEL_API_KEY"];
    const baseURL = process.env["FACTORY_MODEL_BASE_URL"];
    const modelID = process.env["FACTORY_AGENT_MODEL_ID"];
    const reasoningEffort = codingReasoningInput.parse(
      process.env["FACTORY_OPENCODE_SOL_REASONING"] ?? "medium",
    );
    if (!apiKey || !baseURL || modelID !== "gpt-6.1-sol")
      throw new Error("Explicit Azure Sol connection required for this live proof");
    const endpoint = new URL(baseURL);
    if (endpoint.protocol !== "https:" || !endpoint.hostname.endsWith(".openai.azure.com"))
      throw new Error("This proof requires the explicitly selected Azure endpoint");
    const id = crypto.randomUUID();
    const directory = resolve(".factory/test-results/opencode-sol", id);
    await mkdir(directory, { recursive: true });
    const requests: Array<{ path: string; model: string; reasoning: string }> = [];
    const configuration = openCodeModelConfiguration({ modelID, reasoningEffort });
    const capability = crypto.randomUUID();
    const proxy = Bun.serve({
      hostname: "0.0.0.0",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path !== "/v1/responses" || request.method !== "POST")
          return new Response(null, { status: 404 });
        if (request.headers.get("authorization") !== `Bearer ${capability}`)
          return new Response(null, { status: 401 });
        const body = await request.json();
        if (
          body.model !== modelID ||
          body.reasoning?.effort !== reasoningEffort ||
          body.store !== false
        )
          return new Response(null, { status: 403 });
        requests.push({ path, model: body.model, reasoning: body.reasoning.effort });
        const response = await fetch(`${baseURL.replace(/\/$/, "")}/responses`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: request.signal,
          redirect: "error",
        });
        return new Response(response.body, {
          status: response.status,
          headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
        });
      },
    });
    let owned: Awaited<ReturnType<typeof pinnedOpenCode>> | undefined;
    let cleaned = false;
    let succeeded = false;
    try {
      owned = await pinnedOpenCode(
        undefined,
        undefined,
        undefined,
        `http://host.orb.internal:${proxy.port}/v1`,
        undefined,
        undefined,
        undefined,
        { modelID, ...configuration, settings: { ...configuration.settings, apiKey: capability } },
      );
      const sessionID = `ses_factory_${id.replaceAll("-", "")}`;
      await owned.client.session.create({
        id: sessionID,
        title: "Owned Azure Sol Coding goal",
        location: { directory: "/workspace/project" },
        model: { id: modelID, providerID: "factory" },
        agent: "build",
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      });
      await promptRecordedOpenCodeInput(
        owned.client,
        {
          sessionID,
          promptID: `msg_factory_${id.replaceAll("-", "")}`,
          bootstrap: false,
          text: [
            "Goal: implement and test a small sum module in this owned empty checkout.",
            "Create sum.mjs exporting sum(a,b), and sum.test.mjs using node:test and node:assert/strict.",
            "Cover 2+3=5, -2+1=-1 and 0+0=0. Run node --test sum.test.mjs with your shell tool and fix any failures.",
            "Do not commit or push. Finish with an ordinary short summary, no JSON completion form.",
          ].join("\n"),
        },
        true,
      );
      let finished = false;
      const deadline = Date.now() + 240_000;
      while (Date.now() < deadline) {
        const [work, messages] = await Promise.all([
          observeOpenCodeWork(owned.client, sessionID),
          owned.client.message.list({ sessionID, limit: 100 }),
        ]);
        const assistant = messages.data.find((message) => message.type === "assistant");
        if (!work.running && assistant?.type === "assistant" && assistant.time.completed) {
          expect(assistant.error).toBeUndefined();
          expect(assistant.finish).toBe("stop");
          const tools = messages.data.flatMap((message) =>
            message.type === "assistant"
              ? message.content.filter((part) => part.type === "tool")
              : [],
          );
          expect(
            tools.some(
              (part) =>
                part.type === "tool" &&
                part.state.status === "completed" &&
                JSON.stringify(part.state).includes("node --test"),
            ),
          ).toBe(true);
          await Bun.write(
            resolve(directory, "native-history.json"),
            JSON.stringify(messages.data, null, 2),
          );
          finished = true;
          break;
        }
        await Bun.sleep(500);
      }
      expect(finished).toBe(true);
      const project = resolve(owned.scratch, "project");
      const source = await readFile(resolve(project, "sum.mjs"), "utf8");
      expect(source).toContain("sum");
      const independent = Bun.spawn(["node", "--test", "sum.test.mjs"], {
        cwd: project,
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(independent.stdout).text();
      await Bun.write(resolve(directory, "independent-check.txt"), output);
      expect(await independent.exited).toBe(0);
      const behavior = Bun.spawn(
        [
          "node",
          "--input-type=module",
          "--eval",
          [
            'import { sum } from "./sum.mjs";',
            'import assert from "node:assert/strict";',
            "assert.equal(sum(2,3),5); assert.equal(sum(-2,1),-1); assert.equal(sum(0,0),0);",
          ].join("\n"),
        ],
        { cwd: project, stdout: "pipe", stderr: "pipe" },
      );
      expect(await behavior.exited).toBe(0);
      expect(requests.length).toBeGreaterThan(1);
      expect(requests.every((request) => request.reasoning === reasoningEffort)).toBe(true);
      succeeded = true;
    } finally {
      await owned?.dispose();
      cleaned = true;
      await proxy.stop(true);
      await Bun.write(
        resolve(directory, "result.json"),
        JSON.stringify(
          {
            modelID,
            requests,
            cleaned,
            succeeded,
            instruction: "Native coding goal with ordinary summary; no mandatory completion JSON.",
          },
          null,
          2,
        ),
      );
    }
  },
  420_000,
);
