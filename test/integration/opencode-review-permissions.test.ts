import { expect, test } from "bun:test";
import { createBuildBrowserEndpoint } from "../../apps/factory/src/agent/browser-endpoint";
import { createCandidateReviewController } from "../../apps/factory/src/agent/candidate-review";
import { connectOpenCodeBrowser } from "../../apps/factory/src/agent/opencode-browser";
import { confirmSettledOpenCodeInput } from "../../apps/factory/src/agent/opencode-client";
import { candidateReviewPermissions } from "../../packages/conversation-domain/src/candidate-review";
import type { createForgejoClient } from "../../packages/forge/src/forge";
import { candidateReviewFixture } from "../fixtures/candidate-review";
import { buildModelID } from "../fixtures/change-agent-turns";
import { docker, observe, pinnedOpenCode } from "../fixtures/pinned-opencode";

test("pinned OpenCode reviewer denies shell, edits and writing descendants while retaining fixed source tools", async () => {
  const f = await candidateReviewFixture();
  const turn = await f.activeReview();
  const renewal = setInterval(() => void f.turns.renew(turn.id, turn.ownerToken), 10_000);
  const toolLists: string[][] = [];
  let requests = 0;
  const script = [
    {
      name: "shell",
      arguments: {
        command: "printf denied > /workspace/project/reviewer-write.txt",
        description: "Owned deny proof",
      },
    },
    {
      name: "subagent",
      arguments: {
        agent: "general",
        description: "Owned deny proof",
        prompt: "Write /workspace/project/reviewer-child.txt",
      },
    },
    {
      name: "write",
      arguments: { path: "/workspace/project/reviewer-edit.txt", content: "denied" },
    },
    {
      name: "edit",
      arguments: {
        path: "/workspace/project/reviewer-edit.txt",
        oldString: "",
        newString: "denied",
      },
    },
    {
      name: "apply_patch",
      arguments: {
        patchText:
          "*** Begin Patch\n*** Add File: /workspace/project/reviewer-edit.txt\n+denied\n*** End Patch",
      },
    },
    { name: "factory_browser_review_read", arguments: { path: "src/sum.ts" } },
  ];
  const provider = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    async fetch(request) {
      const body = await request.json();
      toolLists.push(
        (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name),
      );
      const call = script[requests++];
      const choices = (delta: unknown, finish_reason: string | null = null) => ({
        id: `owned-review-${requests}`,
        object: "chat.completion.chunk",
        model: buildModelID,
        choices: [{ index: 0, delta, finish_reason }],
      });
      const delta = call
        ? {
            tool_calls: [
              {
                index: 0,
                id: `owned-call-${requests}`,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              },
            ],
          }
        : { content: "Owned read-only review finished." };
      return new Response(
        [
          `data: ${JSON.stringify(choices(delta))}\n\n`,
          `data: ${JSON.stringify(choices({}, call ? "tool_calls" : "stop"))}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const forge = {
    listFiles: async () => [{ path: "src/sum.ts", size: 50, sha: f.commit }],
    getFile: async () => "export const sum = (a,b) => a+b;\n",
  } as unknown as ReturnType<typeof createForgejoClient>;
  const review = createCandidateReviewController(f.database, forge);
  const session = {
    id: crypto.randomUUID(),
    ordinal: 1,
    turnID: turn.id,
    changeID: f.changeID,
    attemptID: f.attemptID,
    generation: 1,
    agentSessionID: turn.sessionID,
    ownerID: "owned",
    state: "active" as const,
  };
  const facade = createBuildBrowserEndpoint(
    {
      authorize: async () => ({ session, ownerToken: turn.ownerToken }),
      authorizeRuntime: async () => null,
      call: async () => {
        throw new Error("This source-only proof should not call Apps");
      },
    },
    review,
  );
  const endpoint = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    fetch: (request) => facade(request, session.id),
  });
  let owned: Awaited<ReturnType<typeof pinnedOpenCode>> | undefined;
  try {
    owned = await pinnedOpenCode(
      undefined,
      undefined,
      undefined,
      `http://host.orb.internal:${provider.port}/v1`,
    );
    await owned.client.session.create({
      id: turn.sessionID,
      title: "Owned immutable-source reviewer",
      location: { directory: "/workspace/project" },
      model: { id: buildModelID, providerID: "factory" },
      permissions: candidateReviewPermissions,
    });
    await connectOpenCodeBrowser(
      owned.client,
      `http://host.orb.internal:${endpoint.port}/mcp`,
      "owned",
    );
    const promptID = `msg_owned_review_${crypto.randomUUID().replaceAll("-", "")}`;
    await owned.client.session.prompt({
      sessionID: turn.sessionID,
      id: promptID,
      text: "Read the source using only the admitted review tools, then finish.",
      delivery: "queue",
      resume: true,
    });
    await observe(
      () => confirmSettledOpenCodeInput(owned!.client, turn.sessionID, promptID),
      Boolean,
      "Native reviewer did not settle",
      30_000,
    );
    expect(requests).toBe(script.length + 1);
    expect(
      toolLists.every(
        (names) => names.length > 0 && names.every((name) => name.startsWith("factory_browser_")),
      ),
    ).toBe(true);
    const messages = await owned.client.message.list({ sessionID: turn.sessionID, limit: 50 });
    const tools = messages.data.flatMap((message) =>
      message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
    );
    if (
      tools.find((tool) => tool.name === "factory_browser_review_read")?.state.status !==
      "completed"
    )
      console.log("Owned native tool outcomes", JSON.stringify(tools));
    expect(tools.find((tool) => tool.name === "factory_browser_review_read")?.state.status).toBe(
      "completed",
    );
    for (const name of ["shell", "subagent", "write", "edit", "apply_patch"])
      expect(tools.find((tool) => tool.name === name)?.state.status).toBe("error");
    expect(
      (await owned.client.session.list({ directory: "/workspace/project" })).data,
    ).toHaveLength(1);
    await docker(
      "exec",
      owned.container,
      "sh",
      "-c",
      "test ! -e /workspace/project/reviewer-write.txt && test ! -e /workspace/project/reviewer-child.txt && test ! -e /workspace/project/reviewer-edit.txt",
    );
    expect((await f.review())?.evidence.length).toBe(1);
  } catch (cause) {
    if (owned)
      console.log("Owned reviewer permissions diagnostics", await owned.diagnostics(), toolLists);
    throw cause;
  } finally {
    clearInterval(renewal);
    await owned?.dispose();
    await endpoint.stop(true);
    await provider.stop(true);
    await f.dispose();
  }
}, 120_000);
