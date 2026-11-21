import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  checkTLC,
  staleFenceGuard,
  staleFenceMutation,
  writerSchedules,
} from "../../scripts/testing/writer-model";

test("Writer pilot generates reproducible acknowledgement/claim orders without Java", () => {
  const schedules = writerSchedules();
  expect(schedules).toEqual(writerSchedules());
  expect(new Set(schedules.map((events) => events.join(","))).size).toBe(schedules.length);
  expect(schedules).toContainEqual(["reclaim", "observe", "ack"]);
  expect(schedules).toContainEqual(["ack", "reclaim", "observe"]);
  expect(schedules).toContainEqual(["observe", "ack"]);
});

test("Writer pilot mutates exactly the marked epoch guard, never its implementation", async () => {
  const source = await readFile(resolve(import.meta.dirname, "../models/writer.tla"), "utf8");
  expect(staleFenceMutation(source)).not.toContain(staleFenceGuard);
  expect(staleFenceMutation(source)).toContain("deliberate stale-fence mutation");
  expect(() => staleFenceMutation("unmarked")).toThrow("exactly one");
  expect(() => staleFenceMutation(`${source}\n${staleFenceGuard}`)).toThrow("exactly one");
});

test("TLC failures, skips and unrelated counterexamples cannot pass the pilot", () => {
  for (const result of [
    { code: 0, stdout: "skipped, Java missing", stderr: "" },
    { code: 1, stdout: "", stderr: "Unable to locate a Java Runtime." },
    { code: 0, stdout: "No error", stderr: "" },
  ]) {
    expect(() => checkTLC(result, false)).toThrow();
    expect(() => checkTLC(result, true)).toThrow();
  }
  const negative = {
    code: 12,
    stdout:
      "Invariant StaleEpochRejected is violated.\nThe behavior up to this point is:\nState 7: <Publish line 1>",
    stderr: "",
  };
  expect(() => checkTLC(negative, true)).not.toThrow();
  expect(() => checkTLC({ ...negative, code: 0 }, true)).toThrow();
  expect(() =>
    checkTLC(
      { ...negative, stdout: negative.stdout.replace("StaleEpochRejected", "TypeOK") },
      true,
    ),
  ).toThrow();
});

