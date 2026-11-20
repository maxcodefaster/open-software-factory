import { expect, test } from "bun:test";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import { createTicketTrashController } from "../../apps/factory/src/change/trash";
import { createDeliveryController } from "../../apps/factory/src/delivery/controller";
import { substrateVerificationAuthorityIn } from "../../apps/factory/src/runtime/substrate-verification-grant";
import { createForgejoClient } from "../../packages/forge/src/forge";
import { fixture } from "../fixtures/change-agent-turns";
import { eventually } from "../fixtures/factory-process";
import { nativeRuntimeFixture } from "../fixtures/native-runtime";

test.each([
  ...[
    { boundary: "workflow", failedRevocation: false },
    { boundary: "action run", failedRevocation: false },
    { boundary: "runner registration", failedRevocation: false },
    { boundary: "runner registration", failedRevocation: true },
  ].map((item) => ({ ...item, trash: false })),
  ...["workflow", "action run", "runner registration"].map((boundary) => ({
    boundary,
    failedRevocation: false,
    trash: true,
  })),
])(
  "cancellation during $boundary, failed revocation=$failedRevocation, trash=$trash",
  async ({ boundary, failedRevocation, trash }) => {
    const owned = await nativeRuntimeFixture("ticket");
    const database = owned.database;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let held = false;
    const hold = async (at: typeof boundary) => {
      if (boundary !== at || held) return;
      held = true;
      entered.resolve();
      await release.promise;
    };
    let starts = 0;
    let registrations = 0;
    const removed: number[] = [];
    const stopped: string[] = [];
    let reconciliation: Promise<void> | undefined;
    let trashController: ReturnType<typeof createTicketTrashController> | undefined;
    try {
      const other = await fixture(undefined, undefined, database);
      const native = owned.controller();
      const coding = await native.startPersisted(owned.changeID, owned.userID);
      const personal = await native.start(owned.projectID, owned.userID);
      const staging = await native.ensureStaging(owned.projectID, owned.userID);
      if (!coding || !personal || !staging)
        throw Error("Owned native cancellation controls missing");
      const personalAttemptID = personal.id;
      const stagingAttemptID = staging.id;
      await database.client`UPDATE factory.runtime_attempt SET state='ready'
        WHERE id IN (${coding.id},${personalAttemptID},${stagingAttemptID})`;
      await database.client`UPDATE factory.change SET state='active' WHERE id=${owned.changeID}`;
      await database.client`INSERT INTO factory.change_agent_session(
        change_id,runtime_attempt_id,opencode_session_id,state,native_session_confirmed_at,created_by)
        VALUES(${owned.changeID},${coding.id},'ses_owned_cancellation','committed',now(),${owned.userID})`;
      const commitSHA = "d".repeat(40);
      await database.client`INSERT INTO factory.change_commit_operation(
        id, change_id, runtime_attempt_id, sequence, branch_name, expected_parent_sha,
        commit_sha, observed_remote_sha, commit_message, idempotency_key, state, created_by, completed_at)
        SELECT ${crypto.randomUUID()}, id, runtime_attempt_id, 1, branch_name, base_sha,
          ${commitSHA}, ${commitSHA}, 'Owned cancellation regression', ${crypto.randomUUID()},
          'succeeded', created_by, now() FROM factory.change WHERE id = ${owned.changeID}`;
      await database.client`INSERT INTO factory.pull_request_operation(
        id, change_id, repository_owner, repository_name, base_branch, head_branch,
        first_head_sha, title, body, idempotency_key, state, pull_request_number, pull_request_url, completed_at)
        SELECT ${crypto.randomUUID()}, id, 'owned', 'build', 'main', branch_name, ${commitSHA},
          'Owned', '', ${crypto.randomUUID()}, 'succeeded', 1, 'http://forge.invalid/pr/1', now()
        FROM factory.change WHERE id = ${owned.changeID}`;
      await database.client`UPDATE factory.project SET repository_url = 'http://forge.invalid/owned/build.git'
        WHERE id = ${owned.projectID}`;
      let rejectedRevocations = 0;
      const forge = {
        ...createForgejoClient({ apiURL: "http://127.0.0.1:9/api/v1/", token: "owned-unused" }),
        getPullRequest: async () => ({
          number: 1,
          url: "http://forge.invalid/pr/1",
          headSha: commitSHA,
          merged: false,
          state: "open",
          baseBranch: "main",
          baseSha: owned.revision,
          headBranch: "factory/owned",
        }),
        getFile: async () => {
          await hold("workflow");
          return "owned protected workflow";
        },
        listActionRuns: async () => {
          await hold("action run");
          return [
            {
              id: 1,
              workflowID: "factory-verification.yml",
              event: "pull_request",
              status: "waiting",
              commitSha: commitSHA,
              url: "http://forge.invalid/run/1",
            },
          ];
        },
        registerEphemeralRunner: async () => {
          registrations += 1;
          await hold("runner registration");
          return { id: 17, uuid: crypto.randomUUID(), token: "owned-ephemeral-token" };
        },
        deleteRunner: async (_repository: unknown, id: number) => {
          if (id === 17 && failedRevocation && rejectedRevocations++ === 0)
            throw new Error("Owned runner revocation response unavailable");
          removed.push(id);
        },
      };
      const delivery = createDeliveryController(
        database,
        {
          startVerification: async () => {
            starts += 1;
            return null;
          },
          startStagingReplacement: async () => null,
          stop: async (attemptID) => {
            stopped.push(attemptID);
            await database.client`UPDATE factory.runtime_attempt SET state = 'stopped' WHERE id = ${attemptID}`;
            return null;
          },
        },
        {
          prompt: async () => {
            throw new Error("Cancelled work must not repair");
          },
        },
        async () => {},
        { client: forge, owner: "owned" },
      );
      reconciliation = delivery.reconcile(owned.changeID);
      await Promise.race([
        entered.promise,
        reconciliation.then(() => {
          throw Error(
            `Verification completed without reaching the controlled ${boundary} boundary`,
          );
        }),
      ]);
      if (trash) {
        trashController = createTicketTrashController(
          database,
          {
            async stop(id) {
              stopped.push(id);
              await database.client`UPDATE factory.runtime_attempt SET state = 'stopped' WHERE id = ${id}`;
            },
          },
          { stop: createChangeAgentStop(database, owned.hub).persist },
          delivery,
        );
        await trashController.trash(owned.ticketID, owned.userID);
        await expect(trashController.restore(owned.ticketID, owned.userID, 2)).rejects.toThrow(
          "stop confirmation",
        );
      } else {
        // Same persisted boundary as the authenticated Change cancellation command.
        await database.client`UPDATE factory.change SET state = 'cancelling', cancel_requested_at = now()
          WHERE id = ${owned.changeID}`;
        await delivery.cancel(owned.changeID);
      }
      release.resolve();
      await reconciliation;
      if (trash) {
        await eventually(
          async () =>
            (
              await database.client`SELECT trash_stop_pending FROM factory.ticket WHERE id = ${owned.ticketID}`
            )[0],
          (ticket) => ticket?.["trash_stop_pending"] === false,
          "Trash did not quiesce Verification",
        );
        if (!trashController) throw new Error("Trash controller missing");
        await trashController.restore(owned.ticketID, owned.userID, 2);
      }
      await delivery.reconcile(owned.changeID);
      const verifications = await database.client<
        Array<{ state: string; runnerID: string | null }>
      >`
        SELECT state, runner_id AS "runnerID" FROM factory.verification WHERE change_id = ${owned.changeID}`;
      expect(starts).toBe(0);
      expect(verifications.every((verification) => verification.state === "cancelled")).toBe(true);
      expect(verifications.every((verification) => verification.runnerID === null)).toBe(true);
      expect(registrations).toBe(boundary === "runner registration" ? 1 : 0);
      if (registrations) expect(removed).toContain(17);
      const [unrelated] = await database.client<
        { state: string }[]
      >`SELECT state FROM factory.runtime_attempt WHERE id = ${owned.attemptID}`;
      expect(unrelated?.state).toBe(trash ? "stopped" : "ready");
      for (const id of [other.attemptID, personalAttemptID, stagingAttemptID]) {
        const [attempt] = await database.client<
          { state: string }[]
        >`SELECT state FROM factory.runtime_attempt WHERE id = ${id}`;
        expect(attempt?.state).toBe("ready");
        expect(stopped).not.toContain(id);
      }
      const [preview] = await database.client<
        { id: string }[]
      >`SELECT runtime_attempt_id AS id FROM factory.staging_preview WHERE project_id = ${owned.projectID}`;
      expect(preview?.id).toBe(stagingAttemptID);
      if (boundary === "workflow") expect(verifications).toHaveLength(0);
    } finally {
      release.resolve();
      trashController?.close();
      await reconciliation?.catch(() => undefined);
      await owned.dispose();
    }
  },
  60_000,
);

