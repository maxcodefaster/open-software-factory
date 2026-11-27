import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { operation, projectRelease } from "#db/schema";
import type { createForgejoClient } from "#forge/forge";
import type { createForgejoReleases } from "#forge/releases";
import { releaseContract } from "#project-domain/release";
import { CommandError } from "../../apps/factory/src/command-error";
import { createReleaseController } from "../../apps/factory/src/releases/controller";
import type { ReleaseCredential } from "../../apps/factory/src/releases/secrets";
import { publicationWorkflow } from "../../apps/factory/src/releases/workflow";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { nativeJobsFixture } from "../fixtures/native-jobs";

async function releaseStoreFixture() {
  const fixture = await factoryProcess();
  const database = fixture.connect();
  const userID = crypto.randomUUID();
  const projectID = crypto.randomUUID();
  const otherProjectID = crypto.randomUUID();
  try {
    await database.client`INSERT INTO auth."user"(id,name,email,email_verified)
      VALUES(${userID},'Release store proof',${`${userID}@factory.invalid`},true)`;
    for (const id of [projectID, otherProjectID]) {
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,actor_template_path,created_by)
        VALUES(${id},${`release-store-${id}`},'Release store proof','https://forge.example/factory/project.git',
          'main','.factory/actor-template.json',${userID})`;
      await database.client`INSERT INTO factory.project_membership(project_id,user_id,role,manage_project,updated_by)
        VALUES(${id},${userID},'developer',true,${userID})`;
    }
    return {
      database,
      userID,
      projectID,
      otherProjectID,
      options: {
        database,
        signingKey: "owned-release-store-signing-key",
        apiURL: "https://forge.example/api/v1/",
        publicURL: "https://forge.example",
        owner: "factory",
      },
      async close() {
        try {
          await database.client.end();
        } finally {
          await fixture.dispose();
        }
      },
    };
  } catch (cause) {
    await database.client.end();
    await fixture.dispose();
    throw cause;
  }
}

test("release admission commits frozen intent before dispatch and rolls back conflicting inserts", async () => {
  const f = await releaseStoreFixture();
  const previousOrigin = process.env["FACTORY_FORGEJO_PUBLIC_URL"];
  let jobs: Awaited<ReturnType<typeof nativeJobsFixture>> | undefined;
  const gate = Promise.withResolvers<void>();
  let controller: ReturnType<typeof createReleaseController> | undefined;
  let releaseID: string | undefined;
  const sha = "b".repeat(40);
  const command = {
    commandID: crypto.randomUUID(),
    commitSHA: sha,
    version: "2.0.0",
    notes: "Frozen notes",
  };
  const contract = releaseContract.parse({
    schemaVersion: 1,
    files: [{ name: "client", filename: "client.txt" }],
  });
  let dispatches = 0;
  let atDispatch = false;
  let configurations = 0;
  let head = sha;
  const runnerID = 4_294_967_299;
  const removed: number[] = [];
  try {
    process.env["FACTORY_FORGEJO_PUBLIC_URL"] = "https://forge.example";
    const ticketID = crypto.randomUUID(),
      revisionID = crypto.randomUUID(),
      approvalID = crypto.randomUUID(),
      changeID = crypto.randomUUID();
    const canonical = JSON.stringify({
      summary: "Retained delivered source for release admission",
    });
    await f.database.client.begin(async (sql) => {
      await sql`INSERT INTO factory.ticket(id,project_id,title,created_by)
        VALUES(${ticketID},${f.projectID},'Release source',${f.userID})`;
      await sql`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by)
        VALUES(${revisionID},${ticketID},1,${canonical},${createHash("sha256").update(canonical).digest("hex")},${f.userID})`;
      await sql`INSERT INTO factory.requirement_approval(id,ticket_id,requirement_revision_id,approved_by)
        VALUES(${approvalID},${ticketID},${revisionID},${f.userID})`;
      await sql`INSERT INTO factory.change(id,project_id,ticket_id,requirement_approval_id,branch_name,base_sha,state,created_by)
        VALUES(${changeID},${f.projectID},${ticketID},${approvalID},
          ${`factory/change-${changeID.replaceAll("-", "").slice(0, 12)}`},${sha},'active',${f.userID})`;
      await sql`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,state,payload)
        VALUES(${crypto.randomUUID()},'delivery.staging_preview','project',${f.projectID},
          ${`delivery.staging_preview:${f.projectID}`},'pending',
          ${JSON.stringify({ projectId: f.projectID, revision: sha, runtimeAttemptId: null })}::jsonb)`;
    });
    jobs = await nativeJobsFixture(f.database, f.projectID);
    const staging = await jobs.startStaging(f.userID);
    await f.database.client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${staging}`;
    controller = createReleaseController({
      ...f.options,
      secrets: {
        configured: true,
        async read() {
          return undefined;
        },
        async create() {},
      },
      runtime: {
        async startPublication() {
          throw Error("No publication runtime before a confirmed dispatch");
        },
        async stop() {},
      },
      forge: {
        async getDefaultBranch() {
          return { headSha: head };
        },
        async getOptionalFile(_repo: unknown, path: string, commit: string) {
          expect(commit).toBe(sha);
          if (path === publicationWorkflow)
            return Bun.file("templates/release/factory-release.yml").text();
          configurations++;
          return JSON.stringify(contract);
        },
        async deleteRunner(_repo: unknown, id: number) {
          removed.push(id);
        },
      } as unknown as ReturnType<typeof createForgejoClient>,
      publication: {
        configuredAccess: true,
        async protectReleaseTags() {},
        async dispatch(_repo: unknown, commit: string, attemptID: string) {
          dispatches++;
          const [intent] = await f.database.db
            .select()
            .from(projectRelease)
            .where(eq(projectRelease.id, attemptID));
          const [attempt] = await f.database.db
            .select()
            .from(operation)
            .where(and(eq(operation.id, attemptID), eq(operation.kind, "releases.attempt")));
          expect(intent).toMatchObject({
            commandId: command.commandID,
            commitSha: commit,
            contract,
            notes: command.notes,
            workflow: publicationWorkflow,
            state: "dispatching",
          });
          expect(attempt?.payload).toMatchObject({
            releaseId: attemptID,
            commandId: command.commandID,
            ordinal: 1,
          });
          expect(typeof attempt?.payload["dispatchIntendedAt"]).toBe("string");
          atDispatch = true;
          await gate.promise;
          throw Error("Lost dispatch acknowledgement");
        },
        async runs() {
          return [];
        },
      } as unknown as ReturnType<typeof createForgejoReleases>,
    });
    await expect(controller.publish(f.userID, f.projectID, command)).rejects.toThrow("Staging");
    // Retained delivered projection. The staging owner still creates its own bound runtime.
    await f.database
      .client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,state,payload,completed_at)
      VALUES(${crypto.randomUUID()},'delivery.promotion','change',${changeID},
        ${`delivery.promotion:${changeID}:1`},'succeeded',
        ${JSON.stringify({
          changeId: changeID,
          projectId: f.projectID,
          commitSha: sha,
          previousRuntimeAttemptId: null,
          replacementRuntimeAttemptId: null,
          ordinal: 1,
          supersedesId: null,
          retryCommandId: null,
        })}::jsonb,now())`;
    head = "c".repeat(40);
    await expect(controller.publish(f.userID, f.projectID, command)).rejects.toThrow("Staging");
    head = sha;
    const accepted = await controller.publish(f.userID, f.projectID, command);
    releaseID = accepted.id;
    await eventually(
      async () => atDispatch,
      Boolean,
      "Publication did not observe its saved dispatch intent",
    );
    expect(await controller.publish(f.userID, f.projectID, command)).toEqual(accepted);
    expect(configurations).toBe(1);
    for (const changed of [
      { ...command, notes: "Changed notes" },
      { ...command, version: "2.0.1" },
      { ...command, commitSHA: "c".repeat(40) },
    ])
      await expect(controller.publish(f.userID, f.projectID, changed)).rejects.toThrow("identity");
    await expect(controller.publish(f.userID, f.otherProjectID, command)).rejects.toThrow(
      "identity",
    );
    const conflict = await controller
      .publish(f.userID, f.projectID, {
        ...command,
        commandID: crypto.randomUUID(),
        version: "2.0.1",
      })
      .catch((cause: unknown) => cause);
    expect(conflict).toBeInstanceOf(CommandError);
    expect(conflict).toMatchObject({ code: "conflict" });
    expect(await f.database.db.select().from(projectRelease)).toHaveLength(1);
    expect(
      await f.database.db.select().from(operation).where(eq(operation.kind, "releases.attempt")),
    ).toHaveLength(1);
    gate.resolve();
    await controller.reconcile(f.userID, f.projectID, accepted.id);
    expect((await controller.view(f.userID, f.projectID)).releases[0]).toMatchObject({
      id: accepted.id,
      state: "uncertain",
      commitSHA: sha,
      notes: command.notes,
      artifacts: [],
      publishedAt: null,
      endedAt: null,
      runURL: null,
      releaseURL: null,
    });
    expect(dispatches).toBe(1);

    // The newest ordinal owns cleanup, even when an older attempt remains retained.
    const nextAttemptID = crypto.randomUUID();
    await f.database
      .client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,active_key,state,payload,created_by)
      VALUES(${nextAttemptID},'releases.attempt','project_release',${accepted.id},
        ${`releases.attempt:${nextAttemptID}`},${`releases.attempt.ordinal:${accepted.id}:2`},'pending',
        ${JSON.stringify({
          id: nextAttemptID,
          releaseId: accepted.id,
          commandId: nextAttemptID,
          ordinal: 2,
          dispatchIntendedAt: null,
          runId: null,
          runnerId: runnerID,
          runnerUuid: "owned-runner",
          runnerToken: "owned-token",
          jobHandle: null,
          runtimeAttemptId: null,
          cleanedAt: null,
        })}::jsonb,${f.userID})`;
    await controller.end(f.userID, f.projectID, accepted.id);
    const [ended] = await f.database.db
      .select()
      .from(projectRelease)
      .where(eq(projectRelease.id, accepted.id));
    await controller.end(f.userID, f.projectID, accepted.id);
    const [again] = await f.database.db
      .select()
      .from(projectRelease)
      .where(eq(projectRelease.id, accepted.id));
    expect(again?.endedAt).toEqual(ended?.endedAt);
    expect(again?.state).toBe("uncertain");
    expect(removed).toEqual([runnerID, runnerID]);
    const [latest] = await f.database.db
      .select()
      .from(operation)
      .where(and(eq(operation.id, nextAttemptID), eq(operation.kind, "releases.attempt")));
    expect(latest?.completedAt).toBeInstanceOf(Date);
    expect(latest?.payload["runnerToken"]).toBeNull();
    const [older] = await f.database.db
      .select()
      .from(operation)
      .where(and(eq(operation.id, accepted.id), eq(operation.kind, "releases.attempt")));
    expect(older?.completedAt).toBeNull();
    const reusedVersion = await controller
      .publish(f.userID, f.projectID, {
        ...command,
        commandID: crypto.randomUUID(),
      })
      .catch((cause: unknown) => cause);
    expect(reusedVersion).toBeInstanceOf(CommandError);
    expect(reusedVersion).toMatchObject({ code: "conflict" });
    expect(await f.database.db.select().from(projectRelease)).toHaveLength(1);
    expect(
      await f.database.db.select().from(operation).where(eq(operation.kind, "releases.attempt")),
    ).toHaveLength(2);
  } finally {
    gate.resolve();
    try {
      if (controller && releaseID) await controller.reconcile(f.userID, f.projectID, releaseID);
    } finally {
      await jobs?.close();
      await f.close();
      if (previousOrigin === undefined) delete process.env["FACTORY_FORGEJO_PUBLIC_URL"];
      else process.env["FACTORY_FORGEJO_PUBLIC_URL"] = previousOrigin;
    }
  }
}, 60_000);

