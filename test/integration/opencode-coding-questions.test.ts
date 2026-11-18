import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  confirmSettledOpenCodeInput,
  createOpenCodeClient,
  ensureOpenCodeMessageBoundary,
  promptRecordedOpenCodeInput,
} from "../../apps/factory/src/agent/opencode-client";
import { docker, observe } from "../fixtures/pinned-opencode";

test("Factory Coding excludes native question forms while retaining text clarification and follow-up", async () => {
  const image =
    process.env["FACTORY_OPENCODE_TEST_IMAGE"] ??
    (await readFile(resolve(".factory/build-runtime-host-image"), "utf8")).trim();
  if (!/^(?:[a-zA-Z0-9.:/-]+@)?sha256:[a-f0-9]{64}$/.test(image))
    throw new Error("Owned question proof requires the exact pinned runtime image");
  const id = crypto.randomUUID();
  const container = `factory-owned-coding-question-${id}`;
  const label = "factory.coding-question-test";
  const scratch = await realpath(await mkdtemp(resolve(tmpdir(), "factory-coding-question-")));
  const project = resolve(scratch, "project");
  await mkdir(project);
  await writeFile(resolve(project, "README.md"), "# Owned clarification\n");
  const evidence = resolve(".factory/test-results/coding-question-boundary", id);
  await mkdir(evidence, { recursive: true });
  const modelID = "owned-question-model";
  const tools: string[][] = [];
  const childTools: string[][] = [];
  let codingCalls = 0;
  let questionSchema: unknown;
  const provider = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    async fetch(request) {
      const body = await request.json();
      const names = (body.tools ?? []).map(
        (tool: { function: { name: string } }) => tool.function.name,
      ) as string[];
      const coding = names.length > 0;
      if (coding) {
        tools.push(names);
        if (JSON.stringify(body.messages).includes("Owned read-only child check."))
          childTools.push(names);
        codingCalls++;
        questionSchema ??= body.tools.find(
          (tool: { function: { name: string } }) => tool.function.name === "question",
        );
      }
      // Deliberately request the native tool once even if it is not advertised.
      // A stale/hallucinated call must fail, not create an unanswerable form.
      const call = coding && codingCalls === 1;
      const child = coding && codingCalls === 4;
      const delta = call
        ? {
            tool_calls: [
              {
                index: 0,
                id: "call_owned_question",
                type: "function",
                function: {
                  name: "question",
                  arguments: JSON.stringify({
                    questions: [
                      {
                        header: "Demo",
                        question: "Proceed with the demo heading?",
                        options: [{ label: "Proceed", description: "Continue the admitted task." }],
                      },
                    ],
                  }),
                },
              },
            ],
          }
        : child
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "call_owned_child",
                  type: "function",
                  function: {
                    name: "subagent",
                    arguments: JSON.stringify({
                      agent: "general",
                      description: "Owned child interaction boundary",
                      prompt: "Owned read-only child check.",
                    }),
                  },
                },
              ],
            }
          : {
              content: codingCalls <= 2 ? "Proceed with the demo heading?" : "Follow-up received.",
            };
      const chunk = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({
          id: "owned-question-response",
          object: "chat.completion.chunk",
          model: modelID,
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`;
      return new Response(
        `${chunk(delta, null)}${chunk({}, call || child ? "tool_calls" : "stop")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  let intended = false;
  async function dispose() {
    if (intended) {
      const owner = await docker(
        "inspect",
        "--format",
        `{{index .Config.Labels "${label}"}}`,
        container,
      ).catch((cause: unknown) => {
        if (cause instanceof Error && /no such (?:object|container)/i.test(cause.message))
          return null;
        throw cause;
      });
      if (owner !== null) {
        if (owner !== id) throw new Error("Owned question fixture cleanup refused");
        await docker("rm", "--force", "--volumes", container);
      }
      await writeFile(resolve(evidence, "cleanup.json"), JSON.stringify({ removed: true }));
    }
    await rm(scratch, { recursive: true, force: true });
  }
  try {
    await writeFile(
      resolve(evidence, "intent.json"),
      JSON.stringify({ container, owner: id, image, scratch, memory: 512 * 1024 * 1024 }),
    );
    intended = true;
    await docker(
      "run",
      "--detach",
      "--pull=never",
      "--name",
      container,
      "--label",
      `${label}=${id}`,
      "--memory=512m",
      "--memory-swap=512m",
      "--cpus=1",
      "--env",
      `FACTORY_PROCESS_MODEL_ID=${modelID}`,
      "--env",
      `FACTORY_PROCESS_PROVIDER_URL=http://host.orb.internal:${provider.port}/v1`,
      "--env",
      "FACTORY_PROCESS_PACKAGED_SERVER=1",
      "--env",
      "FACTORY_PROCESS_NATIVE_SERVER=1",
      "--publish",
      "127.0.0.1::4096",
      "--publish",
      "127.0.0.1::4097",
      "--mount",
      `type=bind,src=${project},dst=/workspace/project`,
      "--mount",
      `type=bind,src=${resolve("test/fixtures")},dst=/owned-fixture,readonly`,
      "--entrypoint",
      "node",
      image,
      "/owned-fixture/opencode-process.mjs",
    );
    const port = (await docker("port", container, "4096/tcp")).split(":").at(-1);
    const controlPort = (await docker("port", container, "4097/tcp")).split(":").at(-1);
    const client = createOpenCodeClient((request, path) => {
      const target = new Request(`http://127.0.0.1:${port}${path}`, request);
      target.headers.set(
        "authorization",
        `Basic ${Buffer.from("opencode:owned-opencode-server-password").toString("base64")}`,
      );
      return fetch(target, { signal: AbortSignal.timeout(10_000) });
    });
    const info = await observe(
      () => client.server.info().catch(() => null),
      (value) => value !== null,
      "Owned native question server did not start",
      45_000,
    );
    expect(info?.version).toBe("2.0.27");
    const sessionID = `ses_owned_question_${id.replaceAll("-", "")}`;
    await client.session.create({
      id: sessionID,
      location: { directory: "/workspace/project" },
      model: { id: modelID, providerID: "factory" },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    });
    await ensureOpenCodeMessageBoundary(client, sessionID);
    await fetch(`http://127.0.0.1:${controlPort}/control/release`, { method: "POST" });
    const input = {
      sessionID,
      promptID: `msg_owned_question_${id.replaceAll("-", "")}`,
      text: "Read README, then ask for clarification before editing.",
      bootstrap: false,
    };
    await promptRecordedOpenCodeInput(client, input, true);
    const forms = await observe(
      async () => ({
        forms: await client.session.form.list({ sessionID }),
        settled: await confirmSettledOpenCodeInput(client, sessionID, input.promptID),
      }),
      (value) => value.forms.length > 0 || value.settled,
      "Question neither settled nor established a pending native form",
    );
    await writeFile(
      resolve(evidence, "observed.json"),
      JSON.stringify({ tools, questionSchema, forms, codingCalls }, null, 2),
    );
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((names) => !names.includes("question"))).toBe(true);
    expect(tools[0]).toContain("read");
    expect(tools[0]).toContain("shell");
    expect(forms.forms).toEqual([]);
    expect(forms.settled).toBe(true);
    const messages = await client.message.list({ sessionID, limit: 30 });
    expect(
      messages.data.some(
        (message) =>
          message.type === "assistant" &&
          message.content.some(
            (part) => part.type === "text" && part.text === "Proceed with the demo heading?",
          ),
      ),
    ).toBe(true);
    const question = messages.data.flatMap((message) =>
      message.type === "assistant"
        ? message.content.filter((part) => part.type === "tool" && part.name === "question")
        : [],
    );
    expect(question[0]?.state?.status).toBe("error");
    await ensureOpenCodeMessageBoundary(client, sessionID);
    const followup = { ...input, promptID: `${input.promptID}_followup`, text: "Proceed." };
    await promptRecordedOpenCodeInput(client, followup, true);
    await observe(
      () => confirmSettledOpenCodeInput(client, sessionID, followup.promptID),
      Boolean,
      "Normal admitted Coding follow-up did not settle",
    );
    expect(
      (await client.message.list({ sessionID, limit: 30 })).data.some(
        (message) =>
          message.type === "user" &&
          message.id === followup.promptID &&
          message.text === followup.text,
      ),
    ).toBe(true);
    const childInput = {
      ...input,
      promptID: `${input.promptID}_child`,
      text: "Check the read-only child boundary.",
    };
    await ensureOpenCodeMessageBoundary(client, sessionID);
    await promptRecordedOpenCodeInput(client, childInput, true);
    await observe(
      () => confirmSettledOpenCodeInput(client, sessionID, childInput.promptID),
      Boolean,
      "Native child did not settle",
    );
    expect((await client.session.list({ parentID: sessionID })).data).toHaveLength(1);
    expect(childTools.length).toBeGreaterThan(0);
    expect(tools.every((names) => !names.includes("question"))).toBe(true);
    expect((await client.session.form.list({ sessionID })).length).toBe(0);
    expect((await readFile(resolve(project, "README.md"), "utf8")).trim()).toBe(
      "# Owned clarification",
    );
    // Native children inherit their parent's override at creation. Use an
    // omitted-override parent to exercise an existing child with no override.
    const omittedParentID = `${sessionID}_omitted_parent`;
    await client.session.create({
      id: omittedParentID,
      location: { directory: "/workspace/project" },
      model: { id: modelID, providerID: "factory" },
    });
    expect((await client.session.get({ sessionID: omittedParentID })).permissions).toBeUndefined();
    const reusedChildID = `${sessionID}_reused_child`;
    await client.session.create({
      id: reusedChildID,
      parentID: omittedParentID,
      location: { directory: "/workspace/project" },
      model: { id: modelID, providerID: "factory" },
    });
    expect((await client.session.get({ sessionID: reusedChildID })).permissions).toBeUndefined();
    await ensureOpenCodeMessageBoundary(client, reusedChildID);
    const reusedChild = await client.session.get({ sessionID: reusedChildID });
    expect(reusedChild.parentID).toBe(omittedParentID);
    expect(reusedChild.permissions).toEqual([
      { action: "question", resource: "*", effect: "deny" },
    ]);
    const reusedChildInput = {
      ...input,
      sessionID: reusedChildID,
      promptID: `${input.promptID}_reused_child`,
      text: "Owned read-only child check. Follow up in this existing child Session.",
    };
    await promptRecordedOpenCodeInput(client, reusedChildInput, true);
    await observe(
      () => confirmSettledOpenCodeInput(client, reusedChildID, reusedChildInput.promptID),
      Boolean,
      "Reused native child without an initial permission override did not settle",
    );
    expect((await client.session.form.list({ sessionID: reusedChildID })).length).toBe(0);
    expect(childTools.length).toBeGreaterThan(1);
    expect(tools.every((names) => !names.includes("question"))).toBe(true);
    await writeFile(
      resolve(evidence, "verified.json"),
      JSON.stringify({
        version: info?.version,
        tools,
        childTools,
        codingCalls,
        questionState: question[0]?.state?.status,
        pendingForms: await client.session.form.list({ sessionID }),
        followupSettled: true,
        childSettled: true,
        reusedChildSettled: true,
        reusedChildPermissions: reusedChild.permissions,
      }),
    );
    await writeFile(
      resolve(evidence, "resource-use.txt"),
      await docker("stats", "--no-stream", "--format", "{{.MemUsage}} {{.MemPerc}}", container),
    );
  } finally {
    try {
      await dispose();
    } finally {
      await provider.stop(true);
    }
  }
}, 90_000);
