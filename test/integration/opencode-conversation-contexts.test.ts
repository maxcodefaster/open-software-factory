import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { fixture, buildModelID } from "../fixtures/change-agent-turns";
import { observe, pinnedOpenCode } from "../fixtures/pinned-opencode";
import { createProjectAgentController } from "../../apps/factory/src/project-agent/controller";

test("a fresh native Coding context keeps its original Session and canonical source without creating another runtime", async () => {
  const owned = await fixture();
  let native: Awaited<ReturnType<typeof pinnedOpenCode>> | undefined;
  let controller: ReturnType<typeof owned.controller> | undefined;
  try {
    native = await pinnedOpenCode();
    await native.control("/release", "POST");
    const marker = resolve(native.scratch, "project", "retained-human-file.txt");
    await Bun.write(marker, "Retained source belongs to the Ticket, not its conversation.\n");
    await native.client.session.create({
      id: owned.sessionID,
      title: "Original Coding context",
      location: { directory: "/workspace/project" },
      model: { providerID: "factory", id: buildModelID },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    });
    await native.client.session.prompt({
      sessionID: owned.sessionID,
      id: `msg_original_${owned.changeID.replaceAll("-", "")}`,
      text: "Answer this retained conversation without tools.",
      delivery: "queue",
      resume: true,
    });
    const original = await observe(
      () => native!.client.message.list({ sessionID: owned.sessionID, limit: 50 }),
      (page) =>
        page.data.some(
          (message) =>
            message.type === "assistant" &&
            Boolean(message.time.completed) &&
            message.finish === "stop",
        ),
    );
    let creates = 0,
      prompts = 0;
    owned.hub.request = async (_attempt, _channel, request, path) => {
      const target = new URL(request.url);
      if (request.method === "POST" && target.pathname === "/api/session") creates++;
      if (request.method === "POST" && target.pathname.endsWith("/prompt")) prompts++;
      return native!.transport(request, path ?? `${target.pathname}${target.search}`);
    };
    controller = owned.controller();
    const modelRequestsBeforeNew = (await native.control()).providerRequests;
    const contextID = await controller.newConversation(
      owned.changeID,
      owned.userID,
      crypto.randomUUID(),
      null,
    );
    expect(creates).toBe(0);
    expect(prompts).toBe(0);
    expect((await native.control()).providerRequests).toBe(modelRequestsBeforeNew);
    const commandID = crypto.randomUUID();
    await controller.prompt(
      owned.changeID,
      "Use this new conversation without losing the source.",
      owned.userID,
      commandID,
      false,
      contextID,
    );
    await observe(
      () => controller!.get(owned.changeID),
      (view) => prompts === 1 && view.messages.some((message) => message.role === "assistant"),
      "Fresh native conversation was not dispatched",
      30_000,
    );
    const [intent] = await owned.database.client<{ sessionID: string }[]>`
      SELECT session_id AS "sessionID" FROM factory.change_agent_turn_intent
      WHERE turn_id=(SELECT id FROM factory.agent_turn WHERE command_id=${commandID})`;
    if (!intent) throw new Error("Owned fresh native intent missing");
    expect(intent.sessionID).not.toBe(owned.sessionID);
    expect(creates).toBe(1);
    expect(prompts).toBe(1);
    const fresh = await native.client.message.list({ sessionID: intent.sessionID, limit: 50 });
    expect(fresh.data.some((message) => message.type === "user")).toBe(true);
    expect(fresh.data.some((message) => original.data.some((old) => old.id === message.id))).toBe(
      false,
    );
    expect(
      (await native.client.message.list({ sessionID: owned.sessionID, limit: 50 })).data,
    ).toEqual(original.data);
    expect(await Bun.file(marker).text()).toBe(
      "Retained source belongs to the Ticket, not its conversation.\n",
    );
    const project = createProjectAgentController(owned.database, { start: async () => null });
    const history = await project.get(owned.projectID, owned.ticketID, owned.userID, "original");
    expect(history?.codingHistory).toMatchObject({ messagesAvailable: true });
    const [count] = await owned.database.client<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM factory.runtime_attempt WHERE change_id=${owned.changeID}`;
    expect(count?.count).toBe(1);
  } finally {
    await controller?.shutdown();
    await native?.dispose();
    await owned.dispose();
  }
}, 120_000);
