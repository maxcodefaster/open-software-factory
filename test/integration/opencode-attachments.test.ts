import { expect, test } from "bun:test";
import { fixture } from "../fixtures/change-agent-turns";
import { ownedBrowserJPEG } from "../fixtures/browser-image";
import { pinnedOpenCode, observe } from "../fixtures/pinned-opencode";
import { createAttachmentStore } from "../../apps/factory/src/attachments/store";
import { attachmentDigest } from "../../apps/factory/src/attachments/objects";
import { createAttachmentTools } from "../../apps/factory/src/attachments/tools";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { createBuildBrowserEndpoint } from "../../apps/factory/src/agent/browser-endpoint";
import { connectOpenCodeBrowser } from "../../apps/factory/src/agent/opencode-browser";
import { attachmentMarkdown } from "../../packages/conversation-domain/src/attachments";
import { buildModelID } from "../fixtures/change-agent-turns";

test("pinned OpenCode reads an admitted human attachment as a native model image, without shell or file detours", async () => {
  const f = await fixture();
  const blobs = new Map<string, Uint8Array>();
  const jpeg = new Uint8Array(Buffer.from(ownedBrowserJPEG, "base64"));
  const store = createAttachmentStore(
    f.database,
    {
      async put(key, data) {
        blobs.set(key, data);
      },
      async read(key) {
        return blobs.get(key)!;
      },
      async remove(key) {
        blobs.delete(key);
      },
    },
    async () => ({ text: "", previews: [{ name: "Image", mediaType: "image/jpeg", data: jpeg }] }),
  );
  let target: Awaited<ReturnType<typeof pinnedOpenCode>> | undefined;
  let endpoint: ReturnType<typeof Bun.serve> | undefined;
  try {
    const input = {
      id: crypto.randomUUID(),
      projectId: f.projectID,
      name: "human-reference.jpg",
      mediaType: "image/jpeg" as const,
      bytes: jpeg.length,
      sha256: attachmentDigest(jpeg),
    };
    await store.begin(f.userID, input);
    await store.upload(f.userID, input.id, jpeg);
    const admission = createChangeAdmission(f.database, buildModelID);
    const admitted = await admission.admit(f.changeID, f.userID, {
      kind: "change-prompt",
      commandId: crypto.randomUUID(),
      text: `Inspect this reference without changing files.\n${attachmentMarkdown(input)}`,
    });
    const turns = createAgentTurnStore(f.database);
    const owner = await turns.claimPending(admitted.turn.id, 60_000);
    if (!owner?.ownerToken) throw new Error("Owned attachment turn lease missing");
    await f.writers.prepareAgent(f.changeID, owner.id);
    await turns.beginDispatch(owner.id, owner.ownerToken);
    const capability = crypto.randomUUID();
    const calls: string[] = [];
    const facade = createBuildBrowserEndpoint(
      {
        authorize: async (_id, authorization) =>
          authorization === `Bearer ${capability}`
            ? {
                session: {
                  id: crypto.randomUUID(),
                  ordinal: 1,
                  turnID: owner.id,
                  changeID: f.changeID,
                  attemptID: f.attemptID,
                  generation: 1,
                  agentSessionID: "ses_owned_attachments",
                  ownerID: f.userID,
                  state: "active" as const,
                },
                ownerToken: owner.ownerToken!,
              }
            : null,
        authorizeRuntime: async () => null,
        call: async () => {
          throw new Error("No browser action belongs to this attachment proof");
        },
      },
      undefined,
      undefined,
      createAttachmentTools(f.database, store),
    );
    endpoint = Bun.serve({
      hostname: "0.0.0.0",
      port: 0,
      async fetch(request) {
        const body = await request
          .clone()
          .json()
          .catch(() => null);
        if (body?.method === "tools/call") calls.push(body.params.name);
        return facade(request, "owned-attachment-facade");
      },
    });
    target = await pinnedOpenCode();
    const sessionID = `ses_owned_attachment_${crypto.randomUUID().replaceAll("-", "")}`;
    await target.client.session.create({
      id: sessionID,
      title: "Owned native human attachment",
      location: { directory: "/workspace/project" },
      model: { providerID: "factory", id: buildModelID },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    });
    await connectOpenCodeBrowser(
      target.client,
      `http://host.orb.internal:${endpoint.port}/fixed`,
      capability,
    );
    await target.control(`/attachment-mcp/${input.id}`, "POST");
    await target.control("/release", "POST");
    await target.client.session.prompt({
      sessionID,
      id: `msg_owned_${crypto.randomUUID().replaceAll("-", "")}`,
      text: (await admission.intent(owner.id)).text,
      delivery: "queue",
      resume: true,
    });
    const state = await observe(
      () => target!.control(),
      (state) => {
        if (state.providerRequests >= 2 && !state.imageRequests)
          throw new Error(
            `Native attachment result had no image: ${JSON.stringify({ calls, requests: state.providerRequests, tools: state.browserTools })}`,
          );
        return state.imageRequests > 0;
      },
      "The admitted attachment image did not reach native model input",
      30_000,
    );
    expect(state.imageRequests).toBe(1);
    expect(calls).toEqual(["attachment_read"]);
    const messages = await target.client.message.list({ sessionID, limit: 20 });
    const tools = messages.data.flatMap((message) =>
      message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
    );
    expect(tools.some((tool) => tool.name.includes("attachment_read"))).toBe(true);
    expect(tools.some((tool) => ["shell", "read"].includes(tool.name))).toBe(false);
    await turns.settle(
      owner.id,
      owner.ownerToken,
      "completed",
      "Native attachment image delivery verified",
    );
  } finally {
    await target?.dispose();
    await endpoint?.stop(true);
    await f.dispose();
  }
}, 60_000);