test("release access retains revocation intent after a lost native response and never leaks across projects", async () => {
  const f = await releaseStoreFixture();
  const secrets = new Map<string, ReleaseCredential>();
  const id = crypto.randomUUID();
  const input = { commandID: id, name: "Package reader", scope: "packages" as const };
  let issued = 0,
    revoked = 0,
    loseRevocation = true;
  const controller = createReleaseController({
    ...f.options,
    secrets: {
      configured: true,
      async read(key) {
        return secrets.get(key);
      },
      async create(key, value) {
        secrets.set(key, value);
        throw Error("Lost immutable secret acknowledgement");
      },
    },
    runtime: { async startPublication() {}, async stop() {} },
    forge: {} as ReturnType<typeof createForgejoClient>,
    publication: {
      configuredAccess: true,
      async ensureMachine(username: string) {
        expect(username).toBe(`fr-${id.replaceAll("-", "")}`);
        const [intent] = await f.database.db
          .select()
          .from(operation)
          .where(and(eq(operation.id, id), eq(operation.kind, "releases.access")));
        expect(intent?.state).toBe("pending");
        expect(intent?.payload).toMatchObject({ commandId: id, scope: "packages" });
      },
      async packageGrant(_owner: string, _username: string, publish: boolean) {
        expect(publish).toBe(false);
      },
      async issueToken() {
        issued++;
        return { id: 4_294_967_298, sha1: "synthetic-package-read-token" };
      },
      async revokeMachine() {
        revoked++;
        const [intent] = await f.database.db
          .select()
          .from(operation)
          .where(and(eq(operation.id, id), eq(operation.kind, "releases.access")));
        expect(intent?.state).toBe("revoking");
        if (loseRevocation) throw Error("Lost revocation acknowledgement");
      },
    } as unknown as ReturnType<typeof createForgejoReleases>,
  });
  try {
    expect((await controller.createAccess(f.userID, f.projectID, input)).token).toBe(
      "synthetic-package-read-token",
    );
    const [active] = await f.database.db
      .select()
      .from(operation)
      .where(and(eq(operation.id, id), eq(operation.kind, "releases.access")));
    expect(active?.state).toBe("active");
    expect(active?.payload["tokenId"]).toBe(4_294_967_298);
    expect(await controller.createAccess(f.userID, f.projectID, input)).toMatchObject({
      id,
      token: null,
    });
    expect(issued).toBe(1);
    await expect(controller.createAccess(f.userID, f.otherProjectID, input)).rejects.toThrow(
      "identity",
    );
    await expect(controller.revokeAccess(f.userID, f.otherProjectID, id)).rejects.toThrow(
      "not found",
    );
    await expect(
      controller.rotateAccess(f.userID, f.otherProjectID, id, crypto.randomUUID()),
    ).rejects.toThrow("not found");
    expect((await controller.view(f.userID, f.otherProjectID)).access).toEqual([]);
    const view = await controller.view(f.userID, f.projectID);
    expect(view.access).toHaveLength(1);
    expect(view.access[0]?.createdAt).toEqual(
      (
        await f.database.client`
      SELECT created_at::text AS created FROM factory.operation WHERE id=${id} AND kind='releases.access'`
      )[0]?.["created"],
    );
    expect(view.access[0]).not.toHaveProperty("tokenId");
    await expect(controller.revokeAccess(f.userID, f.projectID, id)).rejects.toThrow(
      "Lost revocation",
    );
    const [unconfirmed] = await f.database.db
      .select()
      .from(operation)
      .where(and(eq(operation.id, id), eq(operation.kind, "releases.access")));
    expect(unconfirmed).toMatchObject({ state: "revoking", completedAt: null });
    loseRevocation = false;
    await controller.recover();
    await eventually(
      async () =>
        (
          await f.database.db
            .select()
            .from(operation)
            .where(and(eq(operation.id, id), eq(operation.kind, "releases.access")))
        )[0]?.state,
      (state) => state === "revoked",
      "Access revocation did not settle",
    );
    expect(revoked).toBe(2);
    await controller.recover();
    expect(revoked).toBe(2);
    expect([...secrets.values()].every((credential) => !credential.token)).toBe(true);
  } finally {
    await f.close();
  }
}, 60_000);

