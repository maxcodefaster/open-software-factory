import { type ParseError, parse as parseJSONC } from "jsonc-parser";
import type { createDatabase } from "../../../../packages/db/src/client";
import { createForgejoClient, type ForgeRepository } from "../../../../packages/forge/src/forge";
import type { ComputeClass } from "../../../../packages/runtime-domain/src/compute";
import {
  hashConnectorToken,
  runtimeBuildBrowserToken,
  runtimeConnectorTokens,
  runtimeIdentity,
  runtimeModelToken,
  runtimePublicationToken,
} from "../../../../packages/runtime-domain/src/identity";
import {
  createKubernetesClient,
  KubernetesObservationUnavailableError,
  type KubernetesClient,
  type RuntimePodObservation,
  readRuntimeRegistryCA,
  requireRuntimePodArtifacts,
} from "../../../../packages/runtime-kubernetes/src/client";
import { renderRuntimeResources } from "../../../../packages/runtime-kubernetes/src/manifest";
import {
  parseSystemContract,
  SystemContractError,
} from "../../../../packages/system-contract/src/system-contract";
import {
  personalWorkspaceIdentity,
  ticketWorkspaceIdentity,
} from "../../../../packages/workspace-domain/src/workspace";
import { createAccessController } from "../access/controller";
import { createOpenCodeClient } from "../agent/opencode-client";
import { modelEnvironment } from "../models/controller";
import { requireSetupReady } from "../setup/execution-gate";
import { admitComputeIn, ComputeCapacityError } from "../usage/compute";
import { createComputeWait } from "../usage/compute-wait";
import { createRecordedOpenCodeUsage } from "../usage/record-opencode";
import type { createWorkspaceSourceController } from "../workspace/source-controller";
import { freezeRuntimeArtifacts } from "./artifacts";
import { createFactoryboxExecution } from "./factorybox";
import { runtimeFactoryURL, runtimeForgeURL, runtimeReleaseRegistryURL } from "./endpoints";
import {
  prepareRuntimeRepository,
  readRepositoryFileAtRevision,
  removeRuntimeRepository,
  resolveRepositoryRevision,
  runtimeSourceCapability,
} from "./git-http";
import type { RuntimeHub } from "./hub";
import {
  launchRuntimeResources,
  type RuntimeLaunchInput,
  type RuntimeLaunchPorts,
} from "./launcher";
import { recoveredConnectionObserver } from "./recovered-connections";
import type { ExecutionReserve } from "./reserve-controller";
import type { RuntimeAttemptView } from "./types";

type Database = ReturnType<typeof createDatabase>;
const agentModelID = process.env["FACTORY_AGENT_MODEL_ID"]?.trim() || "factory-coding-model";
const systemContractPath = ".factory/system.json";

function requirePinnedRuntimeHostImage(value: string | undefined) {
  if (!value?.includes("@sha256:")) {
    throw new Error("FACTORY_RUNTIME_HOST_IMAGE must be pinned by digest");
  }
  return value;
}

function repositoryFromURL(value: string): ForgeRepository {
  const url = new URL(value);
  const parts = url.pathname
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  const owner = parts.at(-2);
  const name = parts.at(-1);
  if (!owner || !name) throw new SystemContractError("Project repository URL is invalid");
  return { owner, name };
}

async function agentConfiguration(
  database: Database,
  changeID: string,
  secret: string,
  attemptID: string,
  generation: number,
  browserToolsImage: string | null,
) {
  if (!browserToolsImage || !/^[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}$/.test(browserToolsImage))
    throw new Error(
      "Configure FACTORY_BROWSER_TOOLS_IMAGE with the pinned Build browser image before starting implementation",
    );
  const [admitted] = await database.client<
    Array<{
      modelID: string;
      provider: "openai" | "anthropic" | "deepseek" | null;
      reasoningEffort: "medium" | "high" | "xhigh" | "max" | null;
    }>
  >`
    SELECT turn.authority->>'modelId' AS "modelID", version.provider,
      turn.authority->>'codingReasoning' AS "reasoningEffort"
    FROM factory.agent_turn turn LEFT JOIN factory.model_connection_version version
      ON version.connection_id::text=turn.authority->'modelConnection'->>'connectionID'
      AND version.version::text=turn.authority->'modelConnection'->>'version'
    WHERE turn.change_id=${changeID} ORDER BY turn.created_at, turn.id LIMIT 1`;
  const modelID = admitted?.modelID ?? agentModelID;
  return {
    modelBaseURL: runtimeFactoryURL(`/internal/model/${attemptID}/v1`),
    modelToken: runtimeModelToken(secret, attemptID, generation),
    modelID,
    modelIDs: admitted ? [modelID] : modelEnvironment().models,
    provider: admitted?.provider ?? "openai",
    ...(admitted?.reasoningEffort ? { reasoningEffort: admitted.reasoningEffort } : {}),
    browserToolsImage,
    browserURL: runtimeFactoryURL(`/internal/build-browser/${attemptID}`),
    browserToken: runtimeBuildBrowserToken(secret, attemptID, generation),
  };
}

