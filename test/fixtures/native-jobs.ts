import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factorySigningSecret } from "../../packages/auth/src/signing-secret";
import type { createDatabase } from "../../packages/db/src/client";
import { runtimeConnectorTokens } from "../../packages/runtime-domain/src/identity";
import {
  nativeActor,
  type SubstrateCall,
  SubstrateRPCError,
} from "../../packages/runtime-kubernetes/src/substrate-control";
import {
  type SystemContract,
  systemContract,
} from "../../packages/system-contract/src/system-contract";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import { createSubstrateIsolated } from "../../apps/factory/src/runtime/substrate-isolated";
import { createSubstrateVerification } from "../../apps/factory/src/runtime/substrate-verification";
import type { SubstrateWorkspaceConfiguration } from "../../apps/factory/src/runtime/substrate-workspaces";
import { nativeInstallationFixture } from "./native-installation";

type Database = ReturnType<typeof createDatabase>;

// Real Factory Verification/Staging owners and baseline constraints with an
// in-memory official-RPC peer. No native server, Actor, worker or model is used.
// The peer only answers operations dispatched by the existing product owners;
// this fixture never inserts an isolated Attempt or bypasses its owner trigger.
export async function nativeJobsFixture(
  database: Database,
  projectID: string,
  contract: SystemContract = {
    version: 1,
    primaryApp: "web",
    apps: [
      { id: "web", label: "Owned Web", command: ["node", "web.js"], port: 4321, healthPath: "/" },
    ],
  },
) {
  const [scope] = await database.client<{ database: string; id: string }[]>`
    SELECT current_database() AS database,id FROM factory.project WHERE id=${projectID}`;
  if (!scope || !/^owned_[a-f0-9]{32}$/.test(scope.database))
    throw Error("Controlled native jobs require their owned database and Project");
  const forge = new URL(process.env["FACTORY_FORGEJO_PUBLIC_URL"] ?? "");
  if (forge.protocol !== "https:" || forge.port)
    throw Error("Controlled native jobs require their explicit Forge TLS origin");
  const declaration = systemContract.parse(contract);
  const directory = await mkdtemp(join(tmpdir(), "factory-native-jobs-"));
  const ca = join(directory, "fixture-ca.pem");
  await writeFile(
    ca,
    "-----BEGIN CERTIFICATE-----\nowned-controller-fixture\n-----END CERTIFICATE-----\n",
  );
  const base = nativeInstallationFixture();
  const configuration: SubstrateWorkspaceConfiguration = {
    ...base,
    deployment: "owned-test",
    database: scope.database,
    projectID,
    connection: {
      ...base.connection,
      bridge: "/unavailable-controlled-native-bridge",
      endpoint: "127.0.0.1:1",
      caFile: ca,
      tokenFile: join(directory, "unavailable-editor-token"),
    },
    provisioner: {
      ...base.provisioner,
      bridge: "/unavailable-controlled-native-bridge",
      endpoint: "127.0.0.1:1",
      caFile: ca,
      tokenFile: join(directory, "unavailable-owner-token"),
    },
    connectorURL: `wss://${forge.host}/internal/runtime-connect`,
    factoryCAFile: ca,
    egressHosts: [forge.hostname],
  };
  const secret = factorySigningSecret();
  const hub = new RuntimeHub(async () => {});
  const resources = new Map<string, Map<string, Record<string, unknown>>>();
  const calls: { method: string; scope: string }[] = [];
  const attempts = new Set<string>();
  const call: SubstrateCall = async (method, input) => {
    const request = input as Record<string, Record<string, unknown>>;
    const kind = method.replace(/^(Get|Create|Resume|Delete)/, "");
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
    if (typeof scope !== "string" || !/^fa-[a-f0-9]{32}$/.test(scope))
      throw Error("Controlled job RPC has no exact native scope");
    calls.push({ method, scope });
    let objects = resources.get(scope);
    if (!objects) {
      objects = new Map();
      resources.set(scope, objects);
    }
    if (method.startsWith("Get")) {
      const saved = objects.get(kind);
      if (!saved) throw new SubstrateRPCError("NotFound", "Controlled native resource absent");
      return structuredClone(saved);
    }
    if (method.startsWith("Create")) {
      if (!declaration || objects.has(kind))
        throw Error("Controlled native Create cannot replace an existing resource");
      const [clock] = await database.client<{ created: string }[]>`
        SELECT clock_timestamp()::text AS created`;
      if (!clock) throw Error("Controlled native resource clock is unavailable");
      const value = {
        ...declaration,
        metadata: {
          ...metadata,
          uid: crypto.randomUUID(),
          version: "1",
          createTime: new Date(clock.created).toISOString(),
        },
      };
      if (kind === "Actor") Object.assign(value, { status: { state: "ACTOR_STATE_SUSPENDED" } });
      objects.set(kind, value);
      return structuredClone(value);
    }
    if (method === "ResumeActor") {
      const actor = nativeActor.parse(objects.get("Actor"));
      actor.metadata.version = String(BigInt(actor.metadata.version) + 1n);
      actor.status = {
        state: "ACTOR_STATE_RUNNING",
        workerAssignment: { sandboxRuntime: configuration.runtime },
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
        throw Error("Controlled native Delete must name its original UID and version");
      objects.delete("Actor");
      return {};
    }
    throw Error(`Uncommissioned controlled native job RPC ${method}`);
  };
  const verification = createSubstrateVerification(
    database,
    hub,
    secret,
    configuration,
    call,
    call,
  );
  const isolated = createSubstrateIsolated(
    database,
    hub,
    secret,
    configuration,
    async () => structuredClone(declaration),
    call,
    call,
  );
  return {
    calls,
    resources,
    configuration,
    async startVerification(id: string, userID: string) {
      const attemptID = await verification.start(id, userID);
      attempts.add(attemptID);
      return attemptID;
    },
    async startStaging(userID: string, promotionID?: string) {
      const attemptID = await isolated.stage(userID, promotionID);
      attempts.add(attemptID);
      return attemptID;
    },
    async startPublication(id: string, userID: string) {
      const attemptID = await isolated.publish(id, userID);
      attempts.add(attemptID);
      return attemptID;
    },
    async stop(attemptID: string) {
      const execution =
        (await verification.forAttempt(attemptID)) ?? (await isolated.forAttempt(attemptID));
      if (!execution) throw Error("Controlled native jobs cannot stop another runtime owner");
      await execution.stop();
    },
    tokens: (attemptID: string, generation: number) =>
      runtimeConnectorTokens(secret, attemptID, generation),
    async close() {
      for (const id of attempts) hub.revoke(id);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
