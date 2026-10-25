import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { createAgentCommitTransport } from "../../apps/factory/src/agent/commit-transport";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import { RuntimeHub, type RuntimeSocketData } from "../../apps/factory/src/runtime/hub";
import { canonicalRequirementContent } from "../../packages/requirement-domain/src/requirement";
import { fixture } from "../fixtures/change-agent-turns";

async function forwarding(connections?: number) {
  const owned = await fixture();
  const entered = Promise.withResolvers<Record<string, string>>();
  const release = Promise.withResolvers<void>();
  owned.hub.parentOperation = async (_attempt, operation) => {
    expect(Object.values(operation).every((value) => typeof value === "string")).toBe(true);
    entered.resolve(
      Object.fromEntries(Object.entries(operation).map(([key, value]) => [key, String(value)])),
    );
    await release.promise;
    throw new Error("Owned unsent fixture commit released for cleanup");
  };
  const controller = owned.controller();
  await controller.prompt(
    owned.changeID,
    "Owned parent frame authority",
    owned.userID,
    crypto.randomUUID(),
  );
  await owned.requested;
  owned.finish();
  owned.release();
  const input = await entered.promise;
  if (!input["operationId"]) throw new Error("Owned persisted commit identity required");
  const operation = {
    ...input,
    operationId: input["operationId"],
    action: "git-prepare-commit" as const,
    expectedSha: "a".repeat(40),
  };
  const database = connections ? owned.connect(connections) : owned.database;
  const hub = new RuntimeHub(async () => {});
  const frames: Record<string, string>[] = [];
  const parent = {
    data: { kind: "connector", role: "parent", attemptID: owned.attemptID, generation: 1 },
    close() {},
    send(raw: string) {
      frames.push(JSON.parse(raw) as Record<string, string>);
      return 1;
    },
  } as unknown as ServerWebSocket<RuntimeSocketData>;
  hub.open(parent);
  return {
    owned,
    database,
    operation,
    frames,
    hub,
    transport: createAgentCommitTransport(database, hub),
    respond() {
      hub.message(
        parent,
        JSON.stringify({
          type: "operation-response",
          operationId: operation.operationId,
          action: operation.action,
          commitSha: "d".repeat(40),
        }),
      );
    },
    async dispose() {
      hub.revoke(owned.attemptID);
      release.resolve();
      await controller.shutdown();
      if (database !== owned.database) await database.client.end();
      await owned.dispose();
    },
  };
}

test("push rejects a destination outside the exact Project before sending a parent frame", async () => {
  const scope = await forwarding();
  try {
    const sha = "d".repeat(40);
    await scope.database
      .client`UPDATE factory.change_commit_operation SET state='push-intended',commit_sha=${sha} WHERE id=${scope.operation.operationId}`;
    const push = {
      ...scope.operation,
      action: "git-push" as const,
      branch: `factory/change-${scope.owned.projectID.replaceAll("-", "").slice(0, 12)}`,
      commitSha: sha,
      repositoryURL: "https://other.invalid/foreign.git",
    };
    await expect(scope.transport(scope.owned.attemptID, push)).rejects.toThrow("push destination");
    expect(scope.frames).toHaveLength(0);
  } finally {
    await scope.dispose();
  }
});

test.each([
  "Stop",
  "Requirements",
  "mode",
  "generation",
  "Session",
  "operation",
  "runtime",
] as const)("the actual parent frame rejects changed %s authority", async (boundary) => {
  const scope = await forwarding();
  try {
    const { owned } = scope;
    if (boundary === "Stop")
      await createChangeAgentStop(owned.database, owned.hub).persist(owned.changeID);
    if (boundary === "Requirements") {
      const content = canonicalRequirementContent({
        summary: "Unapproved new revision",
        acceptanceCriteria: ["Needs exact approval"],
        nonGoals: [],
      });
      await owned.database
        .client`INSERT INTO factory.requirement_revision(id, ticket_id, ordinal, canonical_content, content_digest, created_by)
          VALUES (${crypto.randomUUID()}, ${owned.ticketID}, 2, ${content}, ${createHash("sha256").update(content).digest("hex")}, ${owned.userID})`;
    }
    if (boundary === "mode")
      await owned.database
        .client`UPDATE factory.ticket_conversation SET mode='plan',version=version+1
        WHERE project_id=${owned.projectID} AND ticket_id=${owned.ticketID}`;
    if (boundary === "generation")
      await owned.database
        .client`UPDATE factory.change SET runtime_attempt_id = NULL WHERE id = ${owned.changeID}`;
    if (boundary === "Session")
      await owned.database
        .client`UPDATE factory.change_agent_session SET opencode_session_id = 'ses_replacement' WHERE change_id = ${owned.changeID}`;
    if (boundary === "operation")
      await owned.database
        .client`UPDATE factory.change_commit_operation SET state = 'failed', completed_at = now() WHERE id = ${scope.operation.operationId}`;
    if (boundary === "runtime")
      await owned.database
        .client`UPDATE factory.runtime_attempt SET state = 'starting' WHERE id = ${owned.attemptID}`;
    await expect(scope.transport(owned.attemptID, scope.operation)).rejects.toThrow(
      "authority changed before dispatch",
    );
    expect(scope.frames).toHaveLength(0);
    expect(owned.requests()).toBe(1);
  } finally {
    await scope.dispose();
  }
});

test("a sent prepare releases the only SQL connection before the parent response", async () => {
  const scope = await forwarding(1);
  const response = scope.transport(scope.owned.attemptID, scope.operation);
  try {
    for (let observation = 0; !scope.frames.length && observation < 50; observation += 1)
      await Bun.sleep(10);
    expect(scope.frames[0]?.["action"]).toBe("git-prepare-commit");
    const stopping = createChangeAgentStop(scope.database, scope.owned.hub).persist(
      scope.owned.changeID,
    );
    expect(
      await Promise.race([stopping.then(() => "persisted"), Bun.sleep(500).then(() => "hung")]),
    ).toBe("persisted");
    scope.respond();
    expect(await response).toEqual({ commitSHA: "d".repeat(40) });
    await stopping;
  } finally {
    scope.hub.revoke(scope.owned.attemptID);
    await response.catch(() => undefined);
    await scope.dispose();
  }
});
