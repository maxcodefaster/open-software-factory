import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { buildModelID } from "../fixtures/change-agent-turns";
import { observe, pinnedOpenCode } from "../fixtures/pinned-opencode";

test("native no-file revert clears queued input but does not revoke its identity", async () => {
  const process = await pinnedOpenCode();
  const sessionID = `ses_owned_${crypto.randomUUID().replaceAll("-", "")}`;
  const emptySessionID = `${sessionID}_empty`;
  const revoked = {
    sessionID,
    id: `msg_owned_${crypto.randomUUID().replaceAll("-", "")}`,
    text: "Revoked queue probe. Reply without tools.",
    delivery: "queue" as const,
    resume: false,
  };
  try {
    const configuration = {
      location: { directory: "/workspace/project" },
      model: { providerID: "factory", id: buildModelID },
    };
    await process.client.session.create({ ...configuration, id: emptySessionID });
    // A queued input is not a message boundary, including the first input.
    const firstQueued = { ...revoked, sessionID: emptySessionID, id: `${revoked.id}_first` };
    await process.client.session.prompt(firstQueued);
    await expect(
      process.client.session.revert.stage({
        sessionID: emptySessionID,
        messageID: firstQueued.id,
        files: false,
      }),
    ).rejects.toMatchObject({ sessionID: emptySessionID, messageID: firstQueued.id });
    expect((await process.control()).providerRequests).toBe(0);

    // A configuration message supplies a native boundary without inference.
    await process.client.session.create({ ...configuration, id: sessionID });
    await process.client.session.switchAgent({ sessionID, agent: "build" });
    const boundary = (await process.client.message.list({ sessionID, limit: 100 })).data[0];
    if (!boundary) throw new Error("Native cancellation probe requires a message boundary");
    await process.client.session.prompt(revoked);
    const retained = resolve(process.scratch, "project", "retained.txt");
    await Bun.write(retained, "Manual edits must survive Stop\n");
    await process.client.session.interrupt({ sessionID });
    await process.client.session.revert.stage({ sessionID, messageID: boundary.id, files: false });
    await process.client.session.revert.commit({ sessionID });
    expect(await Bun.file(retained).text()).toBe("Manual edits must survive Stop\n");

    expect((await process.control()).providerRequests).toBe(0);
    await process.control("/release", "POST");
    const wakeID = `${revoked.id}_wake`;
    await process.client.session.prompt({
      ...revoked,
      id: wakeID,
      text: "Later wake probe. Reply without tools.",
      resume: true,
    });
    const cleared = await observe(
      () => process.client.message.list({ sessionID, limit: 100 }),
      (messages) =>
        messages.data.some((message) => message.id === wakeID) &&
        messages.data.some((message) => message.type === "assistant" && message.time.completed),
    );
    expect(cleared.data.some((message) => message.id === revoked.id)).toBe(false);
    expect((await process.control()).providerRequests).toBe(1);

    // A delayed delivery with the removed identity is accepted anew. Revert
    // is therefore not a durable Stop boundary, even after its 204 response.
    await process.client.session.prompt(revoked);
    await process.client.session.prompt({ ...revoked, resume: true });
    await observe(
      () => process.client.message.list({ sessionID, limit: 100 }),
      (messages) => messages.data.some((message) => message.id === revoked.id),
    );
    await observe(
      () => process.control(),
      (control) => control.providerRequests === 2,
    );
    expect((await process.control()).providerRequests).toBe(2);
  } finally {
    try {
      await process.control("/release", "POST");
    } finally {
      await process.dispose();
    }
  }
}, 45_000);
