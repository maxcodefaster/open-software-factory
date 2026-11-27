import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { substrateProvision } from "#db/schema";
import { runtimeIdentity } from "#runtime-domain/identity";
import { type SubstrateCall, SubstrateRPCError } from "#runtime-kubernetes/substrate-control";
import { createSubstrateIsolated } from "../../apps/factory/src/runtime/substrate-isolated";
import { substrateStagingOwner } from "../../apps/factory/src/runtime/substrate-isolated-grant";
import { createSubstrateVerification } from "../../apps/factory/src/runtime/substrate-verification";
import type { SubstrateWorkspaceConfiguration } from "../../apps/factory/src/runtime/substrate-workspaces";
import { nativeProjectTemplate } from "../fixtures/native-project";
import { substrateFixture } from "../fixtures/substrate";

async function provisioningFixture(kind: "verification" | "isolated") {
  const f = await substrateFixture("a".repeat(40), "ticket");
  const directory = await mkdtemp(join(tmpdir(), "bound-provisioning-"));
  const ca = join(directory, "ca.pem");
  await writeFile(ca, "-----BEGIN CERTIFICATE-----\nowned-test\n-----END CERTIFICATE-----\n");
  const priorPublicURL = process.env["FACTORY_FORGEJO_PUBLIC_URL"];
  process.env["FACTORY_FORGEJO_PUBLIC_URL"] = "https://git.native.test";
  const ownerID = kind === "isolated" ? substrateStagingOwner(f.projectID) : crypto.randomUUID();
  const attemptID = runtimeIdentity(ownerID, 1).attemptID;
  const atespace = `fa-${attemptID.replaceAll("-", "")}`;
  const table = substrateProvision;
  const config: SubstrateWorkspaceConfiguration = {
    deployment: "owned-test",
    database: f.config.database,
    projectID: f.projectID,
    connection: f.config.connection,
    provisioner: { ...f.config.connection, tokenFile: "/owned-provisioner" },
    editorPrincipal: "user:system:serviceaccount:owned:factory-control",
    connectorURL: f.config.connectorURL,
    factoryCAFile: ca,
    workloadImage: `registry.test/native@sha256:${"a".repeat(64)}`,
    profile: f.config.profile,
    runtime: f.config.runtime,
    workerSelector: {
      "factory.runtime/profile": f.config.profile,
      "factory.dev/deployment": "owned-bound-provisioning",
    },
    egressHosts: ["registry.test", "git.native.test"],
  };
  if (kind === "verification") {
    await f.database.client`UPDATE factory.project
      SET repository_url='http://127.0.0.1:1/owned/verification.git' WHERE id=${f.projectID}`;
    await f.database
      .client`INSERT INTO factory.verification(id,change_id,commit_sha,pull_request_number,action_run_id,runner_uuid,runner_token,runner_job_handle,created_by)
      VALUES(${ownerID},${f.changeID},${"a".repeat(40)},1,1,${crypto.randomUUID()},'owned-token','owned-exact-job',${f.userID})`;
  } else {
    await f.database
      .client`INSERT INTO factory.operation(id,kind,scope_type,scope_id,idempotency_key,state,payload)
      VALUES(${crypto.randomUUID()},'delivery.staging_preview','project',${f.projectID},
        ${`delivery.staging_preview:${f.projectID}`},'pending',
        ${JSON.stringify({ projectId: f.projectID, revision: "a".repeat(40), runtimeAttemptId: null })}::jsonb)`;
  }
  const identity = eq(table.runtimeAttemptId, attemptID);
  const facts = async () => (await f.database.db.select().from(table).where(identity))[0];
  const objects = new Map<string, Record<string, unknown>>();
  const creates = new Map<string, number>();
  const calls: { role: string; method: string }[] = [];
  let lose: string | undefined;
  let reject: string | undefined;
  let held:
    | {
        method: string;
        entered: ReturnType<typeof Promise.withResolvers<void>>;
        release: ReturnType<typeof Promise.withResolvers<void>>;
      }
    | undefined;
  const call =
    (role: "owner" | "editor"): SubstrateCall =>
    async (method, input) => {
      calls.push({ role, method });
      const nativeKind = method.replace(/^(Get|Create)/, "");
      if (method === "GetActor") throw new Error("owned Actor lifecycle boundary");
      if (method.startsWith("Get")) {
        const value = objects.get(nativeKind);
        if (!value) throw new SubstrateRPCError("NotFound", "owned absent");
        return structuredClone(value);
      }
      expect(["CreateAtespace", "CreateAtespaceAccessPolicy", "CreateActorTemplate"]).toContain(
        method,
      );
      expect(role).toBe(method === "CreateActorTemplate" ? "editor" : "owner");
      const saved = await facts();
      expect(saved?.runtimeAttemptId).toBe(attemptID);
      const attempted =
        nativeKind === "Atespace"
          ? saved?.resources.atespace?.attemptedAt
          : nativeKind === "AtespaceAccessPolicy"
            ? saved?.resources.policy?.attemptedAt
            : saved?.resources.template?.attemptedAt;
      expect(typeof attempted).toBe("string");
      expect(Number.isNaN(Date.parse(attempted ?? ""))).toBe(false);
      // The committed dispatch fact must be visible from a different DB session
      // before any external Create, including after retrying a lost reply.
      creates.set(nativeKind, (creates.get(nativeKind) ?? 0) + 1);
      if (held?.method === method) {
        held.entered.resolve();
        await held.release.promise;
      }
      if (method === reject) throw new SubstrateRPCError("AlreadyExists", "owned rejected Create");
      const request = input as Record<string, Record<string, unknown>>;
      const spec =
        nativeKind === "Atespace"
          ? request["atespace"]
          : nativeKind === "AtespaceAccessPolicy"
            ? request["accessPolicy"]
            : request["actorTemplate"];
      const [clock] = await f.database.client<
        { at: string }[]
      >`SELECT clock_timestamp()::text AS at`;
      if (!clock || !spec) throw new Error("Owned native create input/clock unavailable");
      const value = {
        ...spec,
        metadata: {
          ...(spec["metadata"] as object),
          uid: crypto.randomUUID(),
          version: "1",
          createTime: new Date(clock.at).toISOString(),
        },
      };
      objects.set(nativeKind, value);
      if (method === lose) {
        lose = undefined;
        throw new SubstrateRPCError("Unavailable", "owned lost Create reply");
      }
      return structuredClone(value);
    };
  const owner = call("owner");
  const editor = call("editor");
  const readConfiguration = async (repository: string, revision: string, path: string) => {
    expect(repository).toBe(
      kind === "verification"
        ? "http://127.0.0.1:1/owned/verification.git"
        : "https://example.invalid/fixture.git",
    );
    expect(revision).toBe("a".repeat(40));
    expect(path).toBe(nativeProjectTemplate.path);
    return { systemContract: null, actorTemplate: nativeProjectTemplate };
  };
  const create = (selected = config) => {
    if (kind === "verification") {
      const runtime = createSubstrateVerification(
        f.database,
        f.hub,
        "owned-secret",
        selected,
        editor,
        owner,
        undefined,
        undefined,
        readConfiguration,
      );
      return { start: () => runtime.start(ownerID, f.userID), forAttempt: runtime.forAttempt };
    }
    const runtime = createSubstrateIsolated(
      f.database,
      f.hub,
      "owned-secret",
      selected,
      async () => ({
        version: 1,
        primaryApp: "web",
        apps: [
          { id: "web", label: "Web", port: 4300, healthPath: "/", command: ["node", "app.mjs"] },
        ],
      }),
      editor,
      owner,
      undefined,
      undefined,
      readConfiguration,
    );
    return { start: () => runtime.stage(f.userID), forAttempt: runtime.forAttempt };
  };
  return {
    f,
    table,
    identity,
    facts,
    objects,
    creates,
    calls,
    config,
    create,
    ownerID,
    attemptID,
    atespace,
    lose(method: string) {
      lose = method;
    },
    reject(method: string) {
      reject = method;
    },
    hold(method: string) {
      held = {
        method,
        entered: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      return held;
    },
    async dispose() {
      held?.release.resolve();
      f.hub.revoke(attemptID);
      await f.dispose();
      await rm(directory, { recursive: true, force: true });
      if (priorPublicURL === undefined) delete process.env["FACTORY_FORGEJO_PUBLIC_URL"];
      else process.env["FACTORY_FORGEJO_PUBLIC_URL"] = priorPublicURL;
    },
  };
}

test.each(["verification", "isolated"] as const)(
  "%s Drizzle provisioning retains lost replies, scoped observation and immutable dispatch/identity",
  async (kind) => {
    const owned = await provisioningFixture(kind);
    try {
      const runtime = owned.create();
      for (const method of [
        "CreateAtespace",
        "CreateAtespaceAccessPolicy",
        "CreateActorTemplate",
      ]) {
        owned.lose(method);
        await expect(runtime.start()).rejects.toThrow("owned lost Create reply");
        const row = await owned.facts();
        expect(row?.generation).toBe(1);
        expect([
          row?.resources.atespace?.rejected ?? false,
          row?.resources.policy?.rejected ?? false,
          row?.resources.template?.rejected ?? false,
        ]).toEqual([false, false, false]);
      }
      await expect(runtime.start()).rejects.toThrow("owned Actor lifecycle boundary");
      const row = await owned.facts();
      expect(await owned.f.database.db.select().from(owned.table)).toHaveLength(1);
      expect(row?.resources.atespace?.value).toEqual(owned.objects.get("Atespace"));
      expect(row?.resources.policy?.value).toEqual(owned.objects.get("AtespaceAccessPolicy"));
      expect(row?.resources.template?.value).toEqual({
        metadata: owned.objects.get("ActorTemplate")?.["metadata"],
      });
      expect([...owned.creates.values()]).toEqual([1, 1, 1]);
      expect(owned.calls).toContainEqual({ role: "owner", method: "GetAtespaceAccessPolicy" });
      expect(owned.calls).toContainEqual({ role: "editor", method: "GetAtespace" });
      expect(await runtime.forAttempt(crypto.randomUUID())).toBeUndefined();
      expect(await runtime.forAttempt(owned.attemptID)).toBeDefined();
      for (const changes of [
        { intent: { changed: true } },
        { runtimeAttemptId: crypto.randomUUID() },
        {
          resources: sql`jsonb_set(${owned.table.resources}, '{atespace,attemptedAt}', to_jsonb(now()))`,
        },
        {
          resources: sql`jsonb_set(${owned.table.resources}, '{atespace,value}', ${JSON.stringify({ metadata: { uid: crypto.randomUUID() } })}::text::jsonb)`,
        },
      ]) {
        await expect(
          owned.f.database.db.update(owned.table).set(changes).where(owned.identity).execute(),
        ).rejects.toMatchObject({ cause: { message: expect.stringContaining("immutable") } });
      }
      const changedConfig = {
        ...owned.config,
        editorPrincipal: "user:system:serviceaccount:owned:foreign",
      };
      await expect(owned.create(changedConfig).start()).rejects.toThrow("configuration differs");
      const original = structuredClone(owned.objects.get("Atespace"));
      if (!original) throw new Error("Owned Atespace missing");
      owned.objects.set("Atespace", {
        ...original,
        metadata: { ...(original["metadata"] as object), uid: crypto.randomUUID() },
      });
      await expect(runtime.start()).rejects.toThrow("original identity");
      expect([...owned.creates.values()]).toEqual([1, 1, 1]);
    } finally {
      await owned.dispose();
    }
  },
);
test.each(["verification", "isolated"] as const)(
  "%s concurrent provisioning waits on the same owned PostgreSQL lock after lost Create",
  async (kind) => {
    const owned = await provisioningFixture(kind);
    const held = owned.hold("CreateAtespace");
    owned.lose("CreateAtespace");
    const first = owned
      .create()
      .start()
      .catch((error: unknown) => error);
    let second: Promise<unknown> | undefined;
    try {
      const entered = await Promise.race([
        held.entered.promise.then(() => true),
        first.then(() => false),
      ]);
      expect(entered).toBe(true);
      second = owned
        .create()
        .start()
        .catch((error: unknown) => error);
      const deadline = Date.now() + 3000;
      let contended = false;
      while (Date.now() < deadline) {
        const [activity] = await owned.f.database.client<{ waiting: boolean }[]>`
          SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock'
              AND query LIKE '%pg_advisory_lock%') AS waiting`;
        if (activity?.waiting) {
          contended = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(contended).toBe(true);
      expect(owned.creates.get("Atespace")).toBe(1);
      held.release.resolve();
      expect(await first).toMatchObject({ message: "owned lost Create reply" });
      expect(await second).toMatchObject({ message: "owned Actor lifecycle boundary" });
      expect([...owned.creates.values()]).toEqual([1, 1, 1]);
      expect(await owned.f.database.db.select().from(owned.table)).toHaveLength(1);
    } finally {
      held.release.resolve();
      await Promise.all([first, second]);
      await owned.dispose();
    }
  },
);
test.each(["verification", "isolated"] as const)(
  "%s rejected Create never adopts a foreign native resource",
  async (kind) => {
    const owned = await provisioningFixture(kind);
    try {
      const runtime = owned.create();
      owned.reject("CreateAtespace");
      await expect(runtime.start()).rejects.toThrow("owned rejected Create");
      expect((await owned.facts())?.resources.atespace?.rejected).toBe(true);
      owned.objects.set("Atespace", {
        metadata: {
          name: owned.atespace,
          uid: crypto.randomUUID(),
          version: "1",
          createTime: new Date().toISOString(),
        },
      });
      await expect(runtime.start()).rejects.toThrow("foreign resources are never adopted");
      expect(owned.creates.get("Atespace")).toBe(1);
      expect((await owned.facts())?.resources.atespace?.value ?? null).toBeNull();
      await expect(
        owned.f.database.db
          .update(owned.table)
          .set({
            resources: sql`jsonb_set(${owned.table.resources}, '{atespace,rejected}', 'false'::jsonb)`,
          })
          .where(owned.identity)
          .execute(),
      ).rejects.toMatchObject({ cause: { message: expect.stringContaining("immutable") } });
    } finally {
      await owned.dispose();
    }
  },
);
