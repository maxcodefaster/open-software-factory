import { describe, expect, test } from "bun:test";
import type { createDatabase } from "../../../../packages/db/src/client";
import type { createForgejoClient } from "../../../../packages/forge/src/forge";
import { createDeliveryController } from "./controller";

function fixture(delivered = false, repair = false) {
  const baseSHA = "a".repeat(40);
  const commitSHA = "b".repeat(40);
  let state = delivered ? "delivered" : "active";
  let mergeState = "ambiguous";
  let cleanupError: string | null = "Delivery cleanup pending";
  let mergeCalls = 0;
  let stopCalls = 0;
  let failStop = false;
  let defaultHead = commitSHA;
  let failMergePersistence = false;
  let sessionState = "committed";
  let rejectPrompt = false;
  let promptCalls = 0;
  let repairAcknowledged = false;
  const verificationID = crypto.randomUUID();
  const repairCommands: Array<{ id: string; repair: boolean | undefined }> = [];
  const client = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("AS active")) return [{ active: state === "active" }];
      if (query.includes("ticket.title, ticket.description"))
        return [
          {
            id: "change",
            projectID: "project",
            ticketID: "ticket",
            title: "Ticket",
            description: "",
            branchName: "factory/change",
            baseSHA,
            state,
            userID: "user",
            repositoryURL: "http://forge/factory/repo.git",
            defaultBranch: "main",
            commitSHA,
            runtimeAttemptID: "ticket-runtime",
          },
        ];
      if (query.includes("FROM factory.pull_request_operation WHERE"))
        return [{ id: "pr", state: "succeeded", number: "1", url: "http://forge/pr/1" }];
      if (query.includes("FROM factory.merge_operation merge"))
        return [{ id: "merge", state: mergeState, commitSHA, baseSHA, pullRequestNumber: "1" }];
      if (query.includes("SELECT EXISTS(")) return [{ exists: !repair }];
      if (query.includes("FROM factory.verification verification"))
        return [
          {
            id: verificationID,
            state: "failed",
            actionRunID: "1",
            repairPromptedAt: repairAcknowledged ? "now" : null,
          },
        ];
      if (query.includes("SELECT state FROM factory.change_agent_session"))
        return [{ state: sessionState }];
      if (query.includes("SELECT COUNT(*)::integer AS count FROM factory.verification"))
        return [{ count: 0 }];
      if (query.includes("UPDATE factory.verification SET repair_prompted_at = now()"))
        repairAcknowledged = true;
      if (query.includes("FROM factory.promotion_operation promotion"))
        return state === "delivered"
          ? [
              {
                id: "promotion",
                state: "succeeded",
                lastError: cleanupError,
                previousAttemptID: "old-staging",
                replacementAttemptID: "new-staging",
                replacementState: "ready",
                commitSHA,
              },
            ]
          : [];
      if (query.includes("UPDATE factory.merge_operation SET state = 'succeeded'")) {
        if (failMergePersistence) {
          failMergePersistence = false;
          throw new Error("database write lost after merge");
        }
        mergeState = "succeeded";
      }
      if (query.includes("Delivery gate moved before merge")) mergeState = "failed";
      if (query.includes("UPDATE factory.change SET state = 'delivering'")) state = "delivering";
      if (query.includes("UPDATE factory.promotion_operation SET last_error = NULL"))
        cleanupError = null;
      else if (query.includes("UPDATE factory.promotion_operation SET last_error ="))
        cleanupError = String(values[0]);
      return [];
    },
    { begin: async <T>(operation: (sql: unknown) => Promise<T>) => operation(client) },
  );
  const forge = {
    getPullRequest: async () => ({ number: 1, headSha: commitSHA, merged: !repair }),
    listActionRuns: async () => [
      {
        id: 1,
        workflowID: "factory-verification.yml",
        event: "pull_request",
        status: "failure",
        url: "http://forge/runs/1",
      },
    ],
    getDefaultBranch: async () => ({ headSha: defaultHead }),
    mergeFastForward: async () => {
      mergeCalls += 1;
      defaultHead = commitSHA;
      return { headSha: commitSHA };
    },
    deleteBranch: async () => {},
  } as unknown as ReturnType<typeof createForgejoClient>;
  const runtime = {
    startVerification: async () => null,
    startStagingReplacement: async () => null,
    stop: async () => {
      stopCalls += 1;
      if (failStop) throw new Error("stop failed");
      return null;
    },
  };
  const controller = createDeliveryController(
    { client } as unknown as ReturnType<typeof createDatabase>,
    runtime,
    {
      prompt: async (_changeID, _text, _userID, commandID, repair) => {
        repairCommands.push({ id: commandID, repair });
        promptCalls += 1;
        if (rejectPrompt) throw new Error("Prompt not sent");
      },
    },
    { client: forge, owner: "factory" },
  );
  return {
    controller,
    mergeState: () => mergeState,
    mergeCalls: () => mergeCalls,
    cleanupError: () => cleanupError,
    stopCalls: () => stopCalls,
    failStop: (value: boolean) => {
      failStop = value;
    },
    setDefaultHead: (value: string) => {
      defaultHead = value;
    },
    failPersistenceOnce: () => {
      failMergePersistence = true;
    },
    promptCalls: () => promptCalls,
    repairCommands,
    verificationID,
    repairAcknowledged: () => repairAcknowledged,
    setSessionState: (value: string) => {
      sessionState = value;
    },
    rejectPrompt: (value: boolean) => {
      rejectPrompt = value;
    },
  };
}

