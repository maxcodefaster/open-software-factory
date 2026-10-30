import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createWriterService } from "../../apps/factory/src/access/writer-service";
import type { AgentTurnTransaction } from "../../apps/factory/src/agent/turn-store";
import { writerViewSchema } from "../../apps/factory/src/api-contracts";
import { factoryBuildDirectory } from "../../apps/factory/src/build-directory";
import { CommandError } from "../../apps/factory/src/command-error";
import { createReviewService } from "../../apps/factory/src/review/service";
import type { FactoryServices } from "../../apps/factory/src/server-functions/context";
import { createServerFunctionEndpoint } from "../../apps/factory/src/server-functions/endpoint";
import { visualReviewSchema } from "../../packages/conversation-domain/src/visual-review";
import {
  decodeFactoryResponse as decodeResponse,
  factoryFunctionRequest,
} from "../fixtures/server-functions";

test("compiled Writer and Review commands preserve actors, epochs, immutable batches and admitted work after browser cancellation", async () => {
  const origin = "https://factory.test",
    actor = crypto.randomUUID(),
    project = crypto.randomUUID(),
    change = crypto.randomUUID();
  const commandID = crypto.randomUUID(),
    requestID = crypto.randomUUID(),
    feedbackID = crypto.randomUUID();
  let maintenance = true,
    authenticated = true,
    allowed = true,
    unconfirmed = false;
  const effects: Array<{ method: string; args: unknown[] }> = [];
  const record = (method: string, args: unknown[]) => effects.push({ method, args });
  const writerAdmitted = Promise.withResolvers<void>(),
    writerRelease = Promise.withResolvers<void>();
  const reviewAdmitted = Promise.withResolvers<void>(),
    reviewRelease = Promise.withResolvers<void>();
  const view = {
    ...writerViewSchema.parse({
      state: "human",
      epoch: 3,
      canWrite: true,
      yours: true,
      commandID: null,
      actor: null,
      requester: null,
    }),
    stopPending: false,
  };
  const access = {
    async requireChange(userID: string, id: string) {
      expect([userID, id]).toEqual([actor, change]);
      if (!allowed) throw new CommandError("not-found", "Change not found");
      return project;
    },
    async requireProject(userID: string, id: string) {
      expect([userID, id]).toEqual([actor, project]);
    },
  };
  const writer = createWriterService(
    {
      async status(...args) {
        record("status", args);
        return view;
      },
      async view(...args) {
        record("observe", args);
        return view;
      },
      async takeOver(...args) {
        record("takeover", args);
        return view;
      },
      async request(...args) {
        record("request", args);
        return view;
      },
      async approve(...args) {
        record("approve", args);
        return view;
      },
      async takeIdle(...args) {
        record("idle", args);
        return view;
      },
      async activity(...args) {
        record("activity", args);
      },
      async release(...args) {
        if (unconfirmed) return undefined as unknown as typeof view;
        record("release", args);
        writerAdmitted.resolve();
        await writerRelease.promise;
        return view;
      },
    },
    access,
  );
  const review = createReviewService({
    access,
    controller: {
      async get(...args) {
        record("review-get", args);
        return visualReviewSchema.parse({
          feedback: [],
          recording: null,
          scenarios: [],
        });
      },
      async create(...args) {
        record("feedback", args);
        return { feedbackId: feedbackID };
      },
      async update(...args) {
        record("update", args);
        return { feedbackId: feedbackID };
      },
      async dispatch(id, userID, input, admit) {
        record("send", [id, userID, input]);
        const turnId = await admit({} as AgentTurnTransaction, "Frozen correction", commandID);
        reviewAdmitted.resolve();
        await reviewRelease.promise;
        return { turnId };
      },
    },
    async admit(...args) {
      record("admit", [args[0], args[1], args[3], args[4]]);
      return commandID;
    },
    async dispatchPending(...args) {
      record("dispatch", args);
    },
  });
  const entry: typeof import("../../apps/factory/src/start-server") = await import(
    pathToFileURL(resolve(factoryBuildDirectory(), "server/entry.js")).href
  );
  const endpoint = createServerFunctionEndpoint({
    origin,
    services: { writer, review } as FactoryServices,
    session: async () => (authenticated ? { user: { id: actor } } : null),
    maintenance: async () => maintenance,
    requireFresh: async () => {
      throw new Error("Writer and Review did not add Fresh Auth");
    },
    handle: async (request, options) => entry.default.fetch(request, options),
  });
  const call = async (name: string, args: unknown[]) =>
    decodeResponse(await endpoint(await factoryFunctionRequest(origin, name, args)));
  const editing = { commandID, epoch: 3 };
  const feedback = { commandId: commandID, kind: "thread", body: "Retain the draft." };
  const update = {
    commandId: commandID,
    feedbackId: feedbackID,
    expectedVersion: 1,
    action: "reply",
    body: "Still reproducible.",
  };
  const batch = { commandId: commandID, feedback: [{ id: feedbackID, version: 1 }] };
  for (const [name, args] of [
    ["takeOverChangeEditing", [change, editing]],
    ["requestChangeEditing", [change, editing]],
    ["approveChangeEditing", [change, { ...editing, requestID }]],
    ["releaseChangeEditing", [change, editing]],
    ["takeOverIdleEditing", [change, editing]],
    ["recordChangeEditingActivity", [change, { epoch: 3, kind: "edit" }]],
    ["createReviewFeedback", [change, feedback]],
    ["updateReviewFeedback", [change, update]],
    ["sendReviewRevision", [change, batch]],
  ] as Array<[string, unknown[]]>)
    expect(await call(name, args)).toMatchObject({ ok: false, status: 503 });
  expect(effects).toEqual([]);
  maintenance = false;
  for (const [name, args] of [
    ["takeOverChangeEditing", [change, { ...editing, actorID: actor }]],
    ["requestChangeEditing", [change, { ...editing, epoch: 0 }]],
    ["approveChangeEditing", [change, editing]],
    ["recordChangeEditingActivity", [change, { epoch: 3, kind: "lease-expiry" }]],
    ["createReviewFeedback", [change, { ...feedback, userID: actor }]],
    ["updateReviewFeedback", [change, { ...update, expectedVersion: 0 }]],
    ["sendReviewRevision", [change, { ...batch, feedback: [] }]],
  ] as Array<[string, unknown[]]>)
    expect(await call(name, args)).toMatchObject({ ok: false, status: 400 });
  expect(effects).toEqual([]);
  expect(
    await call("createReviewFeedback", [change, { ...feedback, body: " ".repeat(32_768) }]),
  ).toMatchObject({ ok: false, status: 409 });
  allowed = false;
  expect(await call("requestChangeEditing", [change, editing])).toMatchObject({
    ok: false,
    status: 404,
  });
  expect(effects).toEqual([]);
  allowed = true;
  await call("getChangeWriterStatus", [change]);
  await call("observeChangeWriter", [change]);
  await call("takeOverChangeEditing", [change, editing]);
  await call("requestChangeEditing", [change, editing]);
  await call("approveChangeEditing", [change, { ...editing, requestID }]);
  await call("takeOverIdleEditing", [change, editing]);
  await call("recordChangeEditingActivity", [change, { epoch: 3, kind: "heartbeat" }]);
  expect(effects).toEqual([
    { method: "status", args: [change, actor] },
    { method: "observe", args: [change, actor] },
    { method: "takeover", args: [change, actor, commandID, undefined, undefined, 3] },
    { method: "request", args: [change, actor, commandID, 3] },
    { method: "approve", args: [change, actor, commandID, requestID, 3] },
    { method: "idle", args: [change, actor, commandID, 3] },
    { method: "activity", args: [change, actor, 3, "heartbeat"] },
  ]);
  const cancelWriter = new AbortController();
  const releasing = endpoint(
    await factoryFunctionRequest(
      origin,
      "releaseChangeEditing",
      [change, editing],
      {},
      cancelWriter.signal,
    ),
  );
  void releasing.catch(() => {});
  await writerAdmitted.promise;
  cancelWriter.abort();
  writerRelease.resolve();
  await releasing.catch(() => undefined);
  expect(effects.at(-1)).toEqual({ method: "release", args: [change, actor, commandID, 3] });
  unconfirmed = true;
  expect(await call("releaseChangeEditing", [change, editing])).toMatchObject({
    ok: false,
    status: 503,
  });
  const previous = effects.length;
  await call("getVisualReview", [change]);
  await call("createReviewFeedback", [change, feedback]);
  await call("updateReviewFeedback", [change, update]);
  expect(effects.slice(previous)).toEqual([
    { method: "review-get", args: [change, actor] },
    { method: "feedback", args: [change, actor, feedback] },
    { method: "update", args: [change, actor, update] },
  ]);
  const cancelReview = new AbortController();
  const sending = endpoint(
    await factoryFunctionRequest(
      origin,
      "sendReviewRevision",
      [change, batch],
      {},
      cancelReview.signal,
    ),
  );
  void sending.catch(() => {});
  await reviewAdmitted.promise;
  cancelReview.abort();
  reviewRelease.resolve();
  await sending.catch(() => undefined);
  expect(effects.slice(-3)).toEqual([
    { method: "send", args: [change, actor, batch] },
    { method: "admit", args: [change, actor, "Frozen correction", commandID] },
    { method: "dispatch", args: [change] },
  ]);
  for (const name of ["getQARecordingSettings", "saveQARecordingSettings"])
    await expect(factoryFunctionRequest(origin, name, [project, false])).rejects.toThrow(
      `Compiled Factory function is missing: ${name}`,
    );
  authenticated = false;
  expect(
    (await endpoint(await factoryFunctionRequest(origin, "getVisualReview", [change]))).status,
  ).toBe(401);
});
