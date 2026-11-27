import { expect, test } from "bun:test";
import { factorySigningSecret } from "#auth/signing-secret";
import type { createForgejoClient } from "#forge/forge";
import type { createForgejoReleases } from "#forge/releases";
import { releaseContract, releasePackageOwner } from "#project-domain/release";
import { runtimeIdentity, runtimePublicationToken } from "#runtime-domain/identity";
import { freezeRuntimeEnvironment } from "../../apps/factory/src/environments/runtime";
import { createReleaseController } from "../../apps/factory/src/releases/controller";
import type { ReleaseCredential } from "../../apps/factory/src/releases/secrets";
import { factoryProcess } from "../fixtures/factory-process";
import { nativeJobsFixture } from "../fixtures/native-jobs";

test("release recovery retains immutable intent, never depends on a consumer and never replays dispatch", async () => {
  const fixture = await factoryProcess();
  const database = fixture.connect();
  const userID = crypto.randomUUID(),
    viewerID = crypto.randomUUID(),
    projectID = crypto.randomUUID(),
    releaseID = crypto.randomUUID();
  const sha = "a".repeat(40);
  const signingKey = factorySigningSecret();
  const configuration = {
    FACTORY_FORGEJO_API_URL: "http://forgejo.internal:3000/api/v1/",
    FACTORY_FORGEJO_PUBLIC_URL: "https://forge.example",
    FACTORY_FORGEJO_OWNER: "factory",
  };
  const previous = new Map(Object.keys(configuration).map((key) => [key, process.env[key]]));
  let jobs: Awaited<ReturnType<typeof nativeJobsFixture>> | undefined;
  let unblock = () => {};
  let pendingCredentials: Promise<Response> | undefined;
  let pendingEnd: Promise<void> | undefined;
  let creates = 0,
    dispatches = 0,
    delivered = false;
  const native = {
    configuredAccess: false,
    async dispatch() {
      dispatches++;
      throw new Error("not used by source releases");
    },
    async ensureRelease(_repository: unknown, version: string, commit: string, body: string) {
      expect(version).toBe("1.2.3");
      expect(commit).toBe(sha);
      expect(body).toContain(`factory-release:${releaseID}`);
      if (!delivered) {
        creates++;
        delivered = true;
        throw new Error("lost response after native creation");
      }
      return "https://forge.example/factory/project/releases/tag/v1.2.3";
    },
  } as unknown as ReturnType<typeof createForgejoReleases>;
  const controller = createReleaseController({
    database,
    signingKey: "owned-test-signing-key",
    secrets: {
      configured: false,
      async read() {
        return undefined;
      },
      async create() {
        throw new Error("not configured");
      },
    },
    runtime: {
      async startPublication() {
        throw new Error("Source release must not start runtime");
      },
      async stop() {},
    },
    forge: {
      async getDefaultBranch() {
        return { headSha: sha };
      },
      async listFiles() {
        return [];
      },
    } as unknown as ReturnType<typeof createForgejoClient>,
    publication: native,
    apiURL: "http://forgejo.internal:3000/api/v1/",
    publicURL: "https://forge.example",
    owner: "factory",
  });
  try {
    Object.assign(process.env, configuration);
    for (const [id, role] of [
      [userID, "developer"],
      [viewerID, "product-contributor"],
    ] as const) {
      await database.client`INSERT INTO auth."user"(id,name,email,email_verified) VALUES(${id},'Release proof',${`${id}@factory.invalid`},true)`;
      await database.client`INSERT INTO factory.account_access(user_id) VALUES(${id}) ON CONFLICT DO NOTHING`;
      if (id === userID) {
        await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by)
          VALUES(${projectID},${`release-${projectID.slice(0, 8)}`},'Release proof','https://forge.example/factory/project.git','main','.factory/actor-template.json',${userID})`;
      }
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
        VALUES(${projectID},${id},${role},${id === userID},${userID})`;
    }
    await database.client`UPDATE factory.project SET repository_url='http://forgejo.internal:3000/factory/project.git' WHERE id=${projectID}`;
    const handoff = await controller.view(userID, projectID);
    expect(handoff.repositoryURL).toBe("https://forge.example/factory/project.git");
    expect(handoff.registryURL).toBe("https://forge.example");
    const [source] = await database.client<{ url: string }[]>`
      SELECT repository_url AS url FROM factory.project WHERE id=${projectID}`;
    expect(source?.url).toBe("http://forgejo.internal:3000/factory/project.git");
    await database.client`UPDATE factory.project SET repository_url='https://forge.example/factory/project.git' WHERE id=${projectID}`;
    await expect(
      controller.publish(viewerID, projectID, {
        commandID: crypto.randomUUID(),
        version: "1.2.3",
        commitSHA: sha,
        notes: "",
      }),
    ).rejects.toThrow("Developer");
    await expect(
      controller.publish(userID, projectID, {
        commandID: crypto.randomUUID(),
        version: "1.2.3",
        commitSHA: sha,
        notes: "",
      }),
    ).rejects.toThrow("Staging");
    // A retained admitted intent models restart after confirmation, not a bypass of public admission.
    await database.client`INSERT INTO factory.project_release(id,project_id,command_id,version,commit_sha,notes,created_by)
      VALUES(${releaseID},${projectID},${releaseID},'1.2.3',${sha},'approved notes',${userID})`;
    await database.client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload,created_by)
      VALUES(${releaseID},'releases.attempt','project_release',${releaseID},${`releases.attempt:${releaseID}`},
        ${`releases.attempt.ordinal:${releaseID}:1`},'pending',
        ${JSON.stringify({
          id: releaseID,
          releaseId: releaseID,
          commandId: releaseID,
          ordinal: 1,
          dispatchIntendedAt: null,
          runId: null,
          runnerId: null,
          runnerUuid: null,
          runnerToken: null,
          jobHandle: null,
          runtimeAttemptId: null,
          cleanedAt: null,
        })}::jsonb,${userID})`;
    await controller.reconcile(userID, projectID, releaseID);
    expect((await controller.view(userID, projectID)).releases[0]?.state).toBe("uncertain");
    await controller.recover();
    const result = await controller.view(userID, projectID);
    expect(result.releases[0]?.state).toBe("published");
    expect(result.lastVersion).toBe("1.2.3");
    expect(creates).toBe(1);
    expect(dispatches).toBe(0);
    await expect(
      (async () => {
        await database.client`UPDATE factory.project_release SET commit_sha=${"b".repeat(40)} WHERE id=${releaseID}`;
      })(),
    ).rejects.toThrow();
    await expect(
      (async () => {
        await database.client`UPDATE factory.project_release SET notes='rewrite' WHERE id=${releaseID}`;
      })(),
    ).rejects.toThrow();
    await controller.recover();
    expect(creates).toBe(1);
    await expect(
      controller.createAccess(viewerID, projectID, {
        commandID: crypto.randomUUID(),
        name: "denied",
        scope: "git",
      }),
    ).rejects.toThrow();

    const publicationID = crypto.randomUUID();
    const identity = runtimeIdentity(publicationID, 1);
    const contract = releaseContract.parse({ schemaVersion: 1, images: ["web"] });
    await database.client`INSERT INTO factory.project_release(id,project_id,command_id,version,commit_sha,workflow,contract,notes,state,created_by)
      VALUES(${publicationID},${projectID},${publicationID},'1.2.4',${sha},'.forgejo/workflows/factory-release.yml',${JSON.stringify(contract)}::text::jsonb,'admitted fixture','running',${userID})`;
    await database.client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,state,payload,created_by)
      VALUES(${crypto.randomUUID()},'environments.environment','project',${projectID},
        ${`environments.environment:${projectID}:development`},'saved',
        ${JSON.stringify({
          projectId: projectID,
          environment: "development",
          version: 1,
          manifest: { variables: [] },
          secretKey: "synthetic-development-secrets",
        })}::jsonb,${userID})`;
    await database.client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload,created_by)
      VALUES(${publicationID},'releases.attempt','project_release',${publicationID},
        ${`releases.attempt:${publicationID}`},${`releases.attempt.ordinal:${publicationID}:1`},'running',
        ${JSON.stringify({
          id: publicationID,
          releaseId: publicationID,
          commandId: publicationID,
          ordinal: 1,
          dispatchIntendedAt: new Date().toISOString(),
          runId: 71,
          runnerId: null,
          runnerUuid: crypto.randomUUID(),
          runnerToken: "owned-publication-runner-token",
          jobHandle: "owned-job-handle",
          runtimeAttemptId: null,
          cleanedAt: null,
        })}::jsonb,${userID})`;
    jobs = await nativeJobsFixture(database, projectID);
    const execution = jobs;
    expect(await execution.startPublication(publicationID, userID)).toBe(identity.attemptID);
    const [bound] = await database.client`
      SELECT provision.owner_id,provision.intent->'environment' AS environment,
        provision.intent->>'jobHandle' AS job, attempt.actor_uid IS NOT NULL AS actor
      FROM factory.substrate_provision provision
      JOIN factory.runtime_attempt attempt ON attempt.id=provision.runtime_attempt_id
      WHERE provision.kind IN ('staging','publication') AND provision.runtime_attempt_id=${identity.attemptID}`;
    expect(bound).toEqual({
      owner_id: publicationID,
      environment: { environment: "development", version: 0, secretKey: null },
      job: "owned-job-handle",
      actor: true,
    });
    await expect(
      (async () => {
        await database.client`INSERT INTO factory.operation(
          id,kind,scope_type,scope_id,idempotency_key,state,payload)
          VALUES(${crypto.randomUUID()},'runtime.environment_intent','runtime_attempt',${identity.attemptID},
            ${`runtime.environment_intent:${identity.attemptID}`},'recorded',
            ${JSON.stringify({
              environment: "development",
              version: 1,
              secretKey: "synthetic-development-secrets",
            })}::jsonb)`;
      })(),
    ).rejects.toThrow("operation_idempotency_key_key");
    await expect(
      database.client`UPDATE factory.operation
        SET payload=payload || ${JSON.stringify({ version: 1, secretKey: "synthetic-development-secrets" })}::jsonb
        WHERE kind='runtime.environment_intent' AND scope_type='runtime_attempt'
          AND scope_id=${identity.attemptID}`.execute(),
    ).rejects.toThrow("immutable");
    expect(
      await database.client.begin((sql) => freezeRuntimeEnvironment(sql, identity.attemptID)),
    ).toEqual({
      environment: "development",
      version: 0,
      secretKey: null,
    });
    let entered = () => {};
    const atGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let issued = 0,
      revoked = 0,
      cleanupAvailable = false;
    const store = new Map<string, ReleaseCredential>();
    const controlled = createReleaseController({
      database,
      signingKey,
      secrets: {
        configured: true,
        async read(key) {
          return store.get(key);
        },
        async create(key, value) {
          if (store.has(key)) throw new Error("CAS conflict");
          store.set(key, value);
        },
      },
      runtime: {
        async startPublication() {
          throw Error("Credential vending and End cannot commission another native publication");
        },
        async stop(id) {
          if (!cleanupAvailable) throw Error("Owned native publication cleanup is unavailable");
          await execution.stop(id);
        },
      },
      forge: {} as ReturnType<typeof createForgejoClient>,
      publication: {
        configuredAccess: true,
        async run() {
          return {
            id: 71,
            index_in_repo: 7,
            commit_sha: sha,
            event: "workflow_dispatch",
            workflow_id: "factory-release.yml",
            status: "running",
            html_url: "https://forge.example/owned",
            trigger_user: { login: "factory" },
            event_payload: JSON.stringify({
              inputs: {
                factory_release_id: publicationID,
                version: "1.2.4",
                package_owner: releasePackageOwner(projectID),
              },
            }),
          };
        },
        async attestTask() {
          entered();
          await gate;
          return true;
        },
        async versionExists() {
          return false;
        },
        async ensureMachine() {
          return 1;
        },
        async packageGrant() {},
        async issueToken() {
          issued++;
          return { id: 1, sha1: "synthetic-publication-token" };
        },
        async revokeMachine() {
          revoked++;
        },
      } as unknown as ReturnType<typeof createForgejoReleases>,
      apiURL: "https://forge.example/api/v1/",
      publicURL: "https://forge.example",
      owner: "factory",
    });
    const request = () =>
      new Request(`https://factory.example/internal/releases/${publicationID}/credentials`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${runtimePublicationToken(signingKey, publicationID)}`,
        },
      });
    const vending = controlled.credentials(request(), publicationID);
    pendingCredentials = vending;
    await atGate;
    const ending = controlled.end(userID, projectID, publicationID);
    pendingEnd = ending;
    await Bun.sleep(25);
    expect(
      (
        await database.client`SELECT ended_at FROM factory.project_release WHERE id=${publicationID}`
      )[0]?.["ended_at"],
    ).toBeNull();
    unblock();
    const response = await vending;
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("password");
    await expect(ending).rejects.toThrow("Owned native publication cleanup is unavailable");
    expect(issued).toBe(1);
    // End and credential revocation are retained even when native cleanup is
    // unavailable. Do not mark the Actor cleaned or commission another job.
    const [unsettled] = await database.client`SELECT release.ended_at IS NOT NULL AS ended,
      attempt.completed_at IS NOT NULL AS cleaned,runtime.deleted_at IS NOT NULL AS deleted
      FROM factory.project_release release
      JOIN factory.operation attempt ON attempt.kind='releases.attempt' AND attempt.scope_type='project_release'
        AND attempt.scope_id=release.id::text
      JOIN factory.runtime_attempt runtime ON runtime.id::text=attempt.payload->>'runtimeAttemptId'
      WHERE release.id=${publicationID}`;
    expect(unsettled).toEqual({ ended: true, cleaned: false, deleted: false });
    expect(
      (
        await controlled.credentials(
          new Request(request(), { headers: { authorization: `Bearer ${"é".repeat(43)}` } }),
          publicationID,
        )
      ).status,
    ).toBe(403);
    expect(revoked).toBe(1);
    expect((await controlled.credentials(request(), publicationID)).status).toBe(409);
    expect(issued).toBe(1);
    cleanupAvailable = true;
    await controlled.recover();
    expect(revoked).toBe(1);
    const [deleted] = await database.client`SELECT deleted_at IS NOT NULL AS confirmed
      FROM factory.runtime_attempt WHERE id=${identity.attemptID}`;
    expect(deleted).toEqual({ confirmed: true });
    expect(
      await database.client`SELECT id FROM factory.operation
      WHERE id=${publicationID} AND kind='releases.attempt' AND completed_at IS NOT NULL`,
    ).toHaveLength(1);
    expect(execution.calls.filter((call) => call.method === "CreateActor")).toHaveLength(1);
    expect(execution.calls.filter((call) => call.method === "DeleteActor")).toHaveLength(1);

    const artifactID = crypto.randomUUID(),
      grantID = crypto.randomUUID();
    const artifactContract = releaseContract.parse({
      schemaVersion: 1,
      files: [{ name: "client", filename: "client.txt" }],
    });
    const digest = `sha256:${"e".repeat(64)}`;
    const artifactRun = {
      id: 72,
      index_in_repo: 8,
      commit_sha: sha,
      event: "workflow_dispatch",
      workflow_id: "factory-release.yml",
      status: "success",
      html_url: "https://forge.example/owned",
      trigger_user: { login: "factory" },
      event_payload: JSON.stringify({
        inputs: {
          factory_release_id: artifactID,
          version: "1.2.5",
          package_owner: releasePackageOwner(projectID),
        },
      }),
    };
    await database.client`INSERT INTO factory.project_release(id,project_id,command_id,version,commit_sha,workflow,contract,notes,created_by)
      VALUES(${artifactID},${projectID},${artifactID},'1.2.5',${sha},'.forgejo/workflows/factory-release.yml',
        ${JSON.stringify(artifactContract)}::text::jsonb,'admitted artifact recovery',${userID})`;
    await database.client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload,created_by)
      VALUES(${artifactID},'releases.attempt','project_release',${artifactID},${`releases.attempt:${artifactID}`},
        ${`releases.attempt.ordinal:${artifactID}:1`},'pending',
        ${JSON.stringify({
          id: artifactID,
          releaseId: artifactID,
          commandId: artifactID,
          ordinal: 1,
          dispatchIntendedAt: null,
          runId: null,
          runnerId: null,
          runnerUuid: null,
          runnerToken: null,
          jobHandle: null,
          runtimeAttemptId: null,
          cleanedAt: null,
        })}::jsonb,${userID})`;
    await database.client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload,created_by)
      VALUES(${grantID},'releases.access','project',${projectID},${`releases.access:${grantID}`},
        ${`releases.access.publish:${artifactID}`},'active',
        ${JSON.stringify({
          id: grantID,
          projectId: projectID,
          commandId: grantID,
          name: "retained publisher",
          scope: "publish",
          username: `fr-${grantID}`,
          secretKey: `release-access/${projectID}/${grantID}`,
          createdBy: userID,
          releaseId: artifactID,
          revokedAt: null,
          tokenId: null,
          replacesId: null,
        })}::jsonb,${userID})`;
    store.set(`release-publish/${projectID}/${grantID}`, {
      username: `fr-${grantID}`,
      password: "synthetic-password",
      token: "synthetic-package-token",
    });
    let artifactDispatches = 0,
      nativeCreates = 0,
      createdRelease = false;
    const artifactRecovery = createReleaseController({
      database,
      signingKey: "owned-artifact-key",
      secrets: {
        configured: true,
        async read(key) {
          return store.get(key);
        },
        async create(key, value) {
          store.set(key, value);
        },
      },
      runtime: {
        async startPublication() {
          throw new Error("Must not replay the completed run");
        },
        async stop() {},
      },
      forge: {} as ReturnType<typeof createForgejoClient>,
      publication: {
        configuredAccess: true,
        async protectReleaseTags() {},
        async dispatch() {
          artifactDispatches++;
          throw new Error("Lost native dispatch response");
        },
        async runs() {
          return [
            { ...artifactRun, id: 90, trigger_user: { login: "another-human" } },
            artifactRun,
          ];
        },
        async run() {
          return artifactRun;
        },
        async genericFile() {
          return digest;
        },
        async ensureRelease(_repo: unknown, _version: string, _sha: string, body: string) {
          expect(body).toContain(digest);
          if (!createdRelease) {
            createdRelease = true;
            nativeCreates++;
            throw new Error("Lost final native response");
          }
          return "https://forge.example/releases/v1.2.5";
        },
        async revokeMachine() {},
      } as unknown as ReturnType<typeof createForgejoReleases>,
      apiURL: "https://forge.example/api/v1/",
      publicURL: "https://forge.example",
      owner: "factory",
    });
    await artifactRecovery.reconcile(userID, projectID, artifactID);
    expect(
      (
        await database.client`SELECT state FROM factory.project_release WHERE id=${artifactID}`
      )[0]?.["state"],
    ).toBe("uncertain");
    await artifactRecovery.reconcile(userID, projectID, artifactID);
    expect(
      (
        await database.client`SELECT state,failure,artifacts FROM factory.project_release WHERE id=${artifactID}`
      )[0],
    ).toMatchObject({
      state: "uncertain",
      failure:
        "Publication outcome needs reconciliation. Existing artifacts have not been rolled back.",
      artifacts: [{ kind: "file", name: "client", filename: "client.txt", digest }],
    });
    await expect(
      (async () => {
        await database.client`UPDATE factory.operation
          SET payload=jsonb_set(payload,'{runId}','91'::jsonb)
          WHERE id=${artifactID} AND kind='releases.attempt'`;
      })(),
    ).rejects.toThrow();
    await expect(
      (async () => {
        await database.client`UPDATE factory.project_release SET artifacts='[]'::jsonb WHERE id=${artifactID}`;
      })(),
    ).rejects.toThrow();
    await artifactRecovery.reconcile(userID, projectID, artifactID);
    expect(
      (
        await database.client`SELECT state FROM factory.project_release WHERE id=${artifactID}`
      )[0]?.["state"],
    ).toBe("published");
    expect(artifactDispatches).toBe(1);
    expect(nativeCreates).toBe(1);

    const accessStore = new Map<string, ReleaseCredential>();
    let readTokens = 0;
    const removed: string[] = [];
    const accessController = createReleaseController({
      database,
      signingKey: "owned-read-access-key",
      secrets: {
        configured: true,
        async read(key) {
          return accessStore.get(key);
        },
        async create(key, value) {
          accessStore.set(key, value);
        },
      },
      runtime: { async startPublication() {}, async stop() {} },
      forge: {} as ReturnType<typeof createForgejoClient>,
      publication: {
        configuredAccess: true,
        async ensureMachine() {
          return 1;
        },
        async gitGrant(_repo: unknown, username: string) {
          expect(username).toMatch(/^fr-/);
        },
        async issueToken(_repo: unknown, _username: string, _password: string, scope: string) {
          expect(scope).toBe("git");
          readTokens++;
          return { id: readTokens, sha1: `synthetic-read-token-${readTokens}` };
        },
        async revokeMachine(_repo: unknown, _owner: string, username: string) {
          removed.push(username);
        },
      } as unknown as ReturnType<typeof createForgejoReleases>,
      apiURL: "https://forge.example/api/v1/",
      publicURL: "https://forge.example",
      owner: "factory",
    });
    const readID = crypto.randomUUID(),
      rotationID = crypto.randomUUID();
    const readInput = { commandID: readID, name: "External Git reader", scope: "git" as const };
    expect((await accessController.createAccess(userID, projectID, readInput)).token).toBe(
      "synthetic-read-token-1",
    );
    expect((await accessController.createAccess(userID, projectID, readInput)).token).toBeNull();
    expect([...accessStore.values()].every((secret) => !secret.token)).toBe(true);
    await expect(
      accessController.createAccess(userID, projectID, { ...readInput, scope: "packages" }),
    ).rejects.toThrow("identity");
    const rotated = await accessController.rotateAccess(userID, projectID, readID, rotationID);
    expect(rotated.token).toBe("synthetic-read-token-2");
    expect(removed).toHaveLength(1);
    expect(
      (await accessController.rotateAccess(userID, projectID, readID, rotationID)).token,
    ).toBeNull();
    await accessController.revokeAccess(userID, projectID, rotationID);
    await accessController.revokeAccess(userID, projectID, rotationID);
    expect(readTokens).toBe(2);
    expect(removed).toHaveLength(2);
  } finally {
    unblock();
    await pendingCredentials?.catch(() => {});
    await pendingEnd?.catch(() => {});
    try {
      await jobs?.close();
      await database.client.end();
      await fixture.dispose();
    } finally {
      for (const [key, value] of previous)
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
  }
}, 60_000);