export function createRuntimeController(
  database: Database,
  hub: RuntimeHub,
  connectorSecret: string,
  sources: Pick<ReturnType<typeof createWorkspaceSourceController>, "prepareExecution">,
  kubernetes: KubernetesClient = createKubernetesClient(),
  readRegistryCA: () => Promise<string> = readRuntimeRegistryCA,
  reserve?: ExecutionReserve,
) {
  const pinnedRuntimeHostImage = requirePinnedRuntimeHostImage(
    process.env["FACTORY_RUNTIME_HOST_IMAGE"],
  );
  const artifactConfiguration = {
    hostImages: {
      development: pinnedRuntimeHostImage,
      staging: pinnedRuntimeHostImage,
      build: pinnedRuntimeHostImage,
      verification: pinnedRuntimeHostImage,
    },
    browserToolsImage: process.env["FACTORY_BROWSER_TOOLS_IMAGE"],
  };
  const artifactsFor = (attemptID: string, sql: Database["client"]) =>
    freezeRuntimeArtifacts(sql, attemptID, artifactConfiguration);
  const { FACTORY_FORGEJO_API_URL, FACTORY_FORGEJO_TOKEN, FACTORY_FORGEJO_OWNER } = process.env;
  if (!FACTORY_FORGEJO_API_URL || !FACTORY_FORGEJO_TOKEN || !FACTORY_FORGEJO_OWNER) {
    throw new Error("Forgejo configuration is required");
  }
  const forge = createForgejoClient({
    apiURL: FACTORY_FORGEJO_API_URL,
    token: FACTORY_FORGEJO_TOKEN,
  });
  const cleanupRetries = new Set<string>();
  const reconnectObservations = new Map<string, ReturnType<typeof setTimeout>>();
  function clearReconnectObservation(attemptID: string) {
    const timer = reconnectObservations.get(attemptID);
    if (timer) clearTimeout(timer);
    reconnectObservations.delete(attemptID);
  }
  function observeReconnectLater(attemptID: string) {
    if (reconnectObservations.has(attemptID)) return;
    const timer = setTimeout(() => {
      reconnectObservations.delete(attemptID);
      void updateStatus(attemptID, "disconnected", "Waiting for runtime connectors").catch(() => {
        console.error("Runtime reconnect observation failed");
        observeReconnectLater(attemptID);
      });
    }, 15_000);
    timer.unref();
    reconnectObservations.set(attemptID, timer);
  }
  let cleanupTail: Promise<void> = Promise.resolve();
  const controlURL = runtimeFactoryURL("/internal/runtime-connect").replace(/^http/, "ws");
  const computeWait = createComputeWait(database, reserve);
  const factorybox = createFactoryboxExecution(database, hub);
  let drainingCompute = false;
  async function admitOrWait(
    sql: Database["client"],
    attemptID: string,
    projectID: string,
    kind: ComputeClass,
    role?: "staging" | "verification",
  ) {
    try {
      if (reserve) return await reserve.admit(sql, attemptID, role, { projectID, kind });
      await admitComputeIn(sql, projectID, kind);
      return null;
    } catch (cause) {
      if (!(cause instanceof ComputeCapacityError)) throw cause;
      await sql`INSERT INTO factory.runtime_compute_wait(attempt_id) VALUES(${attemptID}) ON CONFLICT DO NOTHING`;
      return null;
    }
  }
  async function waiting(attemptID: string) {
    return (
      (
        await database.client`SELECT attempt_id FROM factory.runtime_compute_wait WHERE attempt_id=${attemptID}`
      ).length > 0
    );
  }
  async function withResourceLock<T>(
    attemptID: string,
    action: (sql: Database["client"]) => Promise<T>,
    connection?: Database["client"],
  ) {
    const reserved = connection ? undefined : database.coordination();
    const lock = connection ?? reserved;
    if (!lock) throw new Error("Runtime resource connection missing");
    const key = `runtime-resources:${attemptID}`;
    try {
      await lock`SELECT pg_advisory_lock(hashtext(${key}))`;
      return await action(lock);
    } finally {
      try {
        await lock`SELECT pg_advisory_unlock(hashtext(${key}))`;
      } finally {
        await reserved?.end({ timeout: 1 });
      }
    }
  }
  async function recordCreated(
    sql: Database["client"],
    attemptID: string,
    podUID: string,
    namespaceUID: string,
  ) {
    const observed = await sql<{ state: string }[]>`
      UPDATE factory.runtime_attempt SET
        state = CASE WHEN state = 'create-intended' AND stop_intended_at IS NULL
          THEN 'starting'::factory.runtime_attempt_state ELSE state END,
        kubernetes_uid = ${podUID}, kubernetes_namespace_uid = ${namespaceUID},
        create_observed_at = now(), updated_at = now()
      WHERE id = ${attemptID}
        AND (kubernetes_uid IS NULL OR kubernetes_uid = ${podUID})
        AND (kubernetes_namespace_uid IS NULL OR kubernetes_namespace_uid = ${namespaceUID})
      RETURNING state
    `;
    if (!observed[0]) throw new Error("Runtime create identities do not match persisted intent");
    const active = observed[0].state === "starting";
    if (!active) hub.revoke(attemptID);
    return active;
  }
  async function launchAttempt(
    attemptID: string,
    input: RuntimeLaunchInput,
    ports: Omit<RuntimeLaunchPorts, "kubernetes" | "transitionObserved">,
    connection: Database["client"],
  ) {
    await withResourceLock(
      attemptID,
      async (sql) => {
        const intent = await sql<{ state: string; stopped: boolean }[]>`
        SELECT state, stop_intended_at IS NOT NULL AS stopped
        FROM factory.runtime_attempt WHERE id = ${attemptID}
      `;
        if (
          intent[0]?.state !== "create-intended" ||
          intent[0].stopped ||
          (await waiting(attemptID))
        ) {
          hub.revoke(attemptID);
          return;
        }
        reserve?.refill();
        const activated = await computeWait.launch(
          attemptID,
          () => reserve?.activate(attemptID, input.resources) ?? Promise.resolve(null),
        );
        if (activated) {
          if (await recordCreated(sql, attemptID, activated.podUID, activated.namespaceUID))
            void ports.observe().catch((cause) => ports.fail("observe", cause));
          return;
        }
        await computeWait.launch(attemptID, () =>
          launchRuntimeResources(input, {
            ...ports,
            kubernetes,
            transitionObserved: (podUID, namespaceUID) =>
              recordCreated(sql, attemptID, podUID, namespaceUID),
          }),
        );
      },
      connection,
    );
  }
  async function resolveSystemContract(repositoryURL: string, revision: string) {
    let content: string;
    try {
      if (repositoryURL.startsWith("file://")) {
        content = await readRepositoryFileAtRevision(repositoryURL, revision, systemContractPath);
      } else {
        const repository = repositoryFromURL(repositoryURL);
        if (repository.owner !== FACTORY_FORGEJO_OWNER) {
          throw new Error("Project Forge owner is not allowed");
        }
        content = await forge.getFile(repository, systemContractPath, revision);
      }
    } catch (cause) {
      throw new SystemContractError(
        `Cannot read ${systemContractPath} at ${revision.slice(0, 12)}: ${
          cause instanceof Error ? cause.message : "unknown error"
        }`,
      );
    }
    return parseSystemContract(content);
  }
  async function settleReadyChange(attemptID: string) {
    await database.client`
      UPDATE factory.change SET state = 'active', version = version + 1
      WHERE runtime_attempt_id = ${attemptID} AND state = 'starting'
    `;
  }
  function runtimeRepositoryURL(_repositoryURL: string, attemptID: string) {
    return runtimeFactoryURL(
      `/internal/runtime-source/${attemptID}/${runtimeSourceCapability(attemptID)}`,
    );
  }
  async function cleanupAttempt(attemptID: string) {
    // Cleanup holds a resource connection while usage and reserve accounting need
    // another. Queue cleanup so recovery cannot reserve the entire shared pool.
    const current = cleanupTail.then(() =>
      withResourceLock(attemptID, (sql) => cleanupResources(sql, attemptID)),
    );
    cleanupTail = current.catch(() => {});
    await current;
  }
  async function cleanupResources(sql: Database["client"], attemptID: string) {
    const attempts = await sql<
      Array<{
        namespace: string;
        namespaceUID: string | null;
        podName: string;
        generation: string;
        uid: string | null;
        workspaceID: string | null;
      }>
    >`
      SELECT attempt.kubernetes_namespace AS namespace,
        attempt.kubernetes_namespace_uid AS "namespaceUID",
        attempt.kubernetes_pod_name AS "podName", attempt.generation,
        attempt.kubernetes_uid AS uid,
        attempt.workspace_id AS "workspaceID"
      FROM factory.runtime_attempt attempt
      WHERE attempt.id = ${attemptID}
    `;
    const attempt = attempts[0];
    if (!attempt) return;
    if (hub.connected(attemptID)) {
      await createRecordedOpenCodeUsage(database).drainAttempt(
        attemptID,
        createOpenCodeClient((request, path) => hub.request(attemptID, "agent", request, path)),
      );
    } else await createRecordedOpenCodeUsage(database).markUnavailable(attemptID);
    await factorybox.deleteSandbox(attemptID);
    const removedByReserve = await reserve?.cleanup(attemptID, Number(attempt.generation));
    const observedNamespace = await kubernetes.getNamespace(attempt.namespace);
    if (observedNamespace && !removedByReserve) {
      if (attempt.namespaceUID && attempt.namespaceUID !== observedNamespace.uid) {
        throw new Error("Runtime Namespace UID does not match persisted intent");
      }
      // Source owns the Workspace Namespace/PVC. Even cancelled compute removes only its Pod.
      if (attempt.workspaceID) {
        const pod = await kubernetes.getPod(attempt.namespace, attempt.podName);
        if (pod) {
          if (!attempt.uid || pod.uid !== attempt.uid) {
            throw new Error("Runtime Pod UID does not match persisted intent");
          }
          await kubernetes.deletePod({
            namespace: attempt.namespace,
            podName: attempt.podName,
            attemptID,
            generation: Number(attempt.generation),
            uid: attempt.uid,
          });
        }
        await factorybox.deleteStore(attemptID);
      } else {
        await kubernetes.deleteNamespace({
          namespace: attempt.namespace,
          namespaceUID: attempt.namespaceUID ?? observedNamespace.uid,
          podName: attempt.podName,
          attemptID,
          generation: Number(attempt.generation),
          uid: attempt.uid,
          ownerID: attempt.workspaceID ?? attemptID,
        });
      }
    }
    await removeRuntimeRepository(attemptID);
    await reserve?.removed(sql, attemptID);
    reserve?.refill();
    hub.revoke(attemptID);
  }
  function retryCleanup(attemptID: string) {
    if (cleanupRetries.has(attemptID)) return;
    cleanupRetries.add(attemptID);
    void (async () => {
      try {
        for (;;) {
          const rows = await database.client<
            Array<{
              state: string;
              failure: string | null;
              cleanupAttempts: number;
              failedStop: boolean;
            }>
          >`
            SELECT state, failure, cleanup_attempts AS "cleanupAttempts",
              state='failed' AND stop_intended_at IS NOT NULL AND stopped_at IS NULL AS "failedStop"
            FROM factory.runtime_attempt WHERE id = ${attemptID}
          `;
          const attempt = rows[0];
          if (!attempt || (attempt.state !== "stopping" && !attempt.failedStop)) return;
          if (attempt.cleanupAttempts >= 12) break;
          try {
            await cleanupAttempt(attemptID);
            await database.client.begin(async (transaction) => {
              const settled = await transaction<Array<{ state: string }>>`
                UPDATE factory.runtime_attempt
                SET state = CASE WHEN stop_intended_at IS NOT NULL
                    THEN 'stopped'::factory.runtime_attempt_state
                    ELSE 'failed'::factory.runtime_attempt_state END,
                  stopped_at = CASE WHEN stop_intended_at IS NOT NULL THEN now() ELSE stopped_at END,
                  failure = CASE WHEN stop_intended_at IS NOT NULL THEN NULL ELSE failure END,
                  updated_at = now()
                WHERE id = ${attemptID} AND (state='stopping' OR
                  (state='failed' AND stop_intended_at IS NOT NULL AND stopped_at IS NULL))
                RETURNING state
              `;
              const state = settled[0]?.state;
              if (state === "stopped" || state === "failed") {
                await transaction`
                  UPDATE factory.change SET
                    state = CASE WHEN ${state} = 'stopped' AND cancel_requested_at IS NOT NULL
                      THEN 'cancelled'::factory.change_state ELSE 'failed'::factory.change_state END,
                    cancelled_at = CASE WHEN ${state} = 'stopped' AND cancel_requested_at IS NOT NULL
                      THEN now() ELSE cancelled_at END,
                    failure = CASE WHEN ${state} = 'failed'
                      THEN COALESCE(failure, 'Runtime cleanup failed') ELSE failure END,
                    version = version + 1
                  WHERE runtime_attempt_id = ${attemptID}
                    AND state IN ('starting', 'active', 'cancelling')
                    AND (${state} = 'failed' OR cancel_requested_at IS NOT NULL)
                `;
              }
            });
            return;
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : "unknown cleanup error";
            await database.client`
              UPDATE factory.runtime_attempt SET
                failure = ${`${attempt.failure?.split("; cleanup retry failed:")[0] ?? "runtime cleanup pending"}; cleanup retry failed: ${message}`},
                cleanup_attempts = cleanup_attempts + 1,
                updated_at = now()
              WHERE id = ${attemptID} AND (state='stopping' OR
                (state='failed' AND stop_intended_at IS NOT NULL AND stopped_at IS NULL))
            `;
            if (attempt.cleanupAttempts < 11) await Bun.sleep(5_000);
          }
        }
        await database.client.begin(async (transaction) => {
          await transaction`
            UPDATE factory.runtime_attempt SET state = 'cleanup-failed', updated_at = now()
            WHERE id = ${attemptID} AND state = 'stopping'
          `;
          await transaction`
            UPDATE factory.change SET state = 'failed',
              failure = COALESCE(failure, 'Runtime cleanup failed'), version = version + 1
            WHERE runtime_attempt_id = ${attemptID}
              AND state IN ('starting', 'active', 'cancelling')
              AND (cancel_requested_at IS NOT NULL OR EXISTS(
                SELECT 1 FROM factory.runtime_attempt WHERE id=${attemptID}
                  AND stop_intended_at IS NULL
              ))
          `;
        });
      } finally {
        cleanupRetries.delete(attemptID);
      }
    })();
  }
  async function beginCleanup(attemptID: string, failure?: string, observedAt?: string) {
    clearReconnectObservation(attemptID);
    const projects = await database.client<Array<{ projectID: string }>>`
      SELECT project_id AS "projectID" FROM factory.runtime_attempt WHERE id = ${attemptID}
    `;
    const projectID = projects[0]?.projectID;
    if (!projectID) return;
    const lock = database.coordination();
    let changed = false;
    try {
      await lock`SELECT pg_advisory_lock(hashtext(${`runtime:${projectID}`}))`;
      const result = await lock`
        UPDATE factory.runtime_attempt SET state = 'stopping',
          failure = COALESCE(CASE WHEN failure IN ('parent connector reconnecting','child connector reconnecting') THEN NULL ELSE failure END, ${failure ?? null}), updated_at = now()
        WHERE id = ${attemptID}
          AND state IN ('create-intended', 'starting', 'ready', 'stop-intended', 'stopping')
          AND (${observedAt ?? null}::timestamptz IS NULL OR updated_at=${observedAt ?? null}::timestamptz)
      `;
      changed = result.count === 1;
    } finally {
      try {
        await lock`SELECT pg_advisory_unlock(hashtext(${`runtime:${projectID}`}))`;
      } finally {
        await lock.end({ timeout: 1 });
      }
    }
    if (!changed) return;
    hub.revoke(attemptID);
    retryCleanup(attemptID);
  }
  async function updateStatus(attemptID: string, phase: string, error?: string) {
    if (["failed", "cleanup-failed", "stopped"].includes(phase)) {
      const [current] = await database.client<
        Array<{ state: string }>
      >`SELECT state FROM factory.runtime_attempt WHERE id=${attemptID}`;
      if (current && ["pausing", "paused", "resuming"].includes(current.state)) return;
    }
    if (phase === "disconnected") {
      const [attempt] = await database.client<
        {
          state: string;
          namespace: string;
          podName: string;
          uid: string | null;
          observedAt: string;
        }[]
      >`SELECT state, kubernetes_namespace AS namespace, kubernetes_pod_name AS "podName",
        kubernetes_uid AS uid, updated_at::text AS "observedAt"
        FROM factory.runtime_attempt WHERE id=${attemptID}`;
      if (!attempt || !["starting", "ready"].includes(attempt.state)) return;
      let failure: string | undefined;
      try {
        const pod = await kubernetes.getPod(attempt.namespace, attempt.podName);
        if (!pod) failure = "Runtime Pod disappeared while connectors were reconnecting";
        else if (!attempt.uid || pod.uid !== attempt.uid)
          failure = "Runtime Pod UID changed while connectors were reconnecting";
        else if (pod.phase === "Failed" || pod.phase === "Succeeded")
          failure = "Runtime Pod terminated while connectors were reconnecting";
      } catch {
        // A failed observation proves neither resource loss nor permission to delete.
      }
      if (failure) {
        await beginCleanup(attemptID, failure, attempt.observedAt);
        return;
      }
      // Transport loss alone must not delete live compute or revoke its reconnect tokens.
      const changed = await database.client`UPDATE factory.runtime_attempt SET state='starting',
        failure=${error ?? "Waiting for runtime connectors"}, updated_at=now()
        WHERE id=${attemptID} AND state IN ('starting','ready')
          AND updated_at=${attempt.observedAt}::timestamptz`;
      if (changed.count === 1) observeReconnectLater(attemptID);
      return;
    }
    if (phase === "stopped") {
      await database.client`UPDATE factory.runtime_attempt attempt SET stop_intended_at=COALESCE(stop_intended_at,now()) WHERE attempt.id=${attemptID} AND attempt.isolated_kind='prebuild' AND attempt.state IN ('starting','ready') AND EXISTS(SELECT 1 FROM factory.project_image_preparation preparation WHERE preparation.runtime_attempt_id=attempt.id AND preparation.state='succeeded')`;
      await beginCleanup(attemptID);
      return;
    } else if (phase === "failed" || phase === "cleanup-failed") {
      await beginCleanup(attemptID, error ?? "runtime failed");
      return;
    }
    const state =
      phase === "ready"
        ? "ready"
        : phase === "reconnecting"
          ? "starting"
          : phase === "stopping"
            ? "stopping"
            : null;
    if (!state) return;
    const apps = state === "ready" ? hub.appChannels(attemptID) : [];
    const changed = await database.client`
      UPDATE factory.runtime_attempt SET state = ${state}::factory.runtime_attempt_state,
        declared_apps=CASE WHEN declared_apps='[]'::jsonb
          THEN ${JSON.stringify(apps)}::text::jsonb ELSE declared_apps END,
        failure = ${error ?? null}, stopped_at = CASE WHEN ${state} = 'stopped' THEN now() ELSE stopped_at END,
        updated_at = now() WHERE id = ${attemptID}
          AND (
            (${state} = 'ready' AND state IN ('starting', 'ready')) OR
            (${state} = 'starting' AND state IN ('starting', 'ready')) OR
            (${state} = 'stopping' AND state IN ('stop-intended', 'stopping'))
          )
    `;
    if (changed.count === 1 && state === "ready") {
      clearReconnectObservation(attemptID);
      await settleReadyChange(attemptID);
    }
  }
  async function observeStartup(
    attemptID: string,
    runtimeOwnerID: string,
    namespace: string,
    podName: string,
    resources: readonly unknown[],
  ) {
    const factoryboxSelected = resources.some((resource) => {
      const pod = resource as { kind?: string; spec?: { containers?: Array<{ name: string }> } };
      return (
        pod.kind === "Pod" && pod.spec?.containers?.some((container) => container.name === "worker")
      );
    });
    const deadline = performance.now() + 420_000;
    for (let replacement = 0; replacement < 3; replacement += 1) {
      for (let observation = 0; observation < (factoryboxSelected ? 420 : 300); observation += 1) {
        if (factoryboxSelected && performance.now() >= deadline) break;
        const attempt = await database.client<Array<{ state: string; uid: string | null }>>`
          SELECT state, kubernetes_uid AS uid FROM factory.runtime_attempt WHERE id = ${attemptID}
        `;
        const current = attempt[0];
        if (current?.state !== "starting") return;
        let pod: RuntimePodObservation | null;
        try {
          pod = await kubernetes.getPod(namespace, podName);
        } catch (cause) {
          if (!(cause instanceof KubernetesObservationUnavailableError)) throw cause;
          // An unavailable read says nothing about the owned Pod. Reobserve
          // within this startup window; do not clean up or replay its create.
          await Bun.sleep(1_000);
          continue;
        }
        if (factoryboxSelected) {
          if (
            !pod ||
            !current.uid ||
            current.uid !== pod.uid ||
            ["Failed", "Succeeded"].includes(pod.phase)
          ) {
            await database.client`UPDATE factory.runtime_attempt SET failure='Original Factorybox worker is unavailable; its execution identity was retained',updated_at=now()
              WHERE id=${attemptID} AND state='starting'`;
            return;
          }
          if (pod.ready) {
            try {
              await factorybox.ensureStarted(attemptID, resources, deadline);
              if (hub.connected(attemptID)) await updateStatus(attemptID, "ready");
            } catch (cause) {
              await database.client`UPDATE factory.runtime_attempt SET failure=${cause instanceof Error ? cause.message : "Factorybox operation is unconfirmed"},updated_at=now()
                WHERE id=${attemptID} AND state='starting'`;
            }
          }
          await Bun.sleep(1_000);
          continue;
        }
        if (!pod) break;
        if (pod.phase === "Failed" || pod.phase === "Succeeded") {
          if (!current.uid || current.uid !== pod.uid) {
            await updateStatus(
              attemptID,
              "failed",
              "Terminal runtime Pod UID did not match persisted create intent",
            );
            return;
          }
          if (replacement === 2) {
            await updateStatus(
              attemptID,
              "failed",
              "Runtime Pod terminated after bounded startup recovery",
            );
            return;
          }
          const removed = await withResourceLock(attemptID, async (sql) => {
            const intent = await sql<{ state: string; generation: string }[]>`
              SELECT state, generation FROM factory.runtime_attempt WHERE id = ${attemptID}
            `;
            if (intent[0]?.state !== "starting") return false;
            await kubernetes.deletePod({
              namespace,
              podName,
              attemptID,
              generation: Number(intent[0].generation),
              uid: pod.uid,
            });
            return true;
          });
          if (!removed) return;
          break;
        }
        await Bun.sleep(1_000);
      }
      if (factoryboxSelected) {
        await database.client`UPDATE factory.runtime_attempt SET failure='Factorybox startup deadline expired; original execution was retained',updated_at=now()
          WHERE id=${attemptID} AND state='starting'`;
        return;
      }
      if (replacement === 2) break;
      const current = await kubernetes.getPod(namespace, podName);
      if (current) continue;
      await Bun.sleep(2_000);
      const recreated = await withResourceLock(attemptID, async (sql) => {
        const intent = await sql<
          Array<{
            state: string;
            generation: string;
            namespaceUID: string | null;
            uid: string | null;
          }>
        >`
          SELECT state, generation, kubernetes_namespace_uid AS "namespaceUID", kubernetes_uid AS uid
          FROM factory.runtime_attempt WHERE id = ${attemptID}
        `;
        const active = intent[0];
        if (active?.state !== "starting") return "stopped";
        const applied = await kubernetes.apply(resources, {
          ownerID: runtimeOwnerID,
          uid: active.namespaceUID,
        });
        const recreated = await kubernetes.getPod(namespace, podName);
        if (!recreated) return "missing";
        const recorded = await sql`
          UPDATE factory.runtime_attempt SET kubernetes_uid = ${recreated.uid},
            kubernetes_namespace_uid = ${applied.namespaceUID},
            create_observed_at = now(), updated_at = now()
          WHERE id = ${attemptID} AND kubernetes_uid IS NOT DISTINCT FROM ${active.uid}
            AND kubernetes_namespace_uid IS NOT DISTINCT FROM ${active.namespaceUID}
        `;
        if (recorded.count !== 1) throw new Error("Runtime replacement identities changed");
        return "created";
      });
      if (recreated === "stopped") return;
    }
    await updateStatus(
      attemptID,
      "failed",
      "Runtime Pod did not establish its connectors after bounded startup recovery",
    );
  }

  async function launchIsolated(
    input: {
      identity: ReturnType<typeof runtimeIdentity>;
      generation: number;
      projectID: string;
      repositoryURL: string;
      revision: string;
      devcontainerPath: string;
      kind: "staging" | "verification" | "publication";
      parentToken: string;
      childToken: string;
      verification?: {
        runnerUUID: string;
        runnerToken: string;
        jobHandle?: string;
        publicationID?: string;
        version?: string;
      };
    },
    connection: Database["client"],
  ) {
    const repositoryURL = runtimeRepositoryURL(input.repositoryURL, input.identity.attemptID);
    try {
      if (input.repositoryURL.startsWith("file://")) {
        await prepareRuntimeRepository(
          input.identity.attemptID,
          input.repositoryURL,
          input.revision,
        );
      }
      const systemContract =
        input.kind === "verification" || input.kind === "publication"
          ? undefined
          : await resolveSystemContract(input.repositoryURL, input.revision);
      const artifacts = await artifactsFor(input.identity.attemptID, connection);
      const resources = renderRuntimeResources({
        ...input.identity,
        generation: input.generation,
        projectID: input.projectID,
        repositoryURL,
        revision: input.revision,
        devcontainerPath: input.devcontainerPath,
        connectorToken: input.parentToken,
        childConnectorToken: input.childToken,
        controlURL,
        runtimeHostImage: artifacts.runtimeHostImage,
        factoryboxProfile: artifacts.factoryboxProfile,
        environmentVersion: artifacts.environmentVersion,
        registryCA: await readRegistryCA(),
        mode: input.kind,
        ...(systemContract ? { systemContract } : {}),
        ...(input.verification
          ? {
              verification: {
                forgeURL: runtimeForgeURL(),
                runnerUUID: input.verification.runnerUUID,
                runnerToken: input.verification.runnerToken,
                runnerLabel:
                  input.kind === "publication" ? "factory-publication" : "factory-verification",
                ...(input.verification.jobHandle ? { handle: input.verification.jobHandle } : {}),
                ...(input.verification.publicationID
                  ? {
                      publication: {
                        id: input.verification.publicationID,
                        version: input.verification.version!,
                        credentialURL: runtimeFactoryURL(
                          `/internal/releases/${input.verification.publicationID}/credentials`,
                        ),
                        registryURL: runtimeReleaseRegistryURL(),
                        credentialToken: runtimePublicationToken(
                          connectorSecret,
                          input.verification.publicationID,
                        ),
                      },
                    }
                  : {}),
              },
            }
          : {}),
      });
      await launchAttempt(
        input.identity.attemptID,
        {
          resources,
          namespace: input.identity.namespace,
          podName: input.identity.podName,
          missingPodMessage: `${input.kind} Pod was not observed after create`,
          runtimeHostImage: artifacts.runtimeHostImage,
          factoryboxProfile: artifacts.factoryboxProfile,
        },
        {
          observe: () =>
            observeStartup(
              input.identity.attemptID,
              input.identity.attemptID,
              input.identity.namespace,
              input.identity.podName,
              resources,
            ),
          fail: async (phase, cause) => {
            const message = cause instanceof Error ? cause.message : "unknown error";
            if (phase === "observe") {
              await updateStatus(
                input.identity.attemptID,
                "failed",
                `${input.kind} observer failed: ${message}`,
              );
            }
          },
        },
        connection,
      );
    } catch (cause) {
      await database.client`
        UPDATE factory.runtime_attempt SET state = 'stopping',
          failure = ${`${input.kind} create failed: ${cause instanceof Error ? cause.message : "unknown error"}`},
          updated_at = now()
        WHERE id = ${input.identity.attemptID}
          AND state IN ('create-intended', 'starting')
      `;
      hub.revoke(input.identity.attemptID);
      retryCleanup(input.identity.attemptID);
      throw cause;
    }
  }
  async function recoverCreateAttempt(attempt: {
    id: string;
    generation: string;
    parentTokenHash: string;
    childTokenHash: string;
  }) {
    if (await waiting(attempt.id)) return;
    try {
      await withResourceLock(attempt.id, async (sql) => {
        const intent = await sql<{ state: string; stopped: boolean }[]>`
    SELECT state, stop_intended_at IS NOT NULL AS stopped
    FROM factory.runtime_attempt WHERE id = ${attempt.id}
  `;
        if (intent[0]?.state !== "create-intended" || intent[0].stopped) {
          hub.revoke(attempt.id);
          return;
        }
        const rows = await sql<
          Array<{
            namespace: string;
            podName: string;
            projectID: string;
            changeID: string | null;
            workspaceID: string | null;
            isolatedKind: "staging" | "verification" | "publication" | null;
            publicationID: string | null;
            publicationVersion: string | null;
            publicationHandle: string | null;
            verificationID: string | null;
            runnerUUID: string | null;
            runnerToken: string | null;
            repositoryURL: string;
            revision: string;
            devcontainerPath: string;
            namespaceUID: string | null;
          }>
        >`
      SELECT kubernetes_namespace AS namespace, kubernetes_pod_name AS "podName",
      attempt.project_id AS "projectID", attempt.change_id AS "changeID",
      attempt.workspace_id AS "workspaceID",
      attempt.isolated_kind AS "isolatedKind",
      attempt.verification_id AS "verificationID",
      COALESCE(verification.runner_uuid::text,publication.runner_uuid) AS "runnerUUID",
      COALESCE(verification.runner_token,publication.runner_token) AS "runnerToken",
      publication.id AS "publicationID",publication.job_handle AS "publicationHandle",
      release.version AS "publicationVersion",
      project.repository_url AS "repositoryURL",
      attempt.revision, project.devcontainer_path AS "devcontainerPath",
      attempt.kubernetes_namespace_uid AS "namespaceUID"
    FROM factory.runtime_attempt attempt
    JOIN factory.project project ON project.id = attempt.project_id
    LEFT JOIN factory.verification verification ON verification.id = attempt.verification_id
    LEFT JOIN factory.release_attempt publication ON publication.runtime_attempt_id=attempt.id
    LEFT JOIN factory.project_release release ON release.id=publication.release_id
    WHERE attempt.id = ${attempt.id}
  `;
        const row = rows[0];
        if (!row) return;
        if (row.isolatedKind === "verification" && (!row.runnerUUID || !row.runnerToken)) {
          throw new Error("Verification create intent is missing its ephemeral runner");
        }
        const generation = Number(attempt.generation);
        const runtimeOwnerID = row.workspaceID ?? attempt.id;
        const expectedIdentity = runtimeIdentity(
          row.workspaceID ??
            row.changeID ??
            (row.isolatedKind === "staging"
              ? `staging:${row.projectID}`
              : (row.verificationID ?? row.publicationID ?? row.projectID)),
          generation,
        );
        const identity = {
          ...expectedIdentity,
          namespace: row.namespace,
          podName: row.podName,
        };
        if (identity.attemptID !== attempt.id) {
          throw new Error("create intent identity does not match its deterministic identity");
        }
        const tokens = runtimeConnectorTokens(connectorSecret, attempt.id, generation);
        if (
          hashConnectorToken(tokens.parent) !== attempt.parentTokenHash ||
          hashConnectorToken(tokens.child) !== attempt.childTokenHash
        ) {
          throw new Error("create intent credentials cannot be reconstructed");
        }
        if (row.repositoryURL.startsWith("file://")) {
          await prepareRuntimeRepository(attempt.id, row.repositoryURL, row.revision);
        }
        const expectedRepositoryURL = runtimeRepositoryURL(row.repositoryURL, attempt.id);
        const systemContract =
          row.isolatedKind === "verification" || row.isolatedKind === "publication"
            ? undefined
            : await resolveSystemContract(row.repositoryURL, row.revision);
        const canonicalSource = row.workspaceID
          ? await sources.prepareExecution(attempt.id)
          : undefined;
        const artifacts = await artifactsFor(attempt.id, sql);
        const resources = renderRuntimeResources({
          ...identity,
          generation,
          projectID: row.projectID,
          runtimeOwnerID,
          repositoryURL: expectedRepositoryURL,
          repositoryIdentity: row.projectID,
          preserveWorkspace: row.workspaceID !== null,
          ...(canonicalSource ? { storageNode: canonicalSource.storageNode } : {}),
          revision: row.revision,
          devcontainerPath: row.devcontainerPath,
          connectorToken: tokens.parent,
          childConnectorToken: tokens.child,
          controlURL,
          runtimeHostImage: artifacts.runtimeHostImage,
          factoryboxProfile: artifacts.factoryboxProfile,
          environmentVersion: artifacts.environmentVersion,
          registryCA: await readRegistryCA(),
          mode: row.isolatedKind ?? "development",
          ...(systemContract ? { systemContract } : {}),
          ...(row.changeID && row.workspaceID
            ? {
                agent: await agentConfiguration(
                  database,
                  row.changeID,
                  connectorSecret,
                  attempt.id,
                  generation,
                  artifacts.browserToolsImage,
                ),
              }
            : {}),
          ...((row.isolatedKind === "verification" || row.isolatedKind === "publication") &&
          row.runnerUUID &&
          row.runnerToken
            ? {
                verification: {
                  forgeURL: runtimeForgeURL(),
                  runnerUUID: row.runnerUUID,
                  runnerToken: row.runnerToken,
                  runnerLabel:
                    row.isolatedKind === "publication"
                      ? "factory-publication"
                      : "factory-verification",
                  ...(row.publicationID && row.publicationHandle
                    ? {
                        handle: row.publicationHandle,
                        publication: {
                          id: row.publicationID,
                          version: row.publicationVersion!,
                          credentialURL: runtimeFactoryURL(
                            `/internal/releases/${row.publicationID}/credentials`,
                          ),
                          registryURL: runtimeReleaseRegistryURL(),
                          credentialToken: runtimePublicationToken(
                            connectorSecret,
                            row.publicationID,
                          ),
                        },
                      }
                    : {}),
                },
              }
            : {}),
        });
        const activated = await computeWait.launch(
          attempt.id,
          () => reserve?.activate(attempt.id, resources) ?? Promise.resolve(null),
        );
        if (activated) {
          if (await recordCreated(sql, attempt.id, activated.podUID, activated.namespaceUID))
            void observeStartup(
              attempt.id,
              runtimeOwnerID,
              row.namespace,
              row.podName,
              resources,
            ).catch((cause) =>
              updateStatus(
                attempt.id,
                "failed",
                cause instanceof Error ? cause.message : "Reserved runtime recovery failed",
              ),
            );
          reserve?.refill();
          return;
        }
        let namespace = await kubernetes.getNamespace(row.namespace);
        let pod = await kubernetes.getPod(row.namespace, row.podName);
        if (!namespace || !pod) {
          const applied = await computeWait.launch(attempt.id, () =>
            kubernetes.apply(
              resources,
              namespace
                ? {
                    ownerID: runtimeOwnerID,
                    uid: row.namespaceUID ?? canonicalSource?.namespaceUID ?? namespace.uid,
                  }
                : undefined,
            ),
          );
          if (!applied) return;
          namespace = await kubernetes.getNamespace(row.namespace);
          pod = await kubernetes.getPod(row.namespace, row.podName);
          if (namespace && namespace.uid !== applied.namespaceUID) {
            throw new Error("created Namespace UID changed during recovery");
          }
        }
        const [parentToken, childToken, assignmentText] = await Promise.all([
          kubernetes.readSecret(row.namespace, "runtime-assignment", "parent-token"),
          kubernetes.readSecret(row.namespace, "runtime-assignment", "child-token"),
          kubernetes.readSecret(row.namespace, "runtime-assignment", "assignment.json"),
        ]);
        const assignment = JSON.parse(assignmentText) as {
          runtimeAttemptId?: string;
          generation?: number;
          repositoryUrl?: string;
          revision?: string;
          devcontainerPath?: string;
          composeProjectName?: string;
        };
        if (
          !namespace ||
          !pod ||
          namespace.labels["app.kubernetes.io/managed-by"] !== "open-software-factory" ||
          namespace.labels["factory.dev/runtime-owner"] !== runtimeOwnerID ||
          namespace.labels["factory.dev/project"] !== row.projectID ||
          pod.labels["app.kubernetes.io/managed-by"] !== "open-software-factory" ||
          pod.labels["factory.dev/runtime-attempt"] !== attempt.id ||
          pod.labels["factory.dev/runtime-generation"] !== String(attempt.generation) ||
          pod.labels["factory.dev/project"] !== row.projectID ||
          assignment.runtimeAttemptId !== attempt.id ||
          assignment.generation !== generation ||
          assignment.repositoryUrl !== expectedRepositoryURL ||
          assignment.revision !== row.revision ||
          assignment.devcontainerPath !== row.devcontainerPath ||
          assignment.composeProjectName !== identity.composeProjectName ||
          hashConnectorToken(parentToken) !== attempt.parentTokenHash ||
          hashConnectorToken(childToken) !== attempt.childTokenHash
        )
          throw new Error("create intent resources do not match persisted credentials");
        requireRuntimePodArtifacts(
          pod,
          artifacts.runtimeHostImage,
          artifacts.factoryboxProfile.image,
        );
        if (!(await recordCreated(sql, attempt.id, pod.uid, namespace.uid))) return;
        void observeStartup(
          attempt.id,
          runtimeOwnerID,
          row.namespace,
          row.podName,
          resources,
        ).catch(async (cause) => {
          await updateStatus(
            attempt.id,
            "failed",
            `startup observer failed: ${cause instanceof Error ? cause.message : "unknown error"}`,
          );
        });
      });
    } catch (cause) {
      await updateStatus(
        attempt.id,
        "failed",
        `create intent recovery failed: ${cause instanceof Error ? cause.message : "unknown error"}`,
      );
    }
  }

  return {
    async resumeForApp(attemptID: string, userID: string, deadline?: number) {
      await createAccessController(database).requireRuntime(userID, attemptID, "app");
      const current = await this.get(attemptID);
      if (!current || current.failure || !["pausing", "paused", "resuming"].includes(current.state))
        return current;
      try {
        await factorybox.resume(attemptID, deadline);
      } catch (cause) {
        const observed = await this.get(attemptID);
        if (!observed || !["starting", "ready"].includes(observed.state)) {
          await database.client`UPDATE factory.runtime_attempt SET
            failure=${cause instanceof Error ? cause.message : "Factorybox Resume is unconfirmed"},updated_at=now()
            WHERE id=${attemptID} AND state='resuming'`;
          throw cause;
        }
      }
      if (hub.connected(attemptID)) await updateStatus(attemptID, "ready");
      return this.get(attemptID);
    },
    async pause(attemptID: string) {
      try {
        await factorybox.pause(attemptID);
      } catch (cause) {
        await database.client`UPDATE factory.runtime_attempt SET failure=${cause instanceof Error ? cause.message : "Factorybox Pause is unconfirmed"},updated_at=now()
          WHERE id=${attemptID} AND state='pausing'`;
        throw cause;
      }
      return this.get(attemptID);
    },
    async drainComputeWaits() {
      if (drainingCompute) return;
      drainingCompute = true;
      try {
        const attempts = await database.client<
          Array<{
            id: string;
            generation: string;
            parentTokenHash: string;
            childTokenHash: string;
            preparationID: string | null;
          }>
        >`
          SELECT attempt.id,attempt.generation::text AS generation,attempt.parent_connector_token_hash AS "parentTokenHash",
            attempt.child_connector_token_hash AS "childTokenHash",preparation.id AS "preparationID"
          FROM factory.runtime_compute_wait waiting JOIN factory.runtime_attempt attempt ON attempt.id=waiting.attempt_id
          LEFT JOIN factory.project_image_preparation preparation ON preparation.runtime_attempt_id=attempt.id
          ORDER BY waiting.created_at,attempt.id LIMIT 16`;
        for (const attempt of attempts) {
          if (await computeWait.admit(attempt.id)) {
            hub.allow(
              attempt.id,
              Number(attempt.generation),
              attempt.parentTokenHash,
              attempt.childTokenHash,
            );
            if (attempt.preparationID) await this.startProjectPrebuild(attempt.preparationID);
            else await recoverCreateAttempt(attempt);
          } else {
            const [stopped] =
              await database.client`SELECT id FROM factory.runtime_attempt WHERE id=${attempt.id} AND state='stop-intended'`;
            if (stopped) await this.stop(attempt.id);
          }
        }
      } finally {
        drainingCompute = false;
      }
    },
    async startProjectPrebuild(preparationID: string) {
      const lock = database.coordination();
      let projectLock: string | undefined;
      try {
        await lock`SELECT pg_advisory_lock(hashtext(${`project-prebuild:${preparationID}`}))`;
        const [job] = await lock<
          Array<{
            projectID: string;
            revision: string;
            attemptID: string | null;
            userID: string;
            repositoryURL: string;
            devcontainerPath: string;
            environment: string;
            environmentVersion: string;
          }>
        >`
          SELECT preparation.project_id AS "projectID",preparation.revision,preparation.runtime_attempt_id AS "attemptID",project.created_by AS "userID",project.repository_url AS "repositoryURL",project.devcontainer_path AS "devcontainerPath",preparation.environment,preparation.environment_version::text AS "environmentVersion"
          FROM factory.project_image_preparation preparation JOIN factory.project project ON project.id=preparation.project_id WHERE preparation.id=${preparationID} AND preparation.state IN ('pending','running')`;
        if (!job) return;
        await requireSetupReady(lock, job.projectID);
        if (!job.attemptID) {
          const content = job.repositoryURL.startsWith("file://")
            ? await readRepositoryFileAtRevision(
                job.repositoryURL,
                job.revision,
                job.devcontainerPath,
              )
            : await forge.getFile(
                repositoryFromURL(job.repositoryURL),
                job.devcontainerPath,
                job.revision,
              );
          const errors: ParseError[] = [];
          const recipe = parseJSONC(content, errors, { allowTrailingComma: true });
          if (
            !errors.length &&
            recipe &&
            typeof recipe === "object" &&
            "dockerComposeFile" in recipe
          ) {
            await lock`UPDATE factory.project_image_preparation SET state='unsupported',failure='Compose uses normal startup instead of a prebuilt image.',updated_at=now() WHERE id=${preparationID} AND state='pending'`;
            return;
          }
        }
        projectLock = `runtime:${job.projectID}`;
        await lock`SELECT pg_advisory_lock(hashtext(${projectLock}))`;
        let attemptID = job.attemptID;
        if (!attemptID) {
          const [next] = await lock<Array<{ generation: string }>>`
            SELECT COALESCE(MAX(generation),0)+1 AS generation FROM factory.runtime_attempt
            WHERE project_id=${job.projectID} AND change_id IS NULL AND workspace_id IS NULL`;
          const generation = Number(next?.generation ?? 1);
          const identity = runtimeIdentity(`project-prebuild:${preparationID}`, generation);
          attemptID = identity.attemptID;
          const tokens = runtimeConnectorTokens(connectorSecret, attemptID, generation);
          await lock`BEGIN`;
          try {
            await lock`SELECT pg_advisory_xact_lock(hashtext(${`project-environment:${job.projectID}:${job.environment}`}))`;
            const [current] = await lock<
              Array<{ version: string }>
            >`SELECT version::text AS version FROM factory.project_environment WHERE project_id=${job.projectID} AND environment=${job.environment}`;
            if ((current?.version ?? "0") !== job.environmentVersion) {
              await lock`UPDATE factory.project_image_preparation SET state='unsupported',failure='Settings changed before preparation; normal startup remains available.',updated_at=now() WHERE id=${preparationID}`;
              await lock`COMMIT`;
              return;
            }
            await admitOrWait(lock, attemptID, job.projectID, "prebuild");
            await lock`INSERT INTO factory.runtime_attempt(id,project_id,isolated_kind,generation,revision,state,kubernetes_namespace,kubernetes_pod_name,parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
              VALUES(${attemptID},${job.projectID},'prebuild',${generation},${job.revision},'create-intended',${identity.namespace},${identity.podName},${hashConnectorToken(tokens.parent)},${hashConnectorToken(tokens.child)},now(),${job.userID})`;
            await lock`UPDATE factory.project_image_preparation SET runtime_attempt_id=${attemptID},state='running',updated_at=now() WHERE id=${preparationID}`;
            await artifactsFor(attemptID, lock);
            await lock`COMMIT`;
          } catch (cause) {
            await lock`ROLLBACK`;
            throw cause;
          }
        }
        if (await waiting(attemptID)) return;
        const [attempt] = await lock<
          Array<{ state: string; generation: number; namespace: string; podName: string }>
        >`SELECT state,generation::float8 AS generation,kubernetes_namespace AS namespace,kubernetes_pod_name AS "podName" FROM factory.runtime_attempt WHERE id=${attemptID}`;
        if (!attempt || attempt.state !== "create-intended") return;
        const generation = attempt.generation;
        const tokens = runtimeConnectorTokens(connectorSecret, attemptID, generation);
        await lock`SELECT pg_advisory_unlock(hashtext(${projectLock}))`;
        projectLock = undefined;
        hub.allow(
          attemptID,
          generation,
          hashConnectorToken(tokens.parent),
          hashConnectorToken(tokens.child),
        );
        if (job.repositoryURL.startsWith("file://"))
          await prepareRuntimeRepository(attemptID, job.repositoryURL, job.revision);
        const artifacts = await artifactsFor(attemptID, lock);
        const registry = artifacts.runtimeHostImage.slice(
          0,
          artifacts.runtimeHostImage.indexOf("/"),
        );
        const resources = renderRuntimeResources({
          attemptID,
          generation,
          namespace: attempt.namespace,
          podName: attempt.podName,
          composeProjectName: runtimeIdentity(`project-prebuild:${preparationID}`, generation)
            .composeProjectName,
          projectID: job.projectID,
          repositoryURL: runtimeRepositoryURL(job.repositoryURL, attemptID),
          revision: job.revision,
          devcontainerPath: job.devcontainerPath,
          connectorToken: tokens.parent,
          childConnectorToken: tokens.child,
          controlURL,
          runtimeHostImage: artifacts.runtimeHostImage,
          factoryboxProfile: artifacts.factoryboxProfile,
          environmentVersion: artifacts.environmentVersion,
          registryCA: await readRegistryCA(),
          mode: "prebuild",
          prebuild: {
            id: preparationID,
            platform: "native",
            imageRepository: `${registry}/open-factory/prebuilds/${job.projectID}`,
          },
        });
        await launchAttempt(
          attemptID,
          {
            resources,
            namespace: attempt.namespace,
            podName: attempt.podName,
            missingPodMessage: "Project image preparation compute was not observed",
            runtimeHostImage: artifacts.runtimeHostImage,
            factoryboxProfile: artifacts.factoryboxProfile,
          },
          {
            observe: async () => {
              setTimeout(async () => {
                const [current] = await database.client<
                  Array<{ state: string }>
                >`SELECT state FROM factory.runtime_attempt WHERE id=${attemptID}`;
                if (current && ["create-intended", "starting"].includes(current.state))
                  await updateStatus(
                    attemptID,
                    "failed",
                    "Project image preparation exceeded its twelve-minute bound; normal startup remains available",
                  );
              }, 12 * 60_000).unref();
            },
            fail: async () => {
              await updateStatus(
                attemptID,
                "failed",
                "Project image preparation could not start; normal startup remains available",
              );
            },
          },
          lock,
        );
      } finally {
        try {
          if (projectLock) await lock`SELECT pg_advisory_unlock(hashtext(${projectLock}))`;
          await lock`SELECT pg_advisory_unlock(hashtext(${`project-prebuild:${preparationID}`}))`;
        } finally {
          await lock.end({ timeout: 1 });
        }
      }
    },
    async recover() {
      // Failed attempts have already left active allocation. A retained Stop must
      // clean their exact resources without competing with a newer Workspace attempt.
      const failedStops = await database.client<{ id: string }[]>`
        SELECT id FROM factory.runtime_attempt WHERE state='failed' AND stop_intended_at IS NOT NULL`;
      for (const attempt of failedStops)
        await this.stop(attempt.id).catch(() => console.error("Retained runtime Stop needs retry"));
      await database.client`
        UPDATE factory.change change SET
          state = CASE WHEN attempt.state = 'stopped' AND change.cancel_requested_at IS NOT NULL
            THEN 'cancelled'::factory.change_state ELSE 'failed'::factory.change_state END,
          cancelled_at = CASE
            WHEN attempt.state = 'stopped' AND change.cancel_requested_at IS NOT NULL
            THEN now() ELSE change.cancelled_at END,
          failure = CASE WHEN attempt.state = 'failed'
            THEN COALESCE(change.failure, attempt.failure, 'Runtime failed') ELSE change.failure END,
          version = change.version + 1
        FROM factory.runtime_attempt attempt
        WHERE change.runtime_attempt_id = attempt.id
          AND change.state IN ('starting', 'active', 'cancelling')
          AND attempt.state IN ('stopped', 'failed')
          AND (attempt.state='failed' OR change.cancel_requested_at IS NOT NULL)
      `;
      await database.client`
        UPDATE factory.runtime_attempt SET state = 'stopping', cleanup_attempts = 0,
          updated_at = now()
        WHERE state = 'cleanup-failed'
      `;
      const attempts = await database.client<
        Array<{
          id: string;
          generation: string;
          parentTokenHash: string;
          childTokenHash: string;
          state: string;
          isolatedKind: string | null;
        }>
      >`
        SELECT id, generation, state, isolated_kind AS "isolatedKind",
          parent_connector_token_hash AS "parentTokenHash",
          child_connector_token_hash AS "childTokenHash"
        FROM factory.runtime_attempt
        WHERE state IN ('create-intended', 'starting', 'ready', 'pausing', 'paused', 'resuming', 'stop-intended', 'stopping', 'cleanup-failed')
          AND NOT EXISTS(SELECT 1 FROM factory.runtime_compute_wait WHERE attempt_id=factory.runtime_attempt.id)
      `;
      for (const attempt of attempts) {
        if (["create-intended", "starting", "ready"].includes(attempt.state)) {
          hub.allow(
            attempt.id,
            Number(attempt.generation),
            attempt.parentTokenHash,
            attempt.childTokenHash,
          );
        }
      }
      await database.client`
        UPDATE factory.runtime_attempt SET state = 'starting', updated_at = now()
        WHERE state = 'ready'
      `;
      const deferredCreates: Array<() => Promise<void>> = [];
      for (const attempt of attempts) {
        if (["starting", "ready"].includes(attempt.state)) {
          deferredCreates.push(async () => {
            const resources = await factorybox.startupResources(attempt.id);
            if (!resources) return;
            const pod = resources[0];
            if (!pod) return;
            await observeStartup(
              attempt.id,
              Reflect.get(pod.metadata.labels, "factory.dev/runtime-owner") ?? attempt.id,
              pod.metadata.namespace,
              pod.metadata.name,
              resources,
            );
          });
          continue;
        }
        if (attempt.state === "pausing") {
          deferredCreates.push(async () => {
            await this.pause(attempt.id);
          });
          continue;
        }
        if (attempt.state === "resuming") {
          deferredCreates.push(async () => {
            await factorybox.resume(attempt.id);
            if (hub.connected(attempt.id)) await updateStatus(attempt.id, "ready");
          });
          continue;
        }
        if (attempt.state === "create-intended") {
          const [preparation] = await database.client<
            Array<{ id: string }>
          >`SELECT id FROM factory.project_image_preparation WHERE runtime_attempt_id=${attempt.id}`;
          if (preparation) {
            deferredCreates.push(() => this.startProjectPrebuild(preparation.id));
            continue;
          }
          const recoverCreate = () => recoverCreateAttempt(attempt);
          // A warm slot can activate immediately. Start it only when the authenticated listener exists.
          if (await reserve?.assigned(database.client, attempt.id))
            deferredCreates.push(recoverCreate);
          else await recoverCreate();
        }
        if (attempt.state === "stop-intended") {
          await database.client`
            UPDATE factory.runtime_attempt SET state = 'stopping', updated_at = now()
            WHERE id = ${attempt.id} AND state = 'stop-intended'
          `;
          retryCleanup(attempt.id);
        } else if (attempt.state === "stopping" || attempt.state === "cleanup-failed") {
          retryCleanup(attempt.id);
        }
      }
      const observeConnections = recoveredConnectionObserver(attempts, {
        connected: (id) =>
          attempts.find((attempt) => attempt.id === id)?.isolatedKind === "prebuild"
            ? hub.parentConnected(id)
            : hub.connected(id),
        state: async (id) =>
          (
            await database.client<Array<{ state: string }>>`
            SELECT state FROM factory.runtime_attempt WHERE id = ${id}
          `
          )[0]?.state,
        disconnected: (id) =>
          this.status(id, "disconnected", "connectors did not return after Factory restart"),
      });
      const staging = await database.client<Array<{ projectID: string; userID: string }>>`
        SELECT staging.project_id AS "projectID", project.created_by AS "userID"
        FROM factory.staging_preview staging
        JOIN factory.project project ON project.id = staging.project_id
        LEFT JOIN factory.runtime_attempt attempt ON attempt.id=staging.runtime_attempt_id
        WHERE attempt.stop_intended_at IS NULL AND attempt.state IS DISTINCT FROM 'stopped'
      `;
      let observing = false;
      return () => {
        if (observing) return;
        observing = true;
        for (const create of deferredCreates)
          void create().catch(() => console.error("Reserved runtime recovery failed"));
        observeConnections();
        setTimeout(() => {
          void (async () => {
            for (const preview of staging) {
              await this.ensureStaging(preview.projectID, preview.userID).catch((cause) => {
                console.error("Staging recovery failed", cause);
              });
            }
          })();
        }, 1_000).unref();
      };
    },
    async start(projectID: string, userID: string) {
      await createAccessController(database).requireDevelopment(userID, projectID);
      await requireSetupReady(database.client, projectID);
      const workspaceIdentity = personalWorkspaceIdentity(projectID, userID);
      // Source preparation, infrastructure calls and result reads use the
      // application pool. Session coordination must not reserve one of its slots.
      const lock = database.coordination();
      try {
        await lock`SELECT pg_advisory_lock(hashtext(${`runtime:${workspaceIdentity.workspaceID}`}))`;
        const projects = await lock<
          Array<{
            id: string;
            repositoryUrl: string;
            defaultBranch: string;
            devcontainerPath: string;
          }>
        >`
        SELECT id, repository_url AS "repositoryUrl", default_branch AS "defaultBranch",
          devcontainer_path AS "devcontainerPath"
        FROM factory.project WHERE id = ${projectID}
      `;
        const project = projects[0];
        if (!project) throw new Error("Project not found");
        let workspaces = await lock<
          Array<{
            id: string;
            revision: string;
            namespace: string;
            volumeName: string;
          }>
        >`
          SELECT id, source_revision AS revision, kubernetes_namespace AS namespace,
            volume_name AS "volumeName"
          FROM factory.development_workspace
          WHERE project_id = ${projectID} AND kind = 'personal' AND owner_user_id = ${userID}
        `;
        if (!workspaces[0]) {
          const revision = await resolveRepositoryRevision(
            project.repositoryUrl,
            project.defaultBranch,
          );
          workspaces = await lock<
            Array<{ id: string; revision: string; namespace: string; volumeName: string }>
          >`
            INSERT INTO factory.development_workspace(
              id, project_id, kind, owner_user_id, source_branch, source_revision,
              kubernetes_namespace, volume_name, created_by
            ) VALUES (
              ${workspaceIdentity.workspaceID}, ${projectID}, 'personal', ${userID},
              ${project.defaultBranch}, ${revision}, ${workspaceIdentity.kubernetesNamespace},
              ${workspaceIdentity.volumeName}, ${userID}
            )
            RETURNING id, source_revision AS revision, kubernetes_namespace AS namespace,
              volume_name AS "volumeName"
          `;
        }
        const workspace = workspaces[0];
        if (!workspace) throw new Error("Personal Development Workspace was not created");
        const active = await lock<
          Array<{
            id: string;
            generation: string;
            parentTokenHash: string;
            childTokenHash: string;
          }>
        >`
        SELECT id, generation,
          parent_connector_token_hash AS "parentTokenHash",
          child_connector_token_hash AS "childTokenHash"
        FROM factory.runtime_attempt
        WHERE workspace_id = ${workspace.id}
          AND state IN ('create-intended', 'starting', 'ready', 'pausing', 'paused', 'resuming', 'stop-intended', 'stopping', 'cleanup-failed')
        LIMIT 1
      `;
        const existing = active[0];
        if (existing) {
          const current = await this.get(existing.id);
          const currentState = current?.state;
          if (currentState === "paused" || currentState === "resuming") {
            await factorybox.resume(existing.id);
            if (hub.connected(existing.id)) await updateStatus(existing.id, "ready");
            return this.get(existing.id);
          }
          if (["create-intended", "starting", "ready"].includes(String(currentState))) {
            hub.allow(
              existing.id,
              Number(existing.generation),
              existing.parentTokenHash,
              existing.childTokenHash,
            );
          }
          return current;
        }
        const generations = await lock<Array<{ generation: string }>>`
        SELECT COALESCE(MAX(generation), 0) + 1 AS generation
        FROM factory.runtime_attempt WHERE workspace_id = ${workspace.id}
      `;
        const generation = Number(generations[0]?.generation ?? 1);
        const attemptIdentity = runtimeIdentity(workspace.id, generation);
        const identity = { ...attemptIdentity, namespace: workspace.namespace };
        const revision = workspace.revision;
        const tokens = runtimeConnectorTokens(connectorSecret, identity.attemptID, generation);
        const token = tokens.parent;
        const childToken = tokens.child;
        const tokenHash = hashConnectorToken(token);
        const childTokenHash = hashConnectorToken(childToken);
        const repositoryURL = runtimeRepositoryURL(project.repositoryUrl, identity.attemptID);
        const systemContract = await resolveSystemContract(project.repositoryUrl, revision);
        await lock`BEGIN`;
        try {
          await admitOrWait(lock, identity.attemptID, projectID, "development");
          await lock`
        INSERT INTO factory.runtime_attempt(
          id, project_id, workspace_id, generation, revision, state,
          kubernetes_namespace, kubernetes_pod_name,
          parent_connector_token_hash, child_connector_token_hash,
          create_intended_at, created_by
        ) VALUES (
          ${identity.attemptID}, ${projectID}, ${workspace.id}, ${generation}, ${revision}, 'create-intended',
          ${identity.namespace}, ${identity.podName}, ${tokenHash}, ${childTokenHash}, now(), ${userID}
        )
      `;
          await lock`COMMIT`;
        } catch (cause) {
          await lock`ROLLBACK`;
          throw cause;
        }
        await artifactsFor(identity.attemptID, lock);
        if (await waiting(identity.attemptID)) return this.get(identity.attemptID);
        hub.allow(identity.attemptID, generation, tokenHash, childTokenHash);
        try {
          if (project.repositoryUrl.startsWith("file://")) {
            await prepareRuntimeRepository(identity.attemptID, project.repositoryUrl, revision);
          }
          const canonicalSource = await sources.prepareExecution(identity.attemptID);
          const artifacts = await artifactsFor(identity.attemptID, lock);
          const resources = renderRuntimeResources({
            ...identity,
            generation,
            projectID,
            runtimeOwnerID: workspace.id,
            repositoryURL,
            repositoryIdentity: projectID,
            preserveWorkspace: true,
            storageNode: canonicalSource.storageNode,
            revision,
            devcontainerPath: project.devcontainerPath,
            connectorToken: token,
            childConnectorToken: childToken,
            controlURL,
            runtimeHostImage: artifacts.runtimeHostImage,
            factoryboxProfile: artifacts.factoryboxProfile,
            environmentVersion: artifacts.environmentVersion,
            registryCA: await readRegistryCA(),
            systemContract,
          });
          await launchAttempt(
            identity.attemptID,
            {
              resources,
              namespace: identity.namespace,
              podName: identity.podName,
              missingPodMessage: "Runtime Pod was not observed after create",
              runtimeHostImage: artifacts.runtimeHostImage,
              factoryboxProfile: artifacts.factoryboxProfile,
              expectedNamespace: { ownerID: workspace.id, uid: canonicalSource.namespaceUID },
            },
            {
              observe: () =>
                observeStartup(
                  identity.attemptID,
                  workspace.id,
                  identity.namespace,
                  identity.podName,
                  resources,
                ),
              fail: async (phase, cause) => {
                if (phase === "observe") {
                  await updateStatus(
                    identity.attemptID,
                    "failed",
                    `startup observer failed: ${cause instanceof Error ? cause.message : "unknown error"}`,
                  );
                }
              },
            },
            lock,
          );
        } catch (cause) {
          const failure = cause instanceof Error ? cause.message : "runtime create failed";
          await lock`
          UPDATE factory.runtime_attempt SET state = 'stopping', failure = ${failure},
            updated_at = now() WHERE id = ${identity.attemptID}
        `;
          hub.revoke(identity.attemptID);
          retryCleanup(identity.attemptID);
          throw cause;
        }
        return this.get(identity.attemptID);
      } finally {
        try {
          await lock`SELECT pg_advisory_unlock(hashtext(${`runtime:${workspaceIdentity.workspaceID}`}))`;
        } finally {
          await lock.end({ timeout: 1 });
        }
      }
    },
    async ensureStaging(projectID: string, userID: string) {
      await requireSetupReady(database.client, projectID);
      const lock = database.coordination();
      try {
        await lock`SELECT pg_advisory_lock(hashtext(${`staging:${projectID}`}))`;
        const projects = await lock<
          Array<{ repositoryURL: string; defaultBranch: string; devcontainerPath: string }>
        >`
          SELECT repository_url AS "repositoryURL", default_branch AS "defaultBranch",
            devcontainer_path AS "devcontainerPath"
          FROM factory.project WHERE id = ${projectID}
        `;
        const project = projects[0];
        if (!project) throw new Error("Project not found");
        let previews = await lock<Array<{ revision: string; attemptID: string | null }>>`
          SELECT revision, runtime_attempt_id AS "attemptID"
          FROM factory.staging_preview WHERE project_id = ${projectID}
        `;
        if (!previews[0]) {
          const revision = await resolveRepositoryRevision(
            project.repositoryURL,
            project.defaultBranch,
          );
          previews = await lock<Array<{ revision: string; attemptID: string | null }>>`
            INSERT INTO factory.staging_preview(project_id, revision)
            VALUES (${projectID}, ${revision})
            RETURNING revision, runtime_attempt_id AS "attemptID"
          `;
        }
        const preview = previews[0];
        if (!preview) throw new Error("Staging Preview was not created");
        if (preview.attemptID) {
          const current = await this.get(preview.attemptID);
          if (
            current &&
            [
              "create-intended",
              "starting",
              "ready",
              "stop-intended",
              "stopping",
              "cleanup-failed",
            ].includes(current.state)
          ) {
            return current;
          }
        }
        const systemContract = await resolveSystemContract(project.repositoryURL, preview.revision);
        const generations = await lock<Array<{ generation: string }>>`
          SELECT COALESCE(MAX(generation), 0) + 1 AS generation
          FROM factory.runtime_attempt
          WHERE project_id = ${projectID} AND change_id IS NULL AND workspace_id IS NULL
        `;
        const generation = Number(generations[0]?.generation ?? 1);
        let identity = runtimeIdentity(`staging:${projectID}`, generation);
        const tokens = runtimeConnectorTokens(connectorSecret, identity.attemptID, generation);
        await lock`BEGIN`;
        try {
          const slot = await admitOrWait(lock, identity.attemptID, projectID, "staging", "staging");
          if (slot) identity = { ...identity, namespace: slot.namespace, podName: "slot" };
          await lock`
            INSERT INTO factory.runtime_attempt(
              id, project_id, isolated_kind, generation, revision, state, kubernetes_namespace,
              kubernetes_pod_name, parent_connector_token_hash, child_connector_token_hash,
              create_intended_at, created_by
            ) VALUES (
              ${identity.attemptID}, ${projectID}, 'staging', ${generation}, ${preview.revision},
              'create-intended', ${identity.namespace}, ${identity.podName},
              ${hashConnectorToken(tokens.parent)}, ${hashConnectorToken(tokens.child)}, now(),
              ${userID}
            )
          `;
          await artifactsFor(identity.attemptID, lock);
          await lock`
            UPDATE factory.staging_preview SET runtime_attempt_id = ${identity.attemptID},
              updated_at = now() WHERE project_id = ${projectID}
          `;
          await lock`COMMIT`;
        } catch (cause) {
          await lock`ROLLBACK`;
          throw cause;
        }
        await artifactsFor(identity.attemptID, lock);
        if (await waiting(identity.attemptID)) return this.get(identity.attemptID);
        hub.allow(
          identity.attemptID,
          generation,
          hashConnectorToken(tokens.parent),
          hashConnectorToken(tokens.child),
        );
        const repositoryURL = runtimeRepositoryURL(project.repositoryURL, identity.attemptID);
        try {
          if (project.repositoryURL.startsWith("file://")) {
            await prepareRuntimeRepository(
              identity.attemptID,
              project.repositoryURL,
              preview.revision,
            );
          }
          const artifacts = await artifactsFor(identity.attemptID, lock);
          const resources = renderRuntimeResources({
            ...identity,
            generation,
            projectID,
            repositoryURL,
            revision: preview.revision,
            devcontainerPath: project.devcontainerPath,
            connectorToken: tokens.parent,
            childConnectorToken: tokens.child,
            controlURL,
            runtimeHostImage: artifacts.runtimeHostImage,
            factoryboxProfile: artifacts.factoryboxProfile,
            environmentVersion: artifacts.environmentVersion,
            registryCA: await readRegistryCA(),
            mode: "staging",
            systemContract,
          });
          await launchAttempt(
            identity.attemptID,
            {
              resources,
              namespace: identity.namespace,
              podName: identity.podName,
              missingPodMessage: "Staging Pod was not observed after create",
              runtimeHostImage: artifacts.runtimeHostImage,
              factoryboxProfile: artifacts.factoryboxProfile,
            },
            {
              observe: () =>
                observeStartup(
                  identity.attemptID,
                  identity.attemptID,
                  identity.namespace,
                  identity.podName,
                  resources,
                ),
              fail: async (phase, cause) => {
                if (phase === "observe") {
                  await updateStatus(
                    identity.attemptID,
                    "failed",
                    `staging observer failed: ${cause instanceof Error ? cause.message : "unknown error"}`,
                  );
                }
              },
            },
            lock,
          );
        } catch (cause) {
          await lock`
            UPDATE factory.runtime_attempt SET state = 'stopping',
              failure = ${`Staging create failed: ${cause instanceof Error ? cause.message : "unknown error"}`},
              updated_at = now() WHERE id = ${identity.attemptID}
          `;
          hub.revoke(identity.attemptID);
          retryCleanup(identity.attemptID);
          throw cause;
        }
        return this.get(identity.attemptID);
      } finally {
        try {
          await lock`SELECT pg_advisory_unlock(hashtext(${`staging:${projectID}`}))`;
        } finally {
          await lock.end({ timeout: 1 });
        }
      }
    },
    async startPersisted(changeID: string, userID: string) {
      const workspaceIdentity = ticketWorkspaceIdentity(changeID);
      const lockRows = await database.client<Array<{ projectID: string }>>`
        SELECT project_id AS "projectID" FROM factory.change WHERE id = ${changeID}
      `;
      const projectID = lockRows[0]?.projectID;
      if (!projectID) throw new Error("Change not found");
      await requireSetupReady(database.client, projectID);
      const lock = database.coordination();
      try {
        await lock`SELECT pg_advisory_lock(hashtext(${`runtime:${workspaceIdentity.workspaceID}`}))`;
        const rows = await lock<
          Array<{
            changeID: string;
            baseSHA: string;
            changeState: string;
            runtimeAttemptID: string | null;
            repositoryURL: string;
            devcontainerPath: string;
            branchState: string;
            observedHeadSHA: string | null;
            ticketID: string;
            branchName: string;
          }>
        >`
          SELECT change.id AS "changeID", change.base_sha AS "baseSHA",
            change.state AS "changeState", change.runtime_attempt_id AS "runtimeAttemptID",
            change.ticket_id AS "ticketID", change.branch_name AS "branchName",
            project.repository_url AS "repositoryURL",
            project.devcontainer_path AS "devcontainerPath",
            operation.state AS "branchState", operation.observed_head_sha AS "observedHeadSHA"
          FROM factory.change change
          JOIN factory.project project ON project.id = change.project_id
          JOIN factory.branch_create_operation operation ON operation.change_id = change.id
          JOIN factory.ticket ticket ON ticket.id = change.ticket_id AND ticket.trashed_at IS NULL
          WHERE change.id = ${changeID}
        `;
        const row = rows[0];
        if (!row) throw new Error("Change not found");
        if (row.branchState !== "succeeded" || row.observedHeadSHA !== row.baseSHA) {
          throw new Error("Change branch is not ready at the persisted revision");
        }
        if (!["starting", "active", "failed"].includes(row.changeState)) {
          throw new Error("Change does not accept a Ticket Sandbox");
        }
        const [writing] = await lock<
          { state: string }[]
        >`SELECT state FROM factory.change_writer WHERE change_id=${changeID}`;
        if (writing?.state === "handoff" || writing?.state === "agent-preparing")
          throw new Error("Previous writer is being stopped. Compute cannot start during handoff.");
        const existingAttempt = row.runtimeAttemptID ? await this.get(row.runtimeAttemptID) : null;
        if (
          existingAttempt &&
          [
            "create-intended",
            "starting",
            "ready",
            "pausing",
            "paused",
            "resuming",
            "stop-intended",
            "stopping",
            "cleanup-failed",
          ].includes(existingAttempt.state)
        ) {
          if (["paused", "resuming"].includes(existingAttempt.state)) {
            await factorybox.resume(existingAttempt.id);
            if (hub.connected(existingAttempt.id)) await updateStatus(existingAttempt.id, "ready");
            return this.get(existingAttempt.id);
          }
          return existingAttempt;
        }
        let workspaces = await lock<Array<{ id: string; namespace: string; revision: string }>>`
          SELECT id, kubernetes_namespace AS namespace, source_revision AS revision
          FROM factory.development_workspace
          WHERE kind = 'ticket' AND change_id = ${changeID}
        `;
        if (!workspaces[0]) {
          workspaces = await lock<Array<{ id: string; namespace: string; revision: string }>>`
            INSERT INTO factory.development_workspace(
              id, project_id, kind, ticket_id, change_id, source_branch, source_revision,
              kubernetes_namespace, volume_name, created_by
            ) VALUES (
              ${workspaceIdentity.workspaceID}, ${projectID}, 'ticket', ${row.ticketID}, ${changeID},
              ${row.branchName}, ${row.baseSHA}, ${workspaceIdentity.kubernetesNamespace},
              ${workspaceIdentity.volumeName}, ${userID}
            )
            RETURNING id, kubernetes_namespace AS namespace, source_revision AS revision
          `;
        }
        const workspace = workspaces[0];
        if (!workspace) throw new Error("Ticket Workspace was not created");
        const systemContract = await resolveSystemContract(row.repositoryURL, workspace.revision);
        const generations = await lock<Array<{ generation: string }>>`
          SELECT COALESCE(MAX(generation), 0) + 1 AS generation
          FROM factory.runtime_attempt WHERE workspace_id = ${workspace.id}
        `;
        const generation = Number(generations[0]?.generation ?? 1);
        const attemptIdentity = runtimeIdentity(workspace.id, generation);
        const identity = { ...attemptIdentity, namespace: workspace.namespace };
        const tokens = runtimeConnectorTokens(connectorSecret, identity.attemptID, generation);
        const parent = tokens.parent;
        const child = tokens.child;
        await lock`BEGIN`;
        try {
          const current = await lock<Array<{ state: string }>>`
            SELECT state, runtime_attempt_id AS "runtimeAttemptID" FROM factory.change
            WHERE id = ${changeID} FOR UPDATE
          `;
          if (!["starting", "active", "failed"].includes(current[0]?.state ?? "")) {
            throw new Error("Change does not accept a Ticket Sandbox");
          }
          const [writer] = await lock<
            { state: string }[]
          >`SELECT state FROM factory.change_writer WHERE change_id=${changeID}`;
          if (writer?.state === "handoff" || writer?.state === "agent-preparing")
            throw new Error("Compute cannot start during editing handoff");
          await admitOrWait(lock, identity.attemptID, projectID, "development");
          await lock`
            INSERT INTO factory.runtime_attempt(
              id, project_id, change_id, workspace_id, generation, revision, state,
              kubernetes_namespace, kubernetes_pod_name,
              parent_connector_token_hash, child_connector_token_hash,
              create_intended_at, created_by
            ) VALUES (
              ${identity.attemptID}, ${projectID}, ${changeID}, ${workspace.id}, ${generation}, ${workspace.revision},
              'create-intended', ${identity.namespace}, ${identity.podName},
              ${hashConnectorToken(parent)}, ${hashConnectorToken(child)}, now(), ${userID}
            )
          `;
          await lock`
            UPDATE factory.change SET runtime_attempt_id = ${identity.attemptID},
              state = 'starting', failure = NULL, version = version + 1
            WHERE id = ${changeID}
          `;
          await lock`COMMIT`;
        } catch (cause) {
          await lock`ROLLBACK`;
          throw cause;
        }
        await artifactsFor(identity.attemptID, lock);
        if (await waiting(identity.attemptID)) return this.get(identity.attemptID);
        const repositoryURL = runtimeRepositoryURL(row.repositoryURL, identity.attemptID);
        hub.allow(
          identity.attemptID,
          generation,
          hashConnectorToken(parent),
          hashConnectorToken(child),
        );
        try {
          const canonicalSource = await sources.prepareExecution(identity.attemptID);
          const artifacts = await artifactsFor(identity.attemptID, lock);
          const resources = renderRuntimeResources({
            ...identity,
            generation,
            projectID,
            runtimeOwnerID: workspace.id,
            repositoryURL,
            repositoryIdentity: projectID,
            preserveWorkspace: true,
            storageNode: canonicalSource.storageNode,
            revision: workspace.revision,
            devcontainerPath: row.devcontainerPath,
            connectorToken: parent,
            childConnectorToken: child,
            controlURL,
            runtimeHostImage: artifacts.runtimeHostImage,
            factoryboxProfile: artifacts.factoryboxProfile,
            environmentVersion: artifacts.environmentVersion,
            registryCA: await readRegistryCA(),
            systemContract,
            agent: await agentConfiguration(
              database,
              changeID,
              connectorSecret,
              identity.attemptID,
              generation,
              artifacts.browserToolsImage,
            ),
          });
          await launchAttempt(
            identity.attemptID,
            {
              resources,
              namespace: identity.namespace,
              podName: identity.podName,
              missingPodMessage: "Change runtime Pod was not observed after create",
              runtimeHostImage: artifacts.runtimeHostImage,
              factoryboxProfile: artifacts.factoryboxProfile,
              expectedNamespace: { ownerID: workspace.id, uid: canonicalSource.namespaceUID },
            },
            {
              observe: () =>
                observeStartup(
                  identity.attemptID,
                  workspace.id,
                  identity.namespace,
                  identity.podName,
                  resources,
                ),
              fail: async (phase, cause) => {
                if (phase === "observe") {
                  await updateStatus(
                    identity.attemptID,
                    "failed",
                    `startup observer failed: ${cause instanceof Error ? cause.message : "unknown error"}`,
                  );
                }
              },
            },
            lock,
          );
        } catch (cause) {
          await lock`
            UPDATE factory.runtime_attempt SET state = 'stopping',
              failure = ${`Change runtime create failed: ${cause instanceof Error ? cause.message : "unknown error"}`},
              updated_at = now()
            WHERE id = ${identity.attemptID} AND state = 'create-intended'
          `;
          hub.revoke(identity.attemptID);
          retryCleanup(identity.attemptID);
          throw cause;
        }
        return this.get(identity.attemptID);
      } finally {
        try {
          await lock`SELECT pg_advisory_unlock(hashtext(${`runtime:${workspaceIdentity.workspaceID}`}))`;
        } finally {
          await lock.end({ timeout: 1 });
        }
      }
    },
    async startVerification(verificationID: string, userID: string) {
      const rows = await database.client<
        Array<{
          projectID: string;
          commitSHA: string;
          attemptID: string | null;
          attemptState: string | null;
          runnerUUID: string | null;
          runnerToken: string | null;
          repositoryURL: string;
          devcontainerPath: string;
        }>
      >`
        SELECT change.project_id AS "projectID", verification.commit_sha AS "commitSHA",
          verification.runtime_attempt_id AS "attemptID",
          attempt.state AS "attemptState",
          verification.runner_uuid AS "runnerUUID", verification.runner_token AS "runnerToken",
          project.repository_url AS "repositoryURL",
          project.devcontainer_path AS "devcontainerPath"
        FROM factory.verification verification
        JOIN factory.change change ON change.id = verification.change_id
        JOIN factory.project project ON project.id = change.project_id
        LEFT JOIN factory.runtime_attempt attempt ON attempt.id = verification.runtime_attempt_id
        WHERE verification.id = ${verificationID}
      `;
      const verification = rows[0];
      if (!verification) return null;
      if (!verification.runnerUUID || !verification.runnerToken) {
        throw new Error("Verification runner is not registered");
      }
      if (
        verification.attemptID &&
        ["create-intended", "starting", "ready", "stop-intended", "stopping"].includes(
          verification.attemptState ?? "",
        )
      )
        return this.get(verification.attemptID);
      const lock = database.coordination();
      try {
        await lock`SELECT pg_advisory_lock(hashtext(${`runtime:isolated:${verification.projectID}`}))`;
        const current = await lock<
          Array<{ attemptID: string | null; attemptState: string | null }>
        >`
          SELECT verification.runtime_attempt_id AS "attemptID", attempt.state AS "attemptState"
          FROM factory.verification verification
          LEFT JOIN factory.runtime_attempt attempt ON attempt.id = verification.runtime_attempt_id
          WHERE verification.id = ${verificationID} FOR UPDATE OF verification
        `;
        if (
          current[0]?.attemptID &&
          ["create-intended", "starting", "ready", "stop-intended", "stopping"].includes(
            current[0].attemptState ?? "",
          )
        )
          return this.get(current[0].attemptID);
        const generations = await lock<Array<{ generation: string }>>`
          SELECT COALESCE(MAX(generation), 0) + 1 AS generation
          FROM factory.runtime_attempt
          WHERE project_id = ${verification.projectID} AND isolated_kind IS NOT NULL
        `;
        const generation = Number(generations[0]?.generation ?? 1);
        let identity = runtimeIdentity(verificationID, generation);
        const tokens = runtimeConnectorTokens(connectorSecret, identity.attemptID, generation);
        await lock`BEGIN`;
        try {
          const active = await lock<Array<{ id: string }>>`
            SELECT verification.id FROM factory.verification verification
            JOIN factory.change change ON change.id = verification.change_id
            JOIN factory.ticket ticket ON ticket.id = change.ticket_id
            WHERE verification.id = ${verificationID}
              AND verification.state IN ('pending', 'runner-starting', 'running')
              AND change.state = 'active' AND change.cancel_requested_at IS NULL
              AND ticket.trashed_at IS NULL
              AND NOT EXISTS(SELECT 1 FROM factory.change_agent_session session WHERE session.change_id = change.id AND (session.state = 'stopped' OR session.stop_pending))
            FOR UPDATE OF change, ticket, verification
          `;
          if (!active[0]) {
            await lock`ROLLBACK`;
            return null;
          }
          const slot = await admitOrWait(
            lock,
            identity.attemptID,
            verification.projectID,
            "verification",
            "verification",
          );
          if (slot) identity = { ...identity, namespace: slot.namespace, podName: "slot" };
          await lock`
            INSERT INTO factory.runtime_attempt(
              id, project_id, verification_id, isolated_kind, generation, revision, state,
              kubernetes_namespace, kubernetes_pod_name,
              parent_connector_token_hash, child_connector_token_hash,
              create_intended_at, created_by
            ) VALUES (
              ${identity.attemptID}, ${verification.projectID}, ${verificationID}, 'verification',
              ${generation}, ${verification.commitSHA}, 'create-intended', ${identity.namespace},
              ${identity.podName}, ${hashConnectorToken(tokens.parent)},
              ${hashConnectorToken(tokens.child)}, now(), ${userID}
            )
          `;
          await artifactsFor(identity.attemptID, lock);
          await lock`
            UPDATE factory.verification SET runtime_attempt_id = ${identity.attemptID},
              state = 'runner-starting', updated_at = now()
            WHERE id = ${verificationID}
              AND state IN ('pending', 'runner-starting', 'running')
          `;
          await lock`COMMIT`;
        } catch (cause) {
          await lock`ROLLBACK`;
          throw cause;
        }
        await artifactsFor(identity.attemptID, lock);
        if (await waiting(identity.attemptID)) return this.get(identity.attemptID);
        hub.allow(
          identity.attemptID,
          generation,
          hashConnectorToken(tokens.parent),
          hashConnectorToken(tokens.child),
        );
        await launchIsolated(
          {
            identity,
            generation,
            projectID: verification.projectID,
            repositoryURL: verification.repositoryURL,
            revision: verification.commitSHA,
            devcontainerPath: verification.devcontainerPath,
            kind: "verification",
            parentToken: tokens.parent,
            childToken: tokens.child,
            verification: {
              runnerUUID: verification.runnerUUID,
              runnerToken: verification.runnerToken,
            },
          },
          lock,
        );
        return this.get(identity.attemptID);
      } finally {
        try {
          await lock`SELECT pg_advisory_unlock(hashtext(${`runtime:isolated:${verification.projectID}`}))`;
        } finally {
          await lock.end({ timeout: 1 });
        }
      }
    },
    async startPublication(publicationID: string, userID: string) {
      const lock = database.coordination();
      let projectLock: string | undefined;
      try {
        await lock`SELECT pg_advisory_lock(hashtextextended(${`publication-runtime:${publicationID}`},0))`;
        const [row] = await lock<
          {
            projectID: string;
            revision: string;
            version: string;
            runnerUUID: string;
            runnerToken: string;
            jobHandle: string;
            attemptID: string | null;
            repositoryURL: string;
            devcontainerPath: string;
          }[]
        >`SELECT release.project_id AS "projectID",release.commit_sha AS revision,release.version,
          publication.runner_uuid AS "runnerUUID",publication.runner_token AS "runnerToken",
          publication.job_handle AS "jobHandle",publication.runtime_attempt_id AS "attemptID",
          project.repository_url AS "repositoryURL",project.devcontainer_path AS "devcontainerPath"
          FROM factory.release_attempt publication JOIN factory.project_release release ON release.id=publication.release_id
          JOIN factory.project project ON project.id=release.project_id
          WHERE publication.id=${publicationID} AND publication.state='running' AND release.state='running'
            AND publication.id=(SELECT id FROM factory.release_attempt WHERE release_id=release.id ORDER BY ordinal DESC LIMIT 1)`;
        if (!row) throw new Error("Active publication intent is required");
        if (row.attemptID) return this.get(row.attemptID);
        if (!row.runnerUUID || !row.runnerToken || !row.jobHandle)
          throw new Error("Bound publication runner is required");
        await createAccessController(database).requireDevelopment(userID, row.projectID);
        projectLock = `runtime:isolated:${row.projectID}`;
        await lock`SELECT pg_advisory_lock(hashtext(${projectLock}))`;
        const [sequence] = await lock<{ generation: number }[]>`
          SELECT (COALESCE(MAX(generation),0)+1)::float8 AS generation FROM factory.runtime_attempt
          WHERE project_id=${row.projectID} AND isolated_kind IS NOT NULL`;
        const generation = sequence!.generation;
        const identity = runtimeIdentity(publicationID, generation);
        const tokens = runtimeConnectorTokens(connectorSecret, identity.attemptID, generation);
        await lock.begin(async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(hashtext(${`runtime:isolated:${row.projectID}`}))`;
          await admitOrWait(
            tx as unknown as Database["client"],
            identity.attemptID,
            row.projectID,
            "publication",
          );
          await tx`INSERT INTO factory.runtime_attempt(id,project_id,isolated_kind,generation,revision,state,kubernetes_namespace,kubernetes_pod_name,
            parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
            VALUES(${identity.attemptID},${row.projectID},'publication',${generation},${row.revision},'create-intended',${identity.namespace},${identity.podName},
            ${hashConnectorToken(tokens.parent)},${hashConnectorToken(tokens.child)},now(),${userID})`;
          await tx`UPDATE factory.release_attempt SET runtime_attempt_id=${identity.attemptID} WHERE id=${publicationID}`;
          await artifactsFor(identity.attemptID, tx as unknown as Database["client"]);
        });
        if (await waiting(identity.attemptID)) return this.get(identity.attemptID);
        hub.allow(
          identity.attemptID,
          generation,
          hashConnectorToken(tokens.parent),
          hashConnectorToken(tokens.child),
        );
        await launchIsolated(
          {
            identity,
            generation,
            projectID: row.projectID,
            repositoryURL: row.repositoryURL,
            revision: row.revision,
            devcontainerPath: row.devcontainerPath,
            kind: "publication",
            parentToken: tokens.parent,
            childToken: tokens.child,
            verification: {
              runnerUUID: row.runnerUUID,
              runnerToken: row.runnerToken,
              jobHandle: row.jobHandle,
              publicationID,
              version: row.version,
            },
          },
          lock,
        );
        return this.get(identity.attemptID);
      } finally {
        try {
          if (projectLock) await lock`SELECT pg_advisory_unlock(hashtext(${projectLock}))`;
          await lock`SELECT pg_advisory_unlock(hashtextextended(${`publication-runtime:${publicationID}`},0))`;
        } finally {
          await lock.end({ timeout: 1 });
        }
      }
    },
    async startStagingReplacement(promotionID: string, userID: string) {
      const rows = await database.client<
        Array<{
          projectID: string;
          commitSHA: string;
          attemptID: string | null;
          repositoryURL: string;
          devcontainerPath: string;
        }>
      >`
        SELECT promotion.project_id AS "projectID", promotion.commit_sha AS "commitSHA",
          promotion.replacement_runtime_attempt_id AS "attemptID",
          project.repository_url AS "repositoryURL",
          project.devcontainer_path AS "devcontainerPath"
        FROM factory.promotion_operation promotion
        JOIN factory.project project ON project.id = promotion.project_id
        WHERE promotion.id = ${promotionID}
      `;
      const promotion = rows[0];
      if (!promotion) throw new Error("Promotion was not found");
      if (promotion.attemptID) return this.get(promotion.attemptID);
      const lock = database.coordination();
      try {
        await lock`SELECT pg_advisory_lock(hashtext(${`runtime:isolated:${promotion.projectID}`}))`;
        const current = await lock<Array<{ attemptID: string | null }>>`
          SELECT replacement_runtime_attempt_id AS "attemptID"
          FROM factory.promotion_operation WHERE id = ${promotionID} FOR UPDATE
        `;
        if (current[0]?.attemptID) return this.get(current[0].attemptID);
        const generations = await lock<Array<{ generation: string }>>`
          SELECT COALESCE(MAX(generation), 0) + 1 AS generation
          FROM factory.runtime_attempt
          WHERE project_id = ${promotion.projectID} AND isolated_kind IS NOT NULL
        `;
        const generation = Number(generations[0]?.generation ?? 1);
        let identity = runtimeIdentity(`staging:${promotion.projectID}`, generation);
        const tokens = runtimeConnectorTokens(connectorSecret, identity.attemptID, generation);
        await lock`BEGIN`;
        try {
          const slot = await admitOrWait(
            lock,
            identity.attemptID,
            promotion.projectID,
            "staging",
            "staging",
          );
          if (slot) identity = { ...identity, namespace: slot.namespace, podName: "slot" };
          await lock`
            INSERT INTO factory.runtime_attempt(
              id, project_id, isolated_kind, generation, revision, state,
              kubernetes_namespace, kubernetes_pod_name,
              parent_connector_token_hash, child_connector_token_hash,
              create_intended_at, created_by
            ) VALUES (
              ${identity.attemptID}, ${promotion.projectID}, 'staging', ${generation},
              ${promotion.commitSHA}, 'create-intended', ${identity.namespace}, ${identity.podName},
              ${hashConnectorToken(tokens.parent)}, ${hashConnectorToken(tokens.child)}, now(),
              ${userID}
            )
          `;
          await artifactsFor(identity.attemptID, lock);
          await lock`
            UPDATE factory.promotion_operation
            SET replacement_runtime_attempt_id = ${identity.attemptID}, state = 'starting',
              updated_at = now()
            WHERE id = ${promotionID} AND state = 'pending'
          `;
          await lock`COMMIT`;
        } catch (cause) {
          await lock`ROLLBACK`;
          throw cause;
        }
        await artifactsFor(identity.attemptID, lock);
        if (await waiting(identity.attemptID)) return this.get(identity.attemptID);
        hub.allow(
          identity.attemptID,
          generation,
          hashConnectorToken(tokens.parent),
          hashConnectorToken(tokens.child),
        );
        await launchIsolated(
          {
            identity,
            generation,
            projectID: promotion.projectID,
            repositoryURL: promotion.repositoryURL,
            revision: promotion.commitSHA,
            devcontainerPath: promotion.devcontainerPath,
            kind: "staging",
            parentToken: tokens.parent,
            childToken: tokens.child,
          },
          lock,
        );
        return this.get(identity.attemptID);
      } finally {
        try {
          await lock`SELECT pg_advisory_unlock(hashtext(${`runtime:isolated:${promotion.projectID}`}))`;
        } finally {
          await lock.end({ timeout: 1 });
        }
      }
    },
    async get(attemptID: string) {
      const attempts = await database.client<RuntimeAttemptView[]>`
        SELECT attempt.id, attempt.project_id AS "projectId", attempt.change_id AS "changeId",
          attempt.workspace_id AS "workspaceId", workspace.kind AS "workspaceKind",
          workspace.owner_user_id AS "ownerUserId", attempt.generation, attempt.revision,
          COALESCE(attempt.isolated_kind::text, workspace.kind::text) AS "runtimeKind",
          COALESCE(staging.runtime_attempt_id = attempt.id, false) AS "currentStaging",
          attempt.state, (SELECT reason FROM factory.runtime_compute_wait WHERE attempt_id=attempt.id) AS "computeWait", attempt.kubernetes_namespace AS "kubernetesNamespace",
          attempt.kubernetes_pod_name AS "kubernetesPodName", attempt.failure,
          attempt.created_at AS "createdAt", attempt.updated_at AS "updatedAt"
        FROM factory.runtime_attempt attempt
        LEFT JOIN factory.development_workspace workspace ON workspace.id = attempt.workspace_id
        LEFT JOIN factory.staging_preview staging ON staging.project_id = attempt.project_id
        WHERE attempt.id = ${attemptID}
      `;
      return attempts[0] ?? null;
    },
    async processOutput(attemptID: string) {
      const attempts = await database.client<Array<{ state: string }>>`
        SELECT state FROM factory.runtime_attempt WHERE id = ${attemptID}
      `;
      const attempt = attempts[0];
      if (!attempt) throw new Error("Runtime Attempt does not exist");
      if (!["starting", "ready"].includes(attempt.state)) {
        return { processes: [{ name: "app", state: attempt.state, output: "" }] };
      }
      const processes = hub.processes(attemptID);
      return {
        processes: processes.length
          ? processes
          : [
              {
                name: "app",
                state: attempt.state === "ready" ? "running" : "starting",
                output: "",
              },
            ],
      };
    },
    async processAction(attemptID: string, process: string, action: "start" | "stop" | "restart") {
      const attempts = await database.client<Array<{ ready: boolean; development: boolean }>>`
        SELECT state = 'ready' AS ready, workspace_id IS NOT NULL AS development
        FROM factory.runtime_attempt
        WHERE id = ${attemptID}
      `;
      const attempt = attempts[0];
      if (!attempt?.ready || !attempt.development) {
        throw new Error("Development Workspace is not ready");
      }
      if (!hub.hasAppChannel(attemptID, process)) {
        throw new Error("Declared App process does not exist");
      }
      await hub.childOperation(attemptID, {
        operationId: crypto.randomUUID(),
        action: `process-${action}`,
        process,
      });
      return this.processOutput(attemptID);
    },
    async closeTerminal(attemptID: string, terminalID: string) {
      const attempts = await database.client<Array<{ ready: boolean; development: boolean }>>`
        SELECT state = 'ready' AS ready, workspace_id IS NOT NULL AS development
        FROM factory.runtime_attempt
        WHERE id = ${attemptID}
      `;
      const attempt = attempts[0];
      if (!attempt?.ready || !attempt.development) {
        throw new Error("Development Workspace is not ready");
      }
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(terminalID)) {
        throw new Error("Terminal session is invalid");
      }
      await hub.childOperation(attemptID, {
        operationId: crypto.randomUUID(),
        action: "terminal-close",
        terminalId: terminalID,
      });
      return { closed: true };
    },
    async list(projectID: string | undefined, userID: string) {
      return database.client<RuntimeAttemptView[]>`
        SELECT attempt.id, attempt.project_id AS "projectId", attempt.change_id AS "changeId",
          attempt.workspace_id AS "workspaceId", workspace.kind AS "workspaceKind",
          workspace.owner_user_id AS "ownerUserId", attempt.generation, attempt.revision,
          COALESCE(attempt.isolated_kind::text, workspace.kind::text) AS "runtimeKind",
          attempt.state, (SELECT reason FROM factory.runtime_compute_wait WHERE attempt_id=attempt.id) AS "computeWait", attempt.failure, attempt.created_at AS "createdAt",
          COALESCE(staging.runtime_attempt_id = attempt.id, false) AS "currentStaging",
          attempt.updated_at AS "updatedAt"
        FROM factory.runtime_attempt attempt
        LEFT JOIN factory.development_workspace workspace ON workspace.id = attempt.workspace_id
        LEFT JOIN factory.staging_preview staging ON staging.project_id = attempt.project_id
        WHERE (${projectID ?? null}::uuid IS NULL OR attempt.project_id = ${projectID ?? null})
          AND attempt.isolated_kind IS DISTINCT FROM 'prebuild'
          AND (workspace.kind IS DISTINCT FROM 'personal' OR workspace.owner_user_id = ${userID})
          AND (EXISTS(SELECT 1 FROM factory.administrator WHERE user_id = ${userID})
            OR EXISTS(SELECT 1 FROM factory.project_membership
              WHERE project_id = attempt.project_id AND user_id = ${userID}))
          AND (${projectID ?? null}::uuid IS NULL OR attempt.state NOT IN ('stopped', 'failed') OR staging.runtime_attempt_id = attempt.id OR attempt.id IN (
            SELECT DISTINCT ON (COALESCE(workspace_id::text, isolated_kind::text || ':' || COALESCE(change_id::text, project_id::text))) id
            FROM factory.runtime_attempt WHERE project_id = ${projectID ?? null}
            ORDER BY COALESCE(workspace_id::text, isolated_kind::text || ':' || COALESCE(change_id::text, project_id::text)), generation DESC, created_at DESC
          ))
        ORDER BY attempt.created_at DESC
      `;
    },
    status: updateStatus,
    async stop(attemptID: string) {
      clearReconnectObservation(attemptID);
      const projects = await database.client<Array<{ projectID: string }>>`
        SELECT project_id AS "projectID" FROM factory.runtime_attempt WHERE id = ${attemptID}
      `;
      const projectID = projects[0]?.projectID;
      if (!projectID) throw new Error("Runtime Attempt is not active");
      const lock = database.coordination();
      try {
        await lock`SELECT pg_advisory_lock(hashtext(${`runtime:${projectID}`}))`;
        const [failed] = await lock<{ id: string }[]>`
          UPDATE factory.runtime_attempt SET stop_intended_at=COALESCE(stop_intended_at,now()),cleanup_attempts=0,updated_at=now()
          WHERE id=${attemptID} AND state='failed' RETURNING id`;
        if (failed) {
          // Do not move a terminal old generation back into the unique active
          // allocation. Persist Stop first, then confirm generation/UID-bound cleanup.
          hub.suspend(attemptID);
          try {
            await withResourceLock(attemptID, (sql) => cleanupResources(sql, attemptID), lock);
          } catch (cause) {
            if (!(cause instanceof KubernetesObservationUnavailableError)) throw cause;
            // This failed generation must not re-enter active allocation. Retain
            // Stop and reconcile its exact resources without another user action.
            retryCleanup(attemptID);
            return this.get(attemptID);
          }
          await lock`UPDATE factory.runtime_attempt SET state='stopped',stopped_at=now(),failure=NULL,updated_at=now()
            WHERE id=${attemptID} AND state='failed' AND stop_intended_at IS NOT NULL`;
          return this.get(attemptID);
        }
        const attempts = await database.client<
          Array<{
            namespace: string;
            namespaceUID: string;
            podName: string;
            generation: string;
            uid: string | null;
          }>
        >`
        UPDATE factory.runtime_attempt SET
          state = CASE WHEN state = 'stopping'
            THEN 'stopping'::factory.runtime_attempt_state
            ELSE 'stop-intended'::factory.runtime_attempt_state END,
          cleanup_attempts = CASE WHEN state = 'cleanup-failed' THEN 0 ELSE cleanup_attempts END,
          stop_intended_at = now(), updated_at = now()
        WHERE id = ${attemptID}
          AND state IN ('create-intended', 'starting', 'ready', 'pausing', 'paused', 'resuming', 'stop-intended', 'stopping', 'cleanup-failed')
        RETURNING kubernetes_namespace AS namespace,
          kubernetes_namespace_uid AS "namespaceUID", kubernetes_pod_name AS "podName",
          generation, kubernetes_uid AS uid
        `;
        const attempt = attempts[0];
        if (!attempt) return this.get(attemptID);
        hub.suspend(attemptID);
        if (!hub.stop(attemptID)) {
          await database.client`
            UPDATE factory.runtime_attempt SET state = 'stopping', updated_at = now()
            WHERE id = ${attemptID} AND state = 'stop-intended'
          `;
          retryCleanup(attemptID);
        } else {
          setTimeout(async () => {
            const current = await database.client<Array<{ state: string }>>`
            SELECT state FROM factory.runtime_attempt WHERE id = ${attemptID}
          `;
            if (!["stop-intended", "stopping"].includes(current[0]?.state ?? "")) return;
            await database.client`
              UPDATE factory.runtime_attempt SET state = 'stopping', updated_at = now()
              WHERE id = ${attemptID} AND state = 'stop-intended'
            `;
            retryCleanup(attemptID);
          }, 30_000);
        }
        return this.get(attemptID);
      } finally {
        try {
          await lock`SELECT pg_advisory_unlock(hashtext(${`runtime:${projectID}`}))`;
        } finally {
          await lock.end({ timeout: 1 });
        }
      }
    },
  };
}