test.each(["verification", "change", "trashed", "restored-stop"] as const)(
  "runtime admission rejects cancelled %s before creating resources",
  async (cancelled) => {
    const owned = await nativeRuntimeFixture("ticket");
    const database = owned.database;
    try {
      const runtime = owned.controller();
      await runtime.startPersisted(owned.changeID, owned.userID);
      // Workspace startup reads this fixture's local Git tree. Verification
      // uses the installation-bound Forge identity, including retained jobs.
      const owner = process.env["FACTORY_FORGEJO_OWNER"];
      const forge =
        process.env["FACTORY_FORGEJO_PUBLIC_URL"] ?? process.env["FACTORY_FORGEJO_API_URL"];
      if (!owner || !forge) throw new Error("Owned Verification Forge configuration is missing");
      const repository = new URL(`/${encodeURIComponent(owner)}/owned-cancelled-admission`, forge);
      await database.client`UPDATE factory.project SET repository_url=${repository.href}
        WHERE id=${owned.projectID}`;
      await database.client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${owned.attemptID}`;
      await database.client`UPDATE factory.change SET state='active' WHERE id=${owned.changeID}`;
      await database.client`INSERT INTO factory.change_agent_session(
        change_id,runtime_attempt_id,opencode_session_id,state,native_session_confirmed_at,created_by)
        VALUES(${owned.changeID},${owned.attemptID},'ses_owned_cancelled_admission','committed',now(),${owned.userID})`;
      const sources = [...(await database.client`SELECT * FROM factory.substrate_source`)];
      owned.calls.splice(0);
      const verificationID = crypto.randomUUID();
      await database.client`INSERT INTO factory.verification(id, change_id, commit_sha, pull_request_number,
        runner_name, runner_uuid, runner_token, action_run_id, runner_job_handle, created_by)
        VALUES (${verificationID}, ${owned.changeID}, ${"d".repeat(40)}, 1, 'owned-cancelled',
          ${crypto.randomUUID()}, 'owned-token', 1, 'owned-exact-job', ${owned.userID})`;
      const authorized = await database.client.begin((sql) =>
        substrateVerificationAuthorityIn(sql, owned.projectID, verificationID, owned.userID),
      );
      expect(authorized.revision).toBe("d".repeat(40));
      if (cancelled === "verification")
        await database.client`UPDATE factory.verification SET state = 'cancelled', completed_at = now()
          WHERE id = ${verificationID}`;
      else if (cancelled === "change")
        await database.client`UPDATE factory.change SET state = 'cancelling', cancel_requested_at = now()
          WHERE id = ${owned.changeID}`;
      else if (cancelled === "trashed")
        await database.client`UPDATE factory.ticket SET trashed_at = now(), trashed_by = ${owned.userID} WHERE id = ${owned.ticketID}`;
      else await createChangeAgentStop(database, owned.hub).persist(owned.changeID);
      await expect(runtime.startVerification(verificationID, owned.userID)).rejects.toThrow(
        "Verification authority",
      );
      const attempts =
        await database.client`SELECT id FROM factory.runtime_attempt WHERE verification_id = ${verificationID}`;
      expect(attempts).toHaveLength(0);
      expect(owned.calls).toHaveLength(0);
      expect([...(await database.client`SELECT * FROM factory.substrate_source`)]).toEqual(sources);
      expect(
        (
          await database.client`SELECT state FROM factory.runtime_attempt WHERE id=${owned.attemptID}`
        )[0]?.["state"],
      ).toBe("ready");
    } finally {
      await owned.dispose();
    }
  },
  60_000,
);
