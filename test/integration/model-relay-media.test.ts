import { expect, test } from "bun:test";
import { createCanvas } from "@napi-rs/canvas";
import { runtimeModelToken } from "#runtime-domain/identity";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { createAgentTurnStore } from "../../apps/factory/src/agent/turn-store";
import { createModelRelay } from "../../apps/factory/src/models/relay";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";

test("the admitted model can receive retained browser screenshots beyond the old text-only relay bound", async () => {
  const owned = await fixture();
  const canvas = createCanvas(1280, 720);
  const context = canvas.getContext("2d");
  const image = context.createImageData(1280, 720);
  let seed = 41;
  for (let index = 0; index < image.data.length; index += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    image.data[index] = seed & 255;
    image.data[index + 1] = (seed >>> 8) & 255;
    image.data[index + 2] = (seed >>> 16) & 255;
    image.data[index + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  const jpeg = canvas.encodeSync("jpeg", 75);
  expect(jpeg.byteLength).toBeLessThan(2_000_000);
  const screenshot = {
    type: "input_image",
    image_url: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
  };
  const content: unknown[] = [
    { type: "input_text", text: "Inspect the retained browser observations" },
  ];
  const body = () =>
    JSON.stringify({
      model: buildModelID,
      stream: true,
      reasoning: { effort: "medium" },
      input: [{ role: "user", content }],
    });
  while (Buffer.byteLength(body()) <= 4_194_304) content.push(screenshot);
  const payload = body();
  const uploadedPrefix = Promise.withResolvers<void>();
  const finishUpload = Promise.withResolvers<void>();
  let pending: Promise<Response> | undefined;
  let calls = 0;
  let revokeDuringDrain = false;
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls++;
      expect(request.headers.get("authorization")).toBe("Bearer owned-media-provider-key");
      expect(await request.text()).toBe(payload);
      return new Response("data: owned-browser-observation\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  try {
    const { turn } = await createChangeAdmission(owned.database, buildModelID).admit(
      owned.changeID,
      owned.userID,
      { kind: "change-start", commandId: crypto.randomUUID() },
    );
    const turns = createAgentTurnStore(owned.database);
    const owner = await turns.claimPending(turn.id);
    if (!owner?.ownerToken) throw new Error("Owned media turn was not claimed");
    await turns.beginDispatch(turn.id, owner.ownerToken);
    await owned.database.client`UPDATE factory.change_agent_turn_intent SET
      runtime_attempt_id=${owned.attemptID} WHERE turn_id=${turn.id}`;
    await owned.database.client`UPDATE factory.change_agent_session SET active_turn_id=${turn.id},
      state='working',opencode_session_id=(SELECT session_id FROM factory.change_agent_turn_intent
        WHERE turn_id=${turn.id}) WHERE change_id=${owned.changeID}`;
    const secret = "owned-media-relay-secret";
    const [beforeEpoch] = await owned.database.client<{ epoch: string }[]>`
      SELECT model_request_epoch::text AS epoch FROM factory.change_agent_turn_intent WHERE turn_id=${turn.id}`;
    if (!beforeEpoch) throw new Error("Owned relay epoch missing");
    const relay = createModelRelay(
      owned.database,
      secret,
      {
        baseURL: `http://127.0.0.1:${provider.port}/v1`,
        apiKey: "owned-media-provider-key",
      },
      async (turnID, attemptID, sessionID) => {
        expect(turnID).toBe(turn.id);
        expect(attemptID).toBe(owned.attemptID);
        const [intent] = await owned.database.client`SELECT session_id
          FROM factory.change_agent_turn_intent WHERE turn_id=${turn.id}`;
        expect(sessionID).toBe(intent?.["session_id"]);
        if (revokeDuringDrain)
          await owned.database
            .client`UPDATE factory.change_agent_session SET state='stopped',stop_pending=true
            WHERE change_id=${owned.changeID}`;
      },
    );
    const request = new Request("http://factory.invalid/internal/model", {
      method: "POST",
      headers: {
        authorization: `Bearer ${runtimeModelToken(secret, owned.attemptID, 1)}`,
        "content-type": "application/json",
      },
      body: payload,
    });
    const response = await relay(request, owned.attemptID, "responses");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("data: owned-browser-observation\n\n");
    expect(calls).toBe(1);
    const epoch = async () => {
      const [row] = await owned.database.client<{ epoch: string }[]>`
        SELECT model_request_epoch::text AS epoch FROM factory.change_agent_turn_intent WHERE turn_id=${turn.id}`;
      if (!row) throw new Error("Owned relay epoch missing");
      return BigInt(row.epoch);
    };
    expect(await epoch()).toBe(BigInt(beforeEpoch.epoch) + 1n);
    revokeDuringDrain = true;
    const denied = await relay(
      new Request("http://factory.invalid/internal/model", {
        method: "POST",
        headers: { authorization: `Bearer ${runtimeModelToken(secret, owned.attemptID, 1)}` },
        body: JSON.stringify({ model: buildModelID, reasoning: { effort: "medium" }, input: [] }),
      }),
      owned.attemptID,
      "responses",
    );
    expect(denied.status).toBe(403);
    expect(calls).toBe(1);
    expect(await epoch()).toBe(BigInt(beforeEpoch.epoch) + 1n);
    revokeDuringDrain = false;
    await owned.database
      .client`UPDATE factory.change_agent_session SET state='working',stop_pending=false
      WHERE change_id=${owned.changeID}`;
    let phase = 0;
    pending = relay(
      new Request("http://factory.invalid/internal/model", {
        method: "POST",
        headers: { authorization: `Bearer ${runtimeModelToken(secret, owned.attemptID, 1)}` },
        body: new ReadableStream({
          async pull(controller) {
            if (phase++ === 0) controller.enqueue(new TextEncoder().encode(payload.slice(0, -1)));
            else {
              uploadedPrefix.resolve();
              await finishUpload.promise;
              controller.enqueue(new TextEncoder().encode(payload.slice(-1)));
              controller.close();
            }
          },
        }),
      }),
      owned.attemptID,
      "responses",
    );
    await uploadedPrefix.promise;
    await owned.database.client`UPDATE factory.change_agent_session SET state='stopped'
      WHERE change_id=${owned.changeID}`;
    finishUpload.resolve();
    expect((await pending).status).toBe(403);
    expect(calls).toBe(1);
    expect(await epoch()).toBe(BigInt(beforeEpoch.epoch) + 1n);
  } finally {
    finishUpload.resolve();
    await pending?.then((response) => response.body?.cancel()).catch(() => {});
    await provider.stop(true);
    await owned.dispose();
  }
}, 30_000);
