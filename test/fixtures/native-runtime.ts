import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeConnectorTokens } from "#runtime-domain/identity";
import {
  nativeActor,
  type SubstrateCall,
  SubstrateRPCError,
} from "#runtime-kubernetes/substrate-control";
import { personalWorkspaceIdentity } from "#workspace-domain/workspace";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import type { SubstrateInstallationConfiguration } from "../../apps/factory/src/runtime/substrate-workspaces";
import type { SubstrateSourceHandoff } from "../../apps/factory/src/workspace/source-api";
import { nativeProjectTemplate } from "./native-project";
import { substrateFixture } from "./substrate";

// Actual Factory owners/PostgreSQL with controlled official RPC responses.
// This creates no Substrate resource and is not native runtime acceptance.
export async function nativeRuntimeFixture(
  kind: "personal" | "ticket" = "personal",
  contract = true,
) {
  const directory = await mkdtemp(join(tmpdir(), "factory-native-runtime-"));
  const repository = join(directory, "repository");
  await Bun.$`git init -b main ${repository}`.quiet();
  await writeFile(join(repository, "README"), "Owned native Runtime fixture\n");
  await mkdir(join(repository, ".factory"));
  await writeFile(join(repository, nativeProjectTemplate.path), nativeProjectTemplate.content);
  if (contract) {
    await writeFile(
      join(repository, ".factory/system.json"),
      JSON.stringify({
        version: 1,
        primaryApp: "web",
        apps: [
          { id: "web", label: "Website", command: ["node", "web.js"], port: 4321, healthPath: "/" },
          {
            id: "editor",
            label: "Editor",
            command: ["node", "editor.js"],
            port: 3002,
            healthPath: "/",
          },
          { id: "api", label: "API", command: ["node", "api.js"], port: 3001, healthPath: "/" },
        ],
      }),
    );
  }
  await Bun.$`git -C ${repository} add .`.quiet();
  await Bun.$`git -C ${repository} -c user.name=Owned -c user.email=owned@example.invalid commit -m initial`.quiet();
  const revision = (await Bun.$`git -C ${repository} rev-parse HEAD`.text()).trim();
  const f = await substrateFixture(revision, kind);
  const previousSecret = process.env["FACTORY_AUTH_SECRET"];
  const signingSecret = "owned-native-runtime-private-signing-secret-0123456789";
  process.env["FACTORY_AUTH_SECRET"] = signingSecret;
  type SourceSQL = Parameters<SubstrateSourceHandoff["attach"]>[2];
  const controlledWorkspaces = new Set([
    f.workspaceID,
    personalWorkspaceIdentity(f.projectID, f.userID).workspaceID,
  ]);
  async function requireIndependentSource(workspaceID: string, sql: SourceSQL) {
    if (!controlledWorkspaces.has(workspaceID)) throw Error("Foreign controlled Source Workspace");
    const [source] = await sql`
      SELECT workspace_id FROM factory.substrate_source
      WHERE workspace_id=${workspaceID} AND owner='service' AND writable
        AND actor_uid IS NULL AND service_base IS NOT NULL
        AND seed->>'projectID'=${f.projectID} AND seed->>'revision'=${revision}`;
    if (!source) throw Error("Owned controlled Source seed is unavailable");
  }
  async function requireSourceActor(workspaceID: string, actorUID: string, sql: SourceSQL) {
    await requireIndependentSource(workspaceID, sql);
    const [actor] = await sql`
      SELECT attempt.id FROM factory.runtime_attempt attempt
      WHERE attempt.workspace_id=${workspaceID} AND attempt.project_id=${f.projectID}
        AND attempt.actor_uid=${actorUID}`;
    if (!actor) throw Error("Foreign controlled Source Actor");
  }
  async function requireSourceAttempt(workspaceID: string, attemptID: string, sql: SourceSQL) {
    await requireIndependentSource(workspaceID, sql);
    const [attempt] = await sql`
      SELECT id FROM factory.runtime_attempt
      WHERE id=${attemptID} AND workspace_id=${workspaceID} AND project_id=${f.projectID}`;
    if (!attempt) throw Error("Foreign controlled Source Runtime Attempt");
  }
  // These controller fixtures leave their admitted seed independently owned.
  // Model only the explicit handoff boundary, never start the real Linux Source
  // service or claim that a controlled Actor imported/restored checkout bytes.
  const sources: SubstrateSourceHandoff = {
    attach: requireSourceActor,
    freezeActor: requireSourceAttempt,
    makeIndependent: requireIndependentSource,
    resume: requireSourceAttempt,
    requireIndependent: requireSourceActor,
  };
  const ca = join(directory, "ca.pem");
  await writeFile(
    ca,
    "-----BEGIN CERTIFICATE-----\nowned-controller-ca\n-----END CERTIFICATE-----\n",
  );
  await f.database
    .client`UPDATE factory.project SET repository_url=${`file://${repository}`} WHERE id=${f.projectID}`;
  if (kind === "ticket")
    await f.database.client`UPDATE factory.change_writer
    SET state='human',user_id=${f.userID},epoch=2 WHERE change_id=${f.changeID}`;
  const configuration: SubstrateInstallationConfiguration = {
    deployment: "owned-test",
    database: f.config.database,
    connection: f.config.connection,
    provisioner: { ...f.config.connection, tokenFile: "/owned/native-owner" },
    editorPrincipal: "user:system:serviceaccount:owned:factory-control",
    connectorURL: f.config.connectorURL,
    factoryCAFile: ca,
    workloadImage: `registry.test/native@sha256:${"a".repeat(64)}`,
    profile: f.config.profile,
    runtime: f.config.runtime,
    workerSelector: {
      "factory.runtime/profile": f.config.profile,
      "factory.dev/deployment": "owned",
    },
    egressHosts: [],
  };
  const resources = new Map<string, Map<string, Record<string, unknown>>>();
  const calls: { method: string; scope: string }[] = [];
  let lose: string | undefined;
  let before: ((method: string) => Promise<void>) | undefined;
  const call: SubstrateCall = async (method, input) => {
    const request = input as Record<string, Record<string, unknown>>;
    const kind = method.replace(/^(Get|Create|Resume|Suspend|Delete)/, "");
    const declaration =
      request["accessPolicy"] ??
      request["egressPolicy"] ??
      request[`${kind[0]?.toLowerCase()}${kind.slice(1)}`];
    const metadata = declaration?.["metadata"] as Record<string, unknown> | undefined;
    const scope =
      request["atespace"]?.["name"] ??
      metadata?.["atespace"] ??
      request["actorTemplate"]?.["atespace"] ??
      request["actor"]?.["atespace"] ??
      (kind === "Atespace" ? metadata?.["name"] : undefined);
    if (typeof scope !== "string") throw Error(`Missing owned native scope for ${method}`);
    calls.push({ method, scope });
    await before?.(method);
    let objects = resources.get(scope);
    if (!objects) {
      objects = new Map();
      resources.set(scope, objects);
    }
    if (method.startsWith("Get")) {
      const saved = objects.get(kind);
      if (!saved) throw new SubstrateRPCError("NotFound", "Owned native resource absent");
      return structuredClone(saved);
    }
    if (method.startsWith("Create")) {
      if (!declaration) throw Error(`Missing owned ${kind} declaration`);
      // The simulated server shares the dispatch fact's clock. Host/VM clock
      // skew must not make a newly created test object appear pre-existing.
      const [clock] = await f.database.client<{ createdAt: string }[]>`
        SELECT clock_timestamp()::text AS "createdAt"`;
      if (!clock) throw Error("Owned native fixture clock is unavailable");
      const value = {
        ...declaration,
        metadata: {
          ...metadata,
          uid: crypto.randomUUID(),
          version: "1",
          createTime: new Date(clock.createdAt).toISOString(),
        },
      };
      if (kind === "Actor") Object.assign(value, { status: { state: "ACTOR_STATE_SUSPENDED" } });
      objects.set(kind, value);
      if (lose === method) {
        lose = undefined;
        throw new SubstrateRPCError("Unavailable", "Owned lost native reply");
      }
      return structuredClone(value);
    }
    if (method === "ResumeActor") {
      const actor = nativeActor.parse(objects.get("Actor"));
      actor.metadata.version = String(BigInt(actor.metadata.version) + 1n);
      actor.status = {
        ...actor.status,
        state: "ACTOR_STATE_RUNNING",
        workerAssignment: { sandboxRuntime: f.config.runtime },
      };
      objects.set("Actor", actor);
      return { actor: structuredClone(actor) };
    }
    if (method === "DeleteActor") {
      const actor = nativeActor.parse(objects.get("Actor"));
      if (
        request["options"]?.["uid"] !== actor.metadata.uid ||
        request["options"]?.["version"] !== actor.metadata.version
      )
        throw Error("Foreign or stale native Delete");
      objects.delete("Actor");
      return {};
    }
    throw Error(`Uncommissioned controlled native method ${method}`);
  };
  return {
    ...f,
    configuration,
    revision,
    resources,
    calls,
    repository,
    connectorTokens: (attemptID: string, generation = 1) =>
      runtimeConnectorTokens(signingSecret, attemptID, generation),
    controller: (selected = configuration) =>
      createRuntimeController(f.database, f.hub, signingSecret, {
        configuration: selected,
        call,
        provisionerCall: call,
        sources,
      }),
    loseNext(method: string) {
      lose = method;
    },
    beforeCall(callback: (method: string) => Promise<void>) {
      before = callback;
    },
    async dispose() {
      for (const row of await f.database.client<
        { id: string }[]
      >`SELECT id FROM factory.runtime_attempt WHERE project_id=${f.projectID}`)
        f.hub.revoke(row.id);
      await f.dispose();
      await rm(directory, { recursive: true, force: true });
      if (previousSecret === undefined) delete process.env["FACTORY_AUTH_SECRET"];
      else process.env["FACTORY_AUTH_SECRET"] = previousSecret;
    },
  };
}
