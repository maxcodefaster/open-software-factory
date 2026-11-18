import { afterAll, beforeAll, expect, test } from "bun:test";
import { RuntimeParentOperationError } from "../../apps/factory/src/runtime/hub";
import { createDatabase } from "../../packages/db/src/client";
import { fixture } from "../fixtures/change-agent-turns";
import { eventually } from "../fixtures/factory-process";
import {
  ownedPostgresServer,
  ownedTestDatabase,
  type PostgresIdentity,
} from "../fixtures/postgres-server";

let databaseURL: string;
let disposeDatabase: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const supplied = process.env["FACTORY_TEST_POSTGRES"];
  if (supplied) {
    const database = await ownedTestDatabase(
      JSON.parse(supplied) as PostgresIdentity,
      crypto.randomUUID(),
    );
    databaseURL = database.url;
    disposeDatabase = database.dispose;
  } else {
    const server = await ownedPostgresServer();
    databaseURL = server.identity.url;
    disposeDatabase = server.dispose;
  }
}, 60_000);

afterAll(async () => {
  await disposeDatabase?.();
}, 60_000);

async function ownedBuild() {
  const previousURL = process.env["DATABASE_URL"];
  try {
    process.env["DATABASE_URL"] = databaseURL;
    return await fixture(undefined, undefined, createDatabase(3));
  } finally {
    if (previousURL === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = previousURL;
  }
}

for (const previousSubmission of [false, true]) {
  test(`a native read-only turn reports no submission with ${previousSubmission ? "an earlier submission" : "no earlier submission"}`, async () => {
    const owned = await ownedBuild();
    const controller = owned.controller();
    const prepareEntered = Promise.withResolvers<void>();
    const prepareResult = Promise.withResolvers<void>();
    const actions: string[] = [];
    let earlierTurnID: string | undefined;
    let earlierSummary: string | null | undefined;
    try {
      if (previousSubmission) {
        const earlier = await controller.prompt(
          owned.changeID,
          "Implement the approved change",
          owned.userID,
          crypto.randomUUID(),
        );
        earlierTurnID = earlier.turn?.id;
        await owned.requested;
        owned.finish("Implemented the approved change and ran its checks.");
        owned.release();
        const submitted = await eventually(
          () => controller.get(owned.changeID),
          (view) => view.state === "committed",
          "Earlier submission did not settle",
        );
        earlierSummary = submitted.turn?.summary;
        await owned.nextInput();
      }
      const retained = await owned.database.client`
        SELECT row_to_json(operation) AS operation FROM factory.change_commit_operation operation
        WHERE operation.change_id=${owned.changeID} ORDER BY operation.sequence`;
      const retainedTurns = await owned.database.client`
        SELECT row_to_json(turn) AS turn FROM factory.agent_turn turn
        WHERE turn.change_id=${owned.changeID} ORDER BY turn.id`;
      expect(retained).toHaveLength(previousSubmission ? 1 : 0);
      const parentOperation = owned.hub.parentOperation.bind(owned.hub);
      owned.hub.parentOperation = async (attempt, operation, beforeSend) => {
        if (operation.action !== "git-prepare-commit")
          return parentOperation(attempt, operation, beforeSend);
        let sent = !beforeSend;
        await beforeSend?.(() => {
          sent = true;
        });
        if (!sent) throw new Error("Owned commit frame was not admitted");
        expect(attempt).toBe(owned.attemptID);
        actions.push(operation.action);
        prepareEntered.resolve();
        await prepareResult.promise;
        throw new RuntimeParentOperationError(
          "git-prepare-commit",
          "workspace has no changes to commit",
        );
      };
      const commandID = crypto.randomUUID();
      const accepted = await controller.prompt(
        owned.changeID,
        "Read the repository and report its current state. Do not change files.",
        owned.userID,
        commandID,
      );
      await owned.requested;
      owned.finish("Inspected the repository. No files were changed.");
      owned.release();
      await prepareEntered.promise;
      const pending = await controller.get(owned.changeID);
      expect(pending.turn?.state).toBe("completed");
      expect(pending.commitOperation?.state).toBe("commit-intended");
      const prematureSummary = pending.turn?.summary;
      const terminal = await owned.turn(commandID);
      const writer = await owned.database.client`
        SELECT row_to_json(writer) AS writer FROM factory.change_writer writer
        WHERE writer.change_id=${owned.changeID}`;
      prepareResult.resolve();
      const view = await eventually(
        () => controller.get(owned.changeID),
        (current) => !current.commitOperation,
        "Read-only turn did not settle its empty commit result",
      );
      await controller.shutdown();
      const diagnostic =
        "This turn changed no files, so there is nothing new to submit." +
        (previousSubmission ? " The earlier submission is unchanged." : "");
      expect(view.state).toBe("waiting");
      const stored = await owned.turn(commandID);
      expect({
        lastError: view.lastError,
        summary: view.turn?.summary,
      }).toEqual({ lastError: diagnostic, summary: diagnostic });
      expect(stored).toEqual(terminal);
      expect(stored?.summary).toBe(prematureSummary ?? null);
      expect((await controller.get(owned.changeID, undefined, false)).turn?.summary).toBe(
        diagnostic,
      );
      if (earlierTurnID)
        expect((await controller.get(owned.changeID, earlierTurnID)).turn?.summary).toBe(
          earlierSummary ?? null,
        );
      expect(view.turn).toMatchObject({
        id: accepted.turn?.id,
        state: "completed",
        summary: diagnostic,
      });
      expect(prematureSummary).not.toContain("Changed source is submitted");
      expect(prematureSummary).not.toContain("ready for Verification");
      const [operation] = await owned.database.client`
        SELECT state,commit_sha AS sha,last_error AS error FROM factory.change_commit_operation
        WHERE id=${accepted.turn?.id ?? ""}`;
      expect(operation).toEqual({ state: "failed", sha: null, error: diagnostic });
      expect(
        await owned.database.client`
          SELECT row_to_json(operation) AS operation FROM factory.change_commit_operation operation
          WHERE operation.change_id=${owned.changeID} AND operation.id<>${accepted.turn?.id ?? ""}
          ORDER BY operation.sequence`,
      ).toEqual(retained);
      expect(
        await owned.database.client`
          SELECT row_to_json(turn) AS turn FROM factory.agent_turn turn
          WHERE turn.change_id=${owned.changeID} AND turn.id<>${accepted.turn?.id ?? ""}
          ORDER BY turn.id`,
      ).toEqual(retainedTurns);
      expect(
        await owned.database.client`
          SELECT row_to_json(writer) AS writer FROM factory.change_writer writer
          WHERE writer.change_id=${owned.changeID}`,
      ).toEqual(writer);
      expect(
        await owned.database.client`
          SELECT id FROM factory.verification WHERE change_id=${owned.changeID}`,
      ).toHaveLength(0);
      expect(
        await owned.database.client`
          SELECT id FROM factory.candidate_review WHERE change_id=${owned.changeID}`,
      ).toHaveLength(0);
      expect(actions).toEqual(["git-prepare-commit"]);
      expect(owned.requests()).toBe(previousSubmission ? 2 : 1);
      expect(owned.interrupts()).toBe(0);
    } finally {
      prepareResult.resolve();
      await controller.shutdown();
      await owned.dispose();
    }
  });
}
