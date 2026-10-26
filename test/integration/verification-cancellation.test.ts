import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDeliveryController } from "../../apps/factory/src/delivery/controller";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import { createTicketTrashController } from "../../apps/factory/src/change/trash";
import { createChangeAgentStop } from "../../apps/factory/src/agent/stop";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import { createForgejoClient } from "../../packages/forge/src/forge";
import type { KubernetesClient } from "../../packages/runtime-kubernetes/src/client";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess, eventually } from "../fixtures/factory-process";

// Kubernetes is injected below. These pinned fixture identities are never launched.
const configuration = {
  FACTORY_RUNTIME_HOST_IMAGE: `example.invalid/owned-runtime@sha256:${"a".repeat(64)}`,
  FACTORY_BROWSER_TOOLS_IMAGE: `example.invalid/owned-browser@sha256:${"d".repeat(64)}`,
  FACTORY_FORGEJO_API_URL: "http://127.0.0.1:1/api/v1",
  FACTORY_FORGEJO_TOKEN: "owned-mocked-forge-token",
  FACTORY_FORGEJO_OWNER: "owned-cancellation-fixture",
};
const previous = new Map<string, string | undefined>();
beforeAll(() => {
  for (const [key, value] of Object.entries(configuration)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
});
afterAll(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test.each([
  ...[
    { boundary: "workflow", replace: false, failedRevocation: false },
    { boundary: "action run", replace: false, failedRevocation: false },
    { boundary: "runner registration", replace: false, failedRevocation: false },
    { boundary: "runner registration", replace: true, failedRevocation: false },
    { boundary: "runner registration", replace: false, failedRevocation: true },
    { boundary: "runner registration", replace: true, failedRevocation: true },
  ].map((item) => ({ ...item, trash: false })),
  ...["workflow", "action run", "runner registration"].map((boundary) => ({
    boundary,
    replace: false,
    failedRevocation: false,
    trash: true,
  })),
])(
  "cancellation during $boundary, replacement=$replace, failed revocation=$failedRevocation, trash=$trash",
  async ({ boundary, replace, failedRevocation, trash }) => {
    const process = await factoryProcess();
    const database = process.connect();
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
      const owned = await fixture(undefined, undefined, database);
      const other = await fixture(undefined, undefined, database);
      const personalWorkspaceID = crypto.randomUUID();
      const personalAttemptID = crypto.randomUUID();
      const stagingAttemptID = crypto.randomUUID();
      await database.client`INSERT INTO factory.development_workspace(id, project_id, kind, owner_user_id,
        source_branch, source_revision, kubernetes_namespace, volume_name, created_by)
        VALUES (${personalWorkspaceID}, ${owned.projectID}, 'personal', ${owned.userID}, 'main', ${"a".repeat(40)},
          ${`factory-workspace-${personalWorkspaceID.replaceAll("-", "").slice(0, 12)}`}, 'never-created', ${owned.userID})`;
      await database.client`INSERT INTO factory.runtime_attempt(id, project_id, workspace_id, generation,
        revision, state, kubernetes_namespace, kubernetes_pod_name,
        parent_connector_token_hash, child_connector_token_hash, create_intended_at, created_by)
        SELECT ${personalAttemptID}, project_id, ${personalWorkspaceID}, 1, revision, 'ready',
          'owned-personal-not-created', 'never-created', parent_connector_token_hash, child_connector_token_hash, now(), created_by
        FROM factory.runtime_attempt WHERE id = ${owned.attemptID}`;
      await database.client`INSERT INTO factory.runtime_attempt(id, project_id, isolated_kind, generation,
        revision, state, kubernetes_namespace, kubernetes_pod_name,
        parent_connector_token_hash, child_connector_token_hash, create_intended_at, created_by)
        SELECT ${stagingAttemptID}, project_id, 'staging', 1, revision, 'ready',
          'owned-staging-not-created', 'never-created', parent_connector_token_hash, child_connector_token_hash, now(), created_by
        FROM factory.runtime_attempt WHERE id = ${owned.attemptID}`;
      await database.client`INSERT INTO factory.staging_preview(project_id, revision, runtime_attempt_id)
        VALUES (${owned.projectID}, ${"a".repeat(40)}, ${stagingAttemptID})`;
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
      if (replace) {
        const verificationID = crypto.randomUUID();
        const attemptID = crypto.randomUUID();
        await database.client`INSERT INTO factory.verification(id, change_id, commit_sha, pull_request_number,
          runner_name, runner_id, runner_uuid, runner_token, created_by)
          VALUES (${verificationID}, ${owned.changeID}, ${commitSHA}, 1, 'owned-replacement', 16,
            ${crypto.randomUUID()}, 'owned-token', ${owned.userID})`;
        await database.client`INSERT INTO factory.runtime_attempt(id, project_id, verification_id, isolated_kind,
          generation, revision, state, kubernetes_namespace, kubernetes_pod_name,
          parent_connector_token_hash, child_connector_token_hash, create_intended_at, created_by)
          VALUES (${attemptID}, ${owned.projectID}, ${verificationID}, 'verification', 2, ${commitSHA},
            'stopped', 'owned-not-created', 'never-created', ${"a".repeat(64)}, ${"b".repeat(64)}, now(), ${owned.userID})`;
        await database.client`UPDATE factory.verification SET runtime_attempt_id = ${attemptID} WHERE id = ${verificationID}`;
      }
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
          baseSha: "a".repeat(40),
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
      await entered.promise;
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
      if (replace) expect(removed).toContain(16);
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
      await database.client.end({ timeout: 0 });
      await process.dispose();
    }
  },
  60_000,
);

test.each(["verification", "change", "trashed", "restored-stop"] as const)(
  "runtime admission rejects cancelled %s before creating resources",
  async (cancelled) => {
    const process = await factoryProcess();
    const database = process.connect();
    let prepares = 0;
    let applies = 0;
    const kubernetes: KubernetesClient = {
      apply: async () => {
        applies += 1;
        throw new Error("Cancelled resource create");
      },
      getPod: async () => null,
      getNamespace: async () => null,
      getPodLogs: async () => "",
      readSecret: async () => {
        throw new Error("Unexpected Secret read");
      },
      deletePod: async () => {},
      deleteNamespace: async () => {},
    };
    try {
      const owned = await fixture(undefined, undefined, database);
      const verificationID = crypto.randomUUID();
      await database.client`INSERT INTO factory.verification(id, change_id, commit_sha, pull_request_number,
        runner_name, runner_uuid, runner_token, created_by)
        VALUES (${verificationID}, ${owned.changeID}, ${"d".repeat(40)}, 1, 'owned-cancelled',
          ${crypto.randomUUID()}, 'owned-token', ${owned.userID})`;
      if (cancelled === "verification")
        await database.client`UPDATE factory.verification SET state = 'cancelled', completed_at = now()
          WHERE id = ${verificationID}`;
      else if (cancelled === "change")
        await database.client`UPDATE factory.change SET state = 'cancelling', cancel_requested_at = now()
          WHERE id = ${owned.changeID}`;
      else if (cancelled === "trashed")
        await database.client`UPDATE factory.ticket SET trashed_at = now(), trashed_by = ${owned.userID} WHERE id = ${owned.ticketID}`;
      else await createChangeAgentStop(database, owned.hub).persist(owned.changeID);
      const runtime = createRuntimeController(
        database,
        new RuntimeHub(async () => {}),
        "owned-secret",
        {
          async prepareExecution() {
            throw new Error("Verification must never prepare development source");
          },
        },
        kubernetes,
        async () => {
          prepares += 1;
          return "";
        },
      );
      expect(await runtime.startVerification(verificationID, owned.userID)).toBeNull();
      const attempts =
        await database.client`SELECT id FROM factory.runtime_attempt WHERE verification_id = ${verificationID}`;
      expect(attempts).toHaveLength(0);
      expect(prepares).toBe(0);
      expect(applies).toBe(0);
    } finally {
      await database.client.end({ timeout: 0 });
      await process.dispose();
    }
  },
  60_000,
);
