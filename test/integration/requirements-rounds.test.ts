import { expect, test } from "bun:test";
import { zeroDrizzle } from "@rocicorp/zero/server/adapters/drizzle";
import { createProjectAgentController } from "../../apps/factory/src/project-agent/controller";
import { zeroSchema } from "../../packages/zero-schema/src";
import { zeroServerMutators } from "../../packages/zero-schema/src/server";
import { fixture } from "../fixtures/change-agent-turns";
import { eventually, factoryProcess } from "../fixtures/factory-process";

test("automatic Requirements entry starts once; round advancement persists without another model call", async () => {
  const process = await factoryProcess();
  const db = process.connect();
  const question = (prompt: string) => ({
    type: "free-text" as const,
    prompt,
    placeholder: "Your answer",
  });
  let requests = 0;
  const model = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const input = (await request.json()) as { stream?: boolean };
      requests++;
      const output = {
        kind: "round",
        message: "Two open decisions",
        questions: [question("Who uses this?"), question("What outcome matters?")],
        citations: [],
      };
      const content = JSON.stringify({ output });
      const common = { id: "owned-round", created: 1, model: "owned-round-model" };
      if (!input.stream)
        return Response.json({
          ...common,
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        });
      return new Response(
        `data: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const overrides = {
    FACTORY_PLANNING_MODEL_BASE_URL: `http://127.0.0.1:${model.port}/v1`,
    FACTORY_PLANNING_MODEL_API_KEY: "owned-test-token",
    FACTORY_PROJECT_AGENT_MODEL: "owned-round-model",
  };
  const previous = Object.keys(overrides).map((key) => [key, Bun.env[key]] as const);
  for (const [key, value] of Object.entries(overrides)) Bun.env[key] = value;
  try {
    const owned = await fixture(undefined, undefined, db);
    const ticketID = crypto.randomUUID();
    const zero = zeroDrizzle(zeroSchema, db.db);
    const ctx = { userId: owned.userID, systemManager: false };
    const args = {
      id: ticketID,
      projectId: owned.projectID,
      title: "An idea",
      description: "",
      state: "ready" as const,
    };
    const create = () =>
      zero.transaction((tx) => zeroServerMutators.tickets.create.fn({ tx, ctx, args }));
    await Promise.all([create(), create()]);
    expect((await db.client`SELECT id FROM factory.ticket WHERE id=${ticketID}`).length).toBe(1);
    expect(
      (
        await db.client`SELECT command_id FROM factory.requirements_entry_intent WHERE ticket_id=${ticketID}`
      ).length,
    ).toBe(1);
    await expect(
      zero.transaction((tx) =>
        zeroServerMutators.tickets.create.fn({
          tx,
          ctx,
          args: { ...args, title: "Different text" },
        }),
      ),
    ).rejects.toThrow("different content");
    const controller = createProjectAgentController(db, { start: async () => null });
    await Promise.all([
      controller.dispatchRequirementsEntries(),
      controller.dispatchRequirementsEntries(),
    ]);
    const first = await eventually(
      () => controller.get(owned.projectID, ticketID, owned.userID),
      (value) =>
        value?.turn?.state === "completed" &&
        value.entries.some((entry) => entry.kind === "question"),
      "Round did not complete",
    );
    const firstQuestion = first?.entries.find((entry) => entry.kind === "question");
    if (!firstQuestion) throw new Error("No first question");
    expect(first?.entries.filter((entry) => entry.kind === "question")).toHaveLength(1);
    expect(requests).toBe(1);
    const answerID = crypto.randomUUID();
    const answer = { selectedOptionIds: [], customText: "Product contributors" };
    const second = await controller.answer(
      owned.projectID,
      ticketID,
      firstQuestion.id,
      answer,
      owned.userID,
      answerID,
    );
    expect(second?.entries.filter((entry) => entry.kind === "question")).toHaveLength(2);
    expect(requests).toBe(1);
    await controller.answer(
      owned.projectID,
      ticketID,
      firstQuestion.id,
      answer,
      owned.userID,
      answerID,
    );
    expect(requests).toBe(1);
    expect(
      (await controller.get(owned.projectID, ticketID, owned.userID))?.entries.filter(
        (entry) => entry.kind === "answer",
      ),
    ).toHaveLength(1);
    await controller.dispatchRequirementsEntries();
    expect(requests).toBe(1);
    for (const [state, expectedVersion] of [
      ["inbox", 1],
      ["ready", 2],
    ] as const)
      await zero.transaction((tx) =>
        zeroServerMutators.tickets.move.fn({
          tx,
          ctx,
          args: { projectId: owned.projectID, ticketId: ticketID, state, expectedVersion },
        }),
      );
    await controller.dispatchRequirementsEntries();
    expect(requests).toBe(1);
    const currentQuestion = second?.entries.filter((entry) => entry.kind === "question").at(-1);
    if (!currentQuestion) throw new Error("Missing next question");
    await controller.message(
      owned.projectID,
      ticketID,
      "Change direction: this is internal-only",
      owned.userID,
      crypto.randomUUID(),
    );
    await expect(
      controller.answer(
        owned.projectID,
        ticketID,
        currentQuestion.id,
        answer,
        owned.userID,
        crypto.randomUUID(),
      ),
    ).rejects.toThrow("direction changed");
    expect(requests).toBe(2);
    const restarted = createProjectAgentController(db, { start: async () => null });
    await restarted.recover();
    expect(requests).toBe(2);
    const retainedID = crypto.randomUUID();
    await zero.transaction((tx) =>
      zeroServerMutators.tickets.create.fn({
        tx,
        ctx,
        args: { ...args, id: retainedID, title: "Retained after unavailable model" },
      }),
    );
    const connectionKeys = ["FACTORY_PLANNING_MODEL_API_KEY", "FACTORY_MODEL_API_KEY"] as const;
    const connections = connectionKeys.map((key) => [key, Bun.env[key]] as const);
    try {
      for (const key of connectionKeys) Bun.env[key] = "";
      await controller.dispatchRequirementsEntries();
      const failed = await eventually(
        () => controller.get(owned.projectID, retainedID, owned.userID),
        (value) => value?.turn?.state === "failed",
        "Missing retained model failure",
      );
      expect(failed?.turn?.state).toBe("failed");
      expect((await db.client`SELECT id FROM factory.ticket WHERE id=${retainedID}`).length).toBe(
        1,
      );
      expect(requests).toBe(2);
    } finally {
      for (const [key, value] of connections) {
        if (value === undefined) delete Bun.env[key];
        else Bun.env[key] = value;
      }
    }
    await controller.message(
      owned.projectID,
      retainedID,
      "Continue elaborating my retained Ticket",
      owned.userID,
      crypto.randomUUID(),
      "requirements-interview",
    );
    expect(requests).toBe(3);
    expect(
      (await controller.get(owned.projectID, retainedID, owned.userID))?.entries.some(
        (entry) => entry.kind === "question",
      ),
    ).toBe(true);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
    await model.stop(true);
    await db.client.end();
    await process.dispose();
  }
}, 60_000);
