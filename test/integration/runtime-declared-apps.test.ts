import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import { createDatabase } from "../../packages/db/src/client";
import { createKubernetesClient } from "../../packages/runtime-kubernetes/src/client";
import { personalWorkspaceIdentity } from "../../packages/workspace-domain/src/workspace";
import { fixture } from "../fixtures/change-agent-turns";
import { eventually } from "../fixtures/factory-process";
import { ownedPostgresServer, ownedTestDatabase } from "../fixtures/postgres-server";
import { installOwnedRuntimeConfiguration } from "../fixtures/runtime-configuration";

let server: Awaited<ReturnType<typeof ownedPostgresServer>>;
let restore: () => void;
beforeAll(async () => {
  restore = installOwnedRuntimeConfiguration();
  server = process.env["FACTORY_TEST_POSTGRES"]
    ? { identity: JSON.parse(process.env["FACTORY_TEST_POSTGRES"]), dispose: async () => {} }
    : await ownedPostgresServer();
}, 60_000);
afterAll(async () => {
  await server?.dispose();
  restore?.();
});

test.each([
  "personal",
  "personal-pulled",
  "personal-pulled-with-later-failure",
  "personal-pulled-with-later-unchanged-pull",
  "personal-unconfirmed-pull",
  "personal-local-commit",
  "staging",
  "staging-unstarted",
  "staging-missing-contract",
  "ticket",
  "ticket-submitted",
  "ticket-submitted-with-later-failure",
] as const)(
  "new %s runtime retains all declared App channels before compute is available",
  async (kind) => {
    const isolated = await ownedTestDatabase(server.identity, crypto.randomUUID());
    const previousURL = process.env["DATABASE_URL"];
    process.env["DATABASE_URL"] = isolated.url;
    const database = createDatabase();
    if (previousURL === undefined) delete process.env["DATABASE_URL"];
    else process.env["DATABASE_URL"] = previousURL;
    const source = await mkdtemp(join(tmpdir(), "factory-declared-apps-"));
    try {
      await mkdir(join(source, ".factory"));
      await writeFile(
        join(source, ".factory/system.json"),
        JSON.stringify({
          version: 1,
          primaryApp: "web",
          apps: [
            {
              id: "web",
              label: "Website",
              command: ["node", "web.js"],
              port: 4321,
              healthPath: "/",
            },
            {
              id: "editor",
              label: "Forms editor",
              command: ["node", "editor.js"],
              port: 3002,
              healthPath: "/",
            },
            {
              id: "api",
              label: "Forms API",
              command: ["node", "api.js"],
              port: 3001,
              healthPath: "/",
            },
          ],
        }),
      );
      const git = (...args: string[]) => {
        const result = Bun.spawnSync(["git", "-C", source, ...args]);
        if (result.exitCode) throw new Error("Owned declared-App source setup failed");
        return result.stdout.toString().trim();
      };
      git("init", "-b", "main");
      git("add", ".");
      git(
        "-c",
        "user.name=Factory",
        "-c",
        "user.email=factory@example.invalid",
        "commit",
        "-m",
        "Owned declared Apps",
      );
      if (kind === "staging-missing-contract") {
        git("rm", ".factory/system.json");
        git(
          "-c",
          "user.name=Factory",
          "-c",
          "user.email=factory@example.invalid",
          "commit",
          "-m",
          "Owned source before configuration",
        );
      }
      const revision = git("rev-parse", "HEAD");
      const owned = await fixture(undefined, revision, database);
      await database.client`UPDATE factory.project SET repository_url=${`file://${source}`}
        WHERE id=${owned.projectID}`;
      await database.client`UPDATE factory.runtime_attempt SET state='stopped'
        WHERE id=${owned.attemptID}`;
      await database.client`INSERT INTO factory.execution_policy(scope,version,policy,updated_by)
        VALUES('factory',1,'{"sandboxes":0}'::jsonb,${owned.userID})`;
      if (kind.startsWith("ticket"))
        await database.client`INSERT INTO factory.branch_create_operation(
          id,change_id,repository_owner,repository_name,branch_name,start_sha,
          idempotency_key,state,observed_head_sha,completed_at)
          SELECT ${crypto.randomUUID()},id,'owned','declared-apps',branch_name,base_sha,
            ${crypto.randomUUID()},'succeeded',base_sha,now()
          FROM factory.change WHERE id=${owned.changeID}`;
      let executionRevision = revision;
      let expectedApps = ["app", "app-editor", "app-api"];
      let personalWorkspaceID: string | undefined;
      let previousPersonalAttemptID: string | undefined;
      if (kind.startsWith("personal-")) {
        personalWorkspaceID = personalWorkspaceIdentity(owned.projectID, owned.userID).workspaceID;
        previousPersonalAttemptID = crypto.randomUUID();
        await database.client`INSERT INTO factory.development_workspace(
          id,project_id,kind,owner_user_id,source_branch,source_revision,created_by)
          VALUES(${personalWorkspaceID},${owned.projectID},'personal',${owned.userID},'main',${revision},${owned.userID})`;
        await database.client`INSERT INTO factory.runtime_attempt(
          id,project_id,workspace_id,generation,revision,state,parent_connector_token_hash,
          child_connector_token_hash,create_intended_at,created_by)
          VALUES(${previousPersonalAttemptID},${owned.projectID},${personalWorkspaceID},1,${revision},
            'stopped',${"a".repeat(64)},${"b".repeat(64)},now(),${owned.userID})`;
        const path = join(source, ".factory/system.json");
        const contract = JSON.parse(await Bun.file(path).text());
        contract.apps[0].command = ["node", "current-web.js"];
        contract.apps[1].id = "visual-editor";
        await writeFile(path, JSON.stringify(contract));
        git("add", ".");
        git(
          "-c",
          "user.name=Factory",
          "-c",
          "user.email=factory@example.invalid",
          "commit",
          "-m",
          "Published newer personal App configuration",
        );
        const pulled = git("rev-parse", "HEAD");
        const succeeded = kind.startsWith("personal-pulled");
        await database.client`INSERT INTO factory.personal_git_operation(
          id,workspace_id,runtime_attempt_id,user_id,action,expected_head,branch,message,state,result,completed_at)
          VALUES(${crypto.randomUUID()},${personalWorkspaceID},${previousPersonalAttemptID},${owned.userID},
            ${kind === "personal-local-commit" ? "commit" : "pull"},${revision},'main','',
            ${succeeded || kind === "personal-local-commit" ? "succeeded" : "uncertain"},
            ${JSON.stringify({ head: pulled, branch: "main", files: [] })}::text::jsonb,
            CASE WHEN ${succeeded || kind === "personal-local-commit"} THEN now() ELSE NULL END)`;
        if (succeeded) {
          executionRevision = pulled;
          expectedApps = ["app", "app-visual-editor", "app-api"];
        }
        if (
          kind === "personal-pulled-with-later-failure" ||
          kind === "personal-pulled-with-later-unchanged-pull"
        )
          await database.client`INSERT INTO factory.personal_git_operation(
            id,workspace_id,runtime_attempt_id,user_id,action,expected_head,branch,message,state,result,completed_at)
            VALUES(${crypto.randomUUID()},${personalWorkspaceID},${previousPersonalAttemptID},${owned.userID},
              'pull',${"f".repeat(40)},'main','',
              ${kind === "personal-pulled-with-later-failure" ? "failed" : "succeeded"},
              ${JSON.stringify({ head: "f".repeat(40), branch: "main", files: [] })}::text::jsonb,
              clock_timestamp()+interval '1 second')`;
      }
      if (kind.startsWith("ticket-submitted")) {
        const path = join(source, ".factory/system.json");
        const contract = JSON.parse(await Bun.file(path).text());
        contract.apps[0].command = ["node", "current-web.js"];
        contract.apps[1].id = "visual-editor";
        await writeFile(path, JSON.stringify(contract));
        git("add", ".");
        git(
          "-c",
          "user.name=Factory",
          "-c",
          "user.email=factory@example.invalid",
          "commit",
          "-m",
          "Submit changed App launch configuration",
        );
        executionRevision = git("rev-parse", "HEAD");
        expectedApps = ["app", "app-visual-editor", "app-api"];
        await database.client`INSERT INTO factory.change_commit_operation(
          id,change_id,runtime_attempt_id,sequence,branch_name,expected_parent_sha,
          commit_sha,observed_remote_sha,commit_message,idempotency_key,state,created_by,completed_at)
          SELECT ${crypto.randomUUID()},id,${owned.attemptID},1,branch_name,base_sha,
            ${executionRevision},${executionRevision},'Submitted Apps',${crypto.randomUUID()},
            'succeeded',${owned.userID},now()
          FROM factory.change WHERE id=${owned.changeID}`;
        if (kind === "ticket-submitted-with-later-failure")
          await database.client`INSERT INTO factory.change_commit_operation(
            id,change_id,runtime_attempt_id,sequence,branch_name,expected_parent_sha,
            commit_sha,commit_message,idempotency_key,state,created_by,completed_at)
            SELECT ${crypto.randomUUID()},id,${owned.attemptID},2,branch_name,${executionRevision},
              ${"f".repeat(40)},'Unpublished change',${crypto.randomUUID()},
              'failed',${owned.userID},now()
            FROM factory.change WHERE id=${owned.changeID}`;
      }
      const controller = createRuntimeController(
        database,
        new RuntimeHub(async () => {}),
        "owned-declared-app-secret",
        {
          async prepareExecution() {
            throw new Error("Queued compute must not prepare source");
          },
        },
        {
          ...createKubernetesClient(),
          async apply() {
            throw new Error("Queued compute must not create resources");
          },
        },
        async () => "",
      );
      if (kind === "staging-missing-contract") {
        await expect(controller.ensureStaging(owned.projectID, owned.userID)).rejects.toThrow(
          ".factory/system.json",
        );
        expect(
          await database.client`SELECT project_id FROM factory.staging_preview WHERE project_id=${owned.projectID}`,
        ).toHaveLength(0);
        return;
      }
      if (kind === "staging-unstarted")
        await database.client`INSERT INTO factory.staging_preview(project_id,revision)
          VALUES(${owned.projectID},${"0".repeat(40)})`;
      const attempt = kind.startsWith("personal")
        ? await controller.start(owned.projectID, owned.userID)
        : kind.startsWith("staging")
          ? await controller.ensureStaging(owned.projectID, owned.userID)
          : await controller.startPersisted(owned.changeID, owned.userID);
      expect(attempt?.state).toBe("create-intended");
      expect(attempt?.revision).toBe(executionRevision);
      const [retained] = await database.client<{ apps: string[]; waiting: boolean }[]>`
        SELECT declared_apps AS apps,
          EXISTS(SELECT 1 FROM factory.runtime_compute_wait WHERE attempt_id=attempt.id) AS waiting
        FROM factory.runtime_attempt attempt WHERE id=${attempt?.id ?? null}`;
      expect(retained?.apps).toEqual(expectedApps);
      expect(retained?.waiting).toBe(true);
      if (personalWorkspaceID && previousPersonalAttemptID) {
        const [workspace] = await database.client<{ revision: string }[]>`
          SELECT source_revision AS revision FROM factory.development_workspace WHERE id=${personalWorkspaceID}`;
        expect(workspace?.revision).toBe(revision);
        const [previous] = await database.client<{ revision: string }[]>`
          SELECT revision FROM factory.runtime_attempt WHERE id=${previousPersonalAttemptID}`;
        expect(previous?.revision).toBe(revision);
        await database.client`INSERT INTO factory.personal_git_operation(
          id,workspace_id,runtime_attempt_id,user_id,action,expected_head,branch,message,state,result,completed_at)
          VALUES(${crypto.randomUUID()},${personalWorkspaceID},${previousPersonalAttemptID},${owned.userID},
            'pull',${executionRevision},'main','','succeeded',
            ${JSON.stringify({ head: "e".repeat(40), branch: "main", files: [] })}::text::jsonb,
            clock_timestamp()+interval '2 seconds')`;
        const same = await controller.start(owned.projectID, owned.userID);
        expect(same?.id).toBe(attempt?.id);
        expect(same?.revision).toBe(executionRevision);
        const [unchanged] = await database.client<{ apps: string[] }[]>`
          SELECT declared_apps AS apps FROM factory.runtime_attempt WHERE id=${same?.id ?? null}`;
        expect(unchanged?.apps).toEqual(expectedApps);
      }
      if (kind.startsWith("ticket")) {
        const [workspace] = await database.client<{ revision: string }[]>`
          SELECT source_revision AS revision FROM factory.development_workspace
          WHERE change_id=${owned.changeID}`;
        expect(workspace?.revision).toBe(revision);
      }
      if (kind.startsWith("ticket-submitted")) {
        await database.client`INSERT INTO factory.change_commit_operation(
          id,change_id,runtime_attempt_id,sequence,branch_name,expected_parent_sha,
          commit_sha,observed_remote_sha,commit_message,idempotency_key,state,created_by,completed_at)
          SELECT ${crypto.randomUUID()},id,${owned.attemptID},3,branch_name,${executionRevision},
            ${"e".repeat(40)},${"e".repeat(40)},'Later submission',${crypto.randomUUID()},
            'succeeded',${owned.userID},now()
          FROM factory.change WHERE id=${owned.changeID}`;
        const same = await controller.startPersisted(owned.changeID, owned.userID);
        expect(same?.id).toBe(attempt?.id);
        expect(same?.revision).toBe(executionRevision);
        const [unchanged] = await database.client<{ apps: string[] }[]>`
          SELECT declared_apps AS apps FROM factory.runtime_attempt WHERE id=${same?.id ?? null}`;
        expect(unchanged?.apps).toEqual(expectedApps);
        await expect(
          Promise.resolve(database.client`UPDATE factory.runtime_attempt SET revision=${"e".repeat(40)}
            WHERE id=${same?.id ?? null}`),
        ).rejects.toThrow("Runtime Attempt identity");
        for (const invalid of [revision, executionRevision, "f".repeat(40)])
          await expect(
            Promise.resolve(database.client`INSERT INTO factory.runtime_attempt(
            id,project_id,change_id,workspace_id,generation,revision,state,
            parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
            SELECT ${crypto.randomUUID()},project_id,change_id,workspace_id,generation+1,${invalid},
              'create-intended',parent_connector_token_hash,child_connector_token_hash,now(),created_by
            FROM factory.runtime_attempt WHERE id=${same?.id ?? null}`),
          ).rejects.toThrow("Ticket execution revision must match");
      }
    } finally {
      await database.client.end();
      await isolated.dispose();
      await rm(source, { recursive: true, force: true });
    }
  },
  30_000,
);

test("terminal bootstrap failure is not hidden by an earlier observation timeout", async () => {
  const isolated = await ownedTestDatabase(server.identity, crypto.randomUUID());
  const previousURL = process.env["DATABASE_URL"];
  process.env["DATABASE_URL"] = isolated.url;
  const database = createDatabase();
  if (previousURL === undefined) delete process.env["DATABASE_URL"];
  else process.env["DATABASE_URL"] = previousURL;
  try {
    const owned = await fixture(undefined, undefined, database);
    await database.client`UPDATE factory.runtime_attempt
      SET failure='Infrastructure command timed out; outcome is unconfirmed'
      WHERE id=${owned.attemptID}`;
    const controller = createRuntimeController(
      database,
      new RuntimeHub(async () => {}),
      "owned-terminal-cause",
      {
        async prepareExecution() {
          throw new Error("Status must not prepare source");
        },
      },
      {
        ...createKubernetesClient(),
        getNamespace: async () => null,
        getPod: async () => null,
        deleteSecret: async () => {},
      },
      async () => "",
    );
    const cause = "Dev Container build failed: actual bootstrap cause";
    await controller.status(owned.attemptID, "failed", cause);
    await eventually(
      async () => (await controller.get(owned.attemptID))?.state,
      (state) => state === "failed",
      "Owned terminal cleanup did not finish",
    );
    expect((await controller.get(owned.attemptID))?.failure).toBe(cause);
  } finally {
    await database.client.end();
    await isolated.dispose();
  }
}, 30_000);
