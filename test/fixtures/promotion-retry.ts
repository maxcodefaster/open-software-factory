import { mock } from "bun:test";
import { strict as assert } from "node:assert";
import { createAgentCommandIds } from "../../apps/factory/src/agent-command-ids";
import { deliveryViewSchema } from "../../apps/factory/src/api-contracts";

// Separate process: replacements never affect another test or a running Factory.
const scenario = process.argv[2] ?? "failed";
const changeID = crypto.randomUUID();
const projectID = crypto.randomUUID();
const implementationID = crypto.randomUUID();
const replacementID = crypto.randomUUID();
const promotionID = crypto.randomUUID();
const scope = `retry-promotion:${changeID}`;
const stored = new Map<string, string>();
const ids = createAgentCommandIds({
  userId: "isolated-promotion-retry",
  storage: {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => void stored.set(key, value),
    removeItem: (key) => void stored.delete(key),
  },
});
const events: string[] = [];
const errors: string[] = [];
const acknowledgements: string[] = [];
const publications: unknown[] = [];
let selected = scenario === "another-ticket" ? crypto.randomUUID() : changeID;
let stops = 0;
const state = ["ready", "starting", "stopped", "cleanup-failed"].includes(scenario)
  ? scenario
  : "failed";
const delivery = deliveryViewSchema.parse({
  openReviewThreads: 0,
  mergeState: "succeeded",
  promotionState: "failed",
  promotionId: promotionID,
  replacementRuntimeAttemptId: replacementID,
  replacementRuntimeState: state,
});
const unused = () => {
  throw new Error("Uncommissioned command");
};
mock.module("../../apps/factory/src/server-functions/conversations", () => ({
  confirmEpicProposal: unused,
}));
mock.module("../../apps/factory/src/server-functions/tickets", () => ({
  createTicketFollowUp: unused,
  getTicketDetail: unused,
  implementTicket: unused,
  restoreTicket: unused,
  saveTicketDocument: unused,
  saveTicketTechnicalDesign: unused,
  trashTicket: unused,
}));
mock.module("../../apps/factory/src/server-functions/runtime", () => ({
  stopRuntimeAttempt: async ({ data }: { data: [string] }) => {
    assert.deepEqual(data, [replacementID]);
    assert.notEqual(data[0], implementationID);
    assert(ids.latest(scope), "Retain the deliberate retry identity before cleanup");
    events.push("stop");
    stops++;
    if (scenario === "cleanup-retry" && stops === 1)
      return { ok: false, status: 503, message: "Owned cleanup remains unconfirmed" };
    if (scenario === "switch-ticket") selected = crypto.randomUUID();
    return {
      ok: true,
      value: { id: replacementID, projectId: projectID, runtimeKind: "staging", state: "stopped" },
    };
  },
}));
mock.module("../../apps/factory/src/server-functions/delivery", () => ({
  approveDelivery: unused,
  resumeVerification: unused,
  retryCandidateReview: unused,
  retryStagingPromotion: async ({
    data: [id, input],
  }: {
    data: [string, { commandId: string; promotionId: string }];
  }) => {
    events.push("retry");
    assert.equal(id, changeID);
    assert.equal(input.promotionId, promotionID);
    assert.equal(input.commandId, ids.latest(scope)?.commandId);
    if (state === "ready" || state === "starting")
      return { ok: false, status: 409, message: "Replacement is not eligible for cleanup" };
    assert(stops > 0, "A fresh Preview cannot precede cleanup of its failed predecessor");
    return { ok: true, value: { ...delivery, promotionState: "starting" } };
  },
}));
const { createTicketCommands } = await import("../../apps/factory/src/desktop/ticket-commands");
const dependencies = {
  selectedChange: () => ({ id: selected, runtimeAttemptId: implementationID }),
  delivery: () => delivery,
  agentCommandScope: () => scope,
  agentCommandIds: ids,
  acknowledgeCommand: (key: string, command: string) => {
    assert.equal(key, scope);
    acknowledgements.push(command);
    ids.forget(key, command);
  },
  setDelivery: (value: unknown) => void publications.push(value),
  refreshLifecycleState: async () => void events.push("refresh"),
  mutate: async (operation: () => Promise<unknown>) => {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      return { ok: false };
    }
  },
};
const commands = createTicketCommands(
  new Proxy(dependencies, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      throw new Error(`Unexpected dependency ${String(key)}`);
    },
  }) as unknown as Parameters<typeof createTicketCommands>[0],
);
await commands.retryPromotion(changeID);
if (scenario === "another-ticket") {
  assert.deepEqual(events, []);
  assert.equal(acknowledgements.length, 0);
} else if (state === "ready" || state === "starting") {
  assert.deepEqual(events, ["retry"]);
  assert.equal(acknowledgements.length, 0);
  assert.equal(publications.length, 0);
} else {
  if (scenario === "cleanup-retry") {
    assert.deepEqual(events, ["stop"]);
    assert.equal(acknowledgements.length, 0);
    assert.equal(publications.length, 0);
    const original = ids.latest(scope)?.commandId;
    assert(original);
    await commands.retryPromotion(changeID);
    assert.deepEqual(acknowledgements, [original]);
    assert.deepEqual(events, ["stop", "stop", "retry", "refresh"]);
  } else {
    assert.deepEqual(events, ["stop", "retry", "refresh"]);
    assert.equal(acknowledgements.length, 1);
  }
  assert.equal(publications.length, scenario === "switch-ticket" ? 0 : 1);
  assert.equal(ids.latest(scope), undefined);
}
assert.equal(
  errors.length,
  scenario === "cleanup-retry" || state === "ready" || state === "starting" ? 1 : 0,
);
console.log(`PASS promotion-retry ${scenario}`);