// Explicit runner only. Default unit discovery neither imports a controller
// fixture nor starts Java/PostgreSQL. There are no skipped tests counted as proof.
if (process.env["FACTORY_WRITER_MODEL_CHECK"] === "1") {
  test("generated schedules exercise the real Writer controller and native PostgreSQL safeguards", async () => {
    if (!process.env["FACTORY_TEST_POSTGRES"] || !process.env["FACTORY_WRITER_MODEL_EVIDENCE"])
      throw new Error(
        "Writer sequences require the explicit runner's owned database and evidence path",
      );
    const { fixture, buildModelID } = await import("../fixtures/change-agent-turns");
    const { createChangeAdmission } = await import("../../apps/factory/src/agent/change-admission");
    const { claimAgentWriterIn } = await import("../../apps/factory/src/access/change-writer");
    const { createChangeWriterController } = await import(
      "../../apps/factory/src/access/writer-controller"
    );
    const { createChangeAgentStop } = await import("../../apps/factory/src/agent/stop");
    const results: unknown[] = [];
    for (const events of writerSchedules()) {
      const owned = await fixture();
      const ack = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      let waiting = false;
      let work: Promise<{ granted: boolean; error?: string }> | undefined;
      let grants = 0;
      const effects: string[] = [];
      const writers = createChangeWriterController({
        database: owned.database,
        agentUsername: "owned-control",
        stopDeadlineMs: 0,
        runtime: {
          async stop(attemptID) {
            expect(attemptID).toBe(owned.attemptID);
            effects.push("compute-stop");
            if (waiting) {
              entered.resolve();
              await ack.promise;
            }
          },
          async get() {
            return { state: "stopped" };
          },
        },
        async stopAgent() {
          throw new Error("This schedule has no submitted native input");
        },
        async fenceSource(_changeID, epoch) {
          effects.push(`source-fence:${epoch}`);
        },
        async protect(_changeID, users) {
          expect(users.length).toBeLessThanOrEqual(1);
          effects.push(users.length ? `grant:${users[0]}` : "branch-fence");
          if (users.length) grants++;
        },
      });
      try {
        const human = await writers.takeOver(owned.changeID, owned.userID, crypto.randomUUID());
        const admission = createChangeAdmission(owned.database, buildModelID);
        const admitted = await admission.admit(owned.changeID, owned.userID, {
          kind: "change-start",
          commandId: crypto.randomUUID(),
        });
        const read = () => owned.database.client<
          { state: string; epoch: string; fence: boolean }[]
        >`
          SELECT state,epoch::text,fence_required AS fence FROM factory.change_writer WHERE change_id=${owned.changeID}`;
        const [captured] = await read();
        if (!captured) throw new Error("Admitted Writer missing");
        expect(captured).toMatchObject({
          state: "agent-preparing",
          epoch: String(human.epoch + 1),
          fence: true,
        });
        const grantsBefore = grants;
        waiting = true;
        work = writers.prepareAgent(owned.changeID, admitted.turn.id).then(
          (granted) => ({ granted }),
          (cause: unknown) => ({
            granted: false,
            error: cause instanceof Error ? cause.message : String(cause),
          }),
        );
        await Promise.race([
          entered.promise,
          work.then((result) => {
            throw new Error(
              `Writer preparation ended before the Stop seam: ${JSON.stringify(result)}`,
            );
          }),
        ]);
        let reclaimed = false;
        let publication: Awaited<NonNullable<typeof work>> | undefined;
        for (const event of events) {
          if (event === "observe") {
            const before = await read();
            expect((await writers.status(owned.changeID, owned.userID)).canWrite).toBe(false);
            expect(await read()).toEqual(before);
          } else if (event === "reclaim") {
            // An existing production transaction owner advances this same Turn's
            // epoch while external Stop is in flight, not a fake state machine.
            await owned.database.client.begin((sql) =>
              claimAgentWriterIn(sql, owned.changeID, admitted.turn.id, owned.userID),
            );
            reclaimed = true;
          } else {
            ack.resolve();
            publication = await work;
            if (reclaimed) {
              expect(publication).toEqual({
                granted: false,
                error: "Agent writing authority changed during preparation",
              });
              expect(grants).toBe(grantsBefore);
            } else {
              expect(publication).toEqual({ granted: true });
              expect(grants).toBe(grantsBefore + 1);
            }
          }
        }
        waiting = false;
        expect(publication).toBeDefined();
        if (reclaimed) {
          expect((await read())[0]).toMatchObject({
            state: "agent-preparing",
            epoch: String(Number(captured.epoch) + 1),
          });
          // A new call to the real controller captures the current epoch.
          expect(await writers.prepareAgent(owned.changeID, admitted.turn.id)).toBe(true);
        }
        expect((await read())[0]).toMatchObject({ state: "agent", fence: false });
        expect(effects.indexOf(`source-fence:${captured.epoch}`)).toBeLessThan(
          effects.indexOf("branch-fence", effects.indexOf(`source-fence:${captured.epoch}`)),
        );
        await expect(
          writers.activity(owned.changeID, owned.userID, human.epoch, "edit"),
        ).rejects.toThrow("Editing context changed");
        expect(owned.requests()).toBe(0);
        results.push({
          events,
          capturedEpoch: captured.epoch,
          publication,
          effects,
          final: (await read())[0],
        });
      } finally {
        ack.resolve();
        await work;
        await owned.dispose();
      }
    }

    // Exercise the model's separate input/compute facts through the existing
    // Stop owner. A confirmed cold suspension still retains assigned input.
    const owned = await fixture();
    try {
      const admission = createChangeAdmission(owned.database, buildModelID);
      const admitted = await admission.admit(owned.changeID, owned.userID, {
        kind: "change-prompt",
        commandId: crypto.randomUUID(),
        text: "Owned Stop boundary",
      });
      await owned.database
        .client`UPDATE factory.change_agent_turn_intent SET runtime_attempt_id=${owned.attemptID} WHERE turn_id=${admitted.turn.id}`;
      await owned.database
        .client`UPDATE factory.change_agent_session SET state='working',active_turn_id=${admitted.turn.id} WHERE change_id=${owned.changeID}`;
      await owned.database
        .client`UPDATE factory.runtime_attempt SET state='paused' WHERE id=${owned.attemptID}`;
      const stop = createChangeAgentStop(owned.database, owned.hub, async () => {
        throw new Error("The assigned input has no retained settlement proof");
      });
      await stop.persist(owned.changeID);
      const [target] = await owned.database.client<{ id: string }[]>`
        SELECT stop_id AS id FROM factory.change_agent_session WHERE change_id=${owned.changeID}`;
      if (!target) throw new Error("Retained Stop target missing");
      for (const mode of ["observe", "interrupt"] as const)
        expect(await stop.confirm(owned.changeID, target.id, mode)).toBe(false);
      let granted = false;
      const writers = createChangeWriterController({
        database: owned.database,
        agentUsername: "owned-control",
        runtime: {
          stop: async () => {},
          get: async () => ({
            state: "paused",
            native: {
              engine: "substrate",
              state: "ACTOR_STATE_SUSPENDED",
              coldRestart: true,
              portable: false,
              sourceHandoff: "confirmed-same-node",
            },
          }),
        },
        stopAgent: async () => {
          expect(await stop.confirm(owned.changeID, target.id)).toBe(false);
        },
        protect: async (_changeID, users) => {
          granted ||= users.length > 0;
        },
      });
      await expect(
        writers.takeOver(owned.changeID, owned.userID, crypto.randomUUID()),
      ).rejects.toThrow("confirmed Agent Stop");
      expect(granted).toBe(false);
      expect(await writers.status(owned.changeID, owned.userID)).toMatchObject({
        state: "handoff",
        stopPending: true,
        canWrite: false,
      });

      // Native guards are active, never disabled for these rejection checks.
      const verification = crypto.randomUUID(),
        review = crypto.randomUUID(),
        approval = crypto.randomUUID();
      const commit = "d".repeat(40),
        otherCommit = "e".repeat(40);
      await owned.database
        .client`INSERT INTO factory.verification(id,change_id,commit_sha,pull_request_number,runner_name,created_by)
        VALUES(${verification},${owned.changeID},${commit},1,'owned-formal',${owned.userID})`;
      await owned.database
        .client`INSERT INTO factory.candidate_review(id,verification_id,change_id,commit_sha,base_sha,created_by)
        VALUES(${review},${verification},${owned.changeID},${commit},${"a".repeat(40)},${owned.userID})`;
      await owned.database
        .client`INSERT INTO factory.delivery_approval(id,change_id,verification_id,commit_sha,candidate_review_id,approved_by)
        VALUES(${approval},${owned.changeID},${verification},${commit},${review},${owned.userID})`;
      const rejected: { name: string; expectedError: string }[] = [];
      const reject = async (
        name: string,
        mutation: PromiseLike<unknown>,
        expectedError: string,
      ) => {
        await expect(Promise.resolve(mutation)).rejects.toThrow(expectedError);
        rejected.push({ name, expectedError });
      };
      await reject(
        "candidate-commit",
        owned.database
          .client`UPDATE factory.candidate_review SET commit_sha=${otherCommit} WHERE id=${review}`,
        "Candidate review intent and confirmed outcome are immutable",
      );
      await reject(
        "delivery-approval",
        owned.database
          .client`UPDATE factory.delivery_approval SET commit_sha=${otherCommit} WHERE id=${approval}`,
        "delivery_approval is immutable",
      );
      await reject(
        "requirement-approval",
        owned.database
          .client`UPDATE factory.requirement_approval SET approved_at=approved_at+interval '1 second' WHERE requirement_revision_id=${owned.revisionID}`,
        "requirement_approval is immutable",
      );
      await reject(
        "change-approved-basis",
        owned.database
          .client`UPDATE factory.change SET requirement_approval_id=${crypto.randomUUID()} WHERE id=${owned.changeID}`,
        "Change identity and source intent are immutable",
      );
      const [decision] = await owned.database.client<
        { id: string }[]
      >`SELECT command_id AS id FROM factory.change_editing_decision WHERE change_id=${owned.changeID} LIMIT 1`;
      if (!decision) throw new Error("Writer's retained human decision missing");
      await reject(
        "editing-decision",
        owned.database
          .client`UPDATE factory.change_editing_decision SET writer_epoch=writer_epoch+1 WHERE command_id=${decision.id}`,
        "change_editing_decision is immutable",
      );
      const otherVerification = crypto.randomUUID();
      await owned.database
        .client`INSERT INTO factory.verification(id,change_id,commit_sha,pull_request_number,runner_name,created_by,state,completed_at)
        VALUES(${otherVerification},${owned.changeID},${otherCommit},1,'owned-formal',${owned.userID},'cancelled',now())`;
      await reject(
        "approval-exact-commit",
        owned.database
          .client`INSERT INTO factory.delivery_approval(id,change_id,verification_id,commit_sha,candidate_review_id,approved_by)
        VALUES(${crypto.randomUUID()},${owned.changeID},${otherVerification},${otherCommit},${review},${owned.userID})`,
        "delivery_approval_candidate_review_identity",
      );
      expect(
        (
          await owned.database
            .client`SELECT commit_sha FROM factory.candidate_review WHERE id=${review}`
        )[0]?.["commit_sha"],
      ).toBe(commit);
      expect(owned.requests()).toBe(0);
      await writeFile(
        process.env["FACTORY_WRITER_MODEL_EVIDENCE"],
        `${JSON.stringify(
          {
            status: "passed",
            schedules: results,
            stop: { assignedInputOnPausedCompute: "unconfirmed", humanGrant: granted },
            nativeGuards: rejected,
            scope:
              "Real Writer/Stop controllers and sealed PostgreSQL fixture; Source, branch and runtime acknowledgements are controlled. No live native acceptance or Delivery admission.",
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      await owned.dispose();
    }
  }, 60_000);
}