describe("Delivery recovery", () => {
  test("does not acknowledge or dispatch automatic repair after Stop", async () => {
    const f = fixture(false, true);
    f.setSessionState("stopped");
    await f.controller.reconcile("change");
    expect(f.promptCalls()).toBe(0);
    expect(f.repairAcknowledged()).toBe(false);
  });

  test("acknowledges repair only after the Agent accepts the prompt", async () => {
    const f = fixture(false, true);
    f.rejectPrompt(true);
    await f.controller.reconcile("change");
    expect(f.promptCalls()).toBe(1);
    expect(f.repairAcknowledged()).toBe(false);
    f.rejectPrompt(false);
    await f.controller.reconcile("change");
    expect(f.promptCalls()).toBe(2);
    expect(f.repairCommands).toEqual([
      { id: f.verificationID, repair: true },
      { id: f.verificationID, repair: true },
    ]);
    expect(f.repairAcknowledged()).toBe(true);
    await f.controller.reconcile("change");
    expect(f.promptCalls()).toBe(2);
  });

  test("recovers external merge success after its database write fails", async () => {
    const f = fixture();
    f.setDefaultHead("a".repeat(40));
    f.failPersistenceOnce();
    await f.controller.reconcile("change");
    expect(f.mergeState()).not.toBe("succeeded");
    await f.controller.reconcile("change");
    expect(f.mergeState()).toBe("succeeded");
    expect(f.mergeCalls()).toBe(1);
  });

  test("does not mistake unrelated default-branch movement for a successful merge", async () => {
    const f = fixture();
    f.setDefaultHead("c".repeat(40));
    await f.controller.reconcile("change");
    expect(f.mergeState()).toBe("failed");
    expect(f.mergeCalls()).toBe(0);
  });
  test("recovers the exact merge when default already points to the approved commit", async () => {
    const f = fixture();
    await f.controller.reconcile("change");
    expect(f.mergeCalls()).toBe(0);
    expect(f.mergeState()).toBe("succeeded");
  });

  test("retries delivered cleanup after failure and stops retrying after intent is dispatched", async () => {
    const f = fixture(true);
    f.failStop(true);
    await f.controller.reconcile("change");
    expect(f.cleanupError()).toBe("stop failed");
    f.failStop(false);
    await f.controller.reconcile("change");
    expect(f.cleanupError()).toBeNull();
    const stopped = f.stopCalls();
    await f.controller.reconcile("change");
    expect(f.stopCalls()).toBe(stopped);
  });
});