test("release history keeps its project, row limit, timestamp strings and last-published tie break", async () => {
  const f = await releaseStoreFixture();
  const controller = createReleaseController({
    ...f.options,
    secrets: {
      configured: false,
      async read() {
        return undefined;
      },
      async create() {},
    },
    runtime: { async startPublication() {}, async stop() {} },
    forge: {} as ReturnType<typeof createForgejoClient>,
    publication: { configuredAccess: false } as ReturnType<typeof createForgejoReleases>,
  });
  try {
    const rows = Array.from({ length: 106 }, (_, ordinal) => ({
      id: `00000000-0000-4000-8000-${ordinal.toString().padStart(12, "0")}`,
      commandId: crypto.randomUUID(),
      projectId: f.projectID,
      version: `1.0.${ordinal}`,
      commitSha: "a".repeat(40),
      notes: `Retained release ${ordinal}`,
      createdBy: f.userID,
      state: ordinal === 105 ? ("failed" as const) : ("published" as const),
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ordinal)),
      publishedAt:
        ordinal >= 103 && ordinal < 105
          ? new Date(Date.UTC(2026, 0, 2))
          : ordinal === 105
            ? null
            : new Date(Date.UTC(2026, 0, 1, 0, 0, ordinal)),
    }));
    await f.database.db.insert(projectRelease).values(rows);
    await f.database.db.insert(projectRelease).values({
      id: crypto.randomUUID(),
      commandId: crypto.randomUUID(),
      projectId: f.otherProjectID,
      version: "99.0.0",
      commitSha: "c".repeat(40),
      notes: "Other project",
      createdBy: f.userID,
      state: "published",
      publishedAt: new Date(Date.UTC(2026, 0, 3)),
    });
    const view = await controller.view(f.userID, f.projectID);
    expect(view.releases).toHaveLength(100);
    expect(view.releases.map((release) => release.version)).toEqual(
      rows
        .slice(6)
        .reverse()
        .map((row) => row.version),
    );
    expect(view.lastVersion).toBe("1.0.104");
    expect(view.suggestions.patch).toBe("1.0.105");
    const first = view.releases[0];
    expect(first?.publishedAt).toBeNull();
    expect(first?.endedAt).toBeNull();
    expect(first?.createdAt).toEqual(
      (
        await f.database.client`
      SELECT created_at::text AS created FROM factory.project_release WHERE id=${first?.id ?? ""}`
      )[0]?.["created"],
    );
    expect(view.releases.some((release) => release.notes === "Other project")).toBe(false);
  } finally {
    await f.close();
  }
}, 60_000);
