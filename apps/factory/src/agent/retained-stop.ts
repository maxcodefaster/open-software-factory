import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import type { createDatabase } from "../../../../packages/db/src/client";
import {
  createRetainedStopClient,
  type RetainedStopClient,
  type RetainedStopDeclaration,
} from "../../../../packages/runtime-kubernetes/src/retained-stop";
import upstream from "../../../../upstream.json";
import { factoryBuildDirectory } from "../build-directory";
import type { createRuntimeController } from "../runtime/controller";
import { createFactoryboxExecution } from "../runtime/factorybox";
import type { RuntimeHub } from "../runtime/hub";
import { retainedStopInput, retainedStopResult } from "./retained-stop-contract";
import type { RetainedStopTarget } from "./stop";

type Database = ReturnType<typeof createDatabase>;
type Source = {
  actorID: string;
  state: string;
  modelID: string;
  workspaceID: string;
  projectID: string;
  workerID: string;
  namespace: string;
  namespaceUID: string;
  claimUID: string;
  sourcePodUID: string;
  resourceKey: string;
  storageNode: string;
  sourceDirectory: string;
  image: string;
};
type Kind = "intent" | "attempt" | "receipt" | "proof" | "completed" | "failure" | "successor";
function operationID(stopID: string, kind: Kind) {
  const bytes = createHash("sha256").update(`factory-retained-stop:${stopID}:${kind}`).digest();
  bytes[6] = ((bytes[6] ?? 0) & 15) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 63) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function createRetainedStopSettlement(
  database: Database,
  runtime: Pick<ReturnType<typeof createRuntimeController>, "stop">,
  hub: RuntimeHub,
  client: RetainedStopClient = createRetainedStopClient(),
  native: Pick<
    ReturnType<typeof createFactoryboxExecution>,
    "hasExited"
  > = createFactoryboxExecution(database, hub),
  readRunner = () => readFile(resolve(factoryBuildDirectory(), "retained-stop-runner.mjs"), "utf8"),
  maintenanceImage = process.env["FACTORY_RUNTIME_HOST_IMAGE"],
) {
  async function source(target: RetainedStopTarget) {
    const [row] = await database.client<Source[]>`
      SELECT turn.created_by AS "actorID",attempt.state,
        (SELECT original.authority->>'modelId' FROM factory.agent_turn original
          JOIN factory.change_agent_turn_intent first_input ON first_input.turn_id=original.id
          WHERE original.change_id=session.change_id AND first_input.session_id=session.opencode_session_id
          ORDER BY original.created_at,original.id LIMIT 1) AS "modelID",
        workspace.id AS "workspaceID",workspace.project_id AS "projectID",
        worker.id AS "workerID",workspace.kubernetes_namespace AS namespace,
        source.namespace_uid AS "namespaceUID",source.claim_uid AS "claimUID",
        source.pod_uid AS "sourcePodUID",source.resource_key AS "resourceKey",
        source.storage_node AS "storageNode",source.source_directory AS "sourceDirectory",
        artifact.runtime_host_image AS image
      FROM factory.change_agent_session session
      JOIN factory.change change ON change.id=session.change_id
      JOIN factory.change_agent_turn_intent intent ON intent.turn_id=session.stop_turn_id
      JOIN factory.agent_turn turn ON turn.id=intent.turn_id
      JOIN factory.runtime_attempt attempt ON attempt.id=session.runtime_attempt_id
      JOIN factory.runtime_artifact_intent artifact ON artifact.runtime_attempt_id=attempt.id
      JOIN factory.development_workspace workspace ON workspace.id=attempt.workspace_id
      JOIN factory.workspace_source source ON source.workspace_id=workspace.id
      JOIN factory.factorybox_worker worker ON worker.id=workspace.factorybox_worker_id
      WHERE session.change_id=${target.changeID} AND session.state='stopped'
        AND session.stop_pending AND session.stop_id=${target.stopID}
        AND session.runtime_attempt_id=${target.attemptID}
        AND change.runtime_attempt_id=${target.attemptID}
        AND session.opencode_session_id=${target.sessionID}
        AND intent.session_id=${target.sessionID} AND intent.prompt_id=${target.promptID}
        AND intent.runtime_attempt_id=${target.attemptID} AND turn.state='stopped'
        AND attempt.state IN ('failed','cleanup-failed','stopped')
        AND source.state='ready' AND source.namespace_uid=worker.namespace_uid
        AND source.claim_uid=worker.source_claim_uid
        AND source.namespace_uid IS NOT NULL AND source.claim_uid IS NOT NULL
        AND source.pod_uid IS NOT NULL AND source.storage_node IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt other
          WHERE other.workspace_id=workspace.id AND other.id<>attempt.id
            AND other.state NOT IN ('failed','stopped'))`;
    return row;
  }
  return async (target: RetainedStopTarget, signal?: AbortSignal): Promise<boolean> => {
    const current = await source(target);
    if (!current || hub.connected(target.attemptID)) return false;
    const actorID = current.actorID;
    const input = {
      action: "retained-native-stop",
      changeID: target.changeID,
      stopID: target.stopID,
      attemptID: target.attemptID,
      sessionID: target.sessionID,
      promptID: target.promptID,
    };
    async function record(kind: Kind, result?: unknown, recoveryID = target.stopID) {
      const id = operationID(recoveryID, kind);
      const [old] = await database.client<{ scope: string; input: unknown; result: unknown }[]>`
        SELECT scope,input,result FROM factory.execution_policy_command WHERE command_id=${id}`;
      const scope =
        recoveryID === target.stopID
          ? `retained-native-stop:${target.changeID}:${kind}`
          : `retained-native-stop:${target.changeID}:${recoveryID}:${kind}`;
      const boundInput = recoveryID === target.stopID ? input : { ...input, recoveryID };
      if (old) {
        if (old.scope !== scope || !same(old.input, boundInput))
          throw new Error("Retained Stop operation identity changed");
        return old.result;
      }
      if (result === undefined) return undefined;
      await database.client`INSERT INTO factory.execution_policy_command
        (command_id,scope,actor_id,input,result)
        VALUES(${id},${scope},${actorID},
          ${JSON.stringify(boundInput)}::jsonb,${JSON.stringify(result)}::jsonb)`;
      return result;
    }
    const sourceIdentity = {
      workspaceID: current.workspaceID,
      namespaceUID: current.namespaceUID,
      claimUID: current.claimUID,
      sourceDirectory: current.sourceDirectory,
      image: current.image,
    };
    const completed = (await record("completed")) as
      | { result: unknown; source: unknown }
      | undefined;
    if (completed) {
      const result = retainedStopResult.parse(completed.result);
      return (
        current.state === "stopped" &&
        same(completed.source, sourceIdentity) &&
        same(result, {
          ...retainedStopInput.parse({
            stopID: target.stopID,
            attemptID: target.attemptID,
            sessionID: target.sessionID,
            promptID: target.promptID,
            modelID: current.modelID,
            version: upstream.openCode.version,
          }),
          confirmed: true,
          nativeProcessExited: true,
        })
      );
    }
    // The explicit read-only confirmation cannot create infrastructure, stop
    // compute, interrupt native work or clean up a Pod.
    if (target.mode === "observe") return false;
    const lock = database.coordination();
    let locked = false;
    try {
      const [owner] = await lock<{ acquired: boolean }[]>`
        SELECT pg_try_advisory_lock(hashtextextended(
          ${`retained-native-stop:${current.workerID}`},0)) AS acquired`;
      if (!owner?.acquired) return false;
      locked = true;
      signal?.throwIfAborted();
      const fresh = await source(target);
      if (!fresh || hub.connected(target.attemptID)) return false;
      if (!(await native.hasExited(target.attemptID))) return false;
      if (fresh.state !== "stopped") {
        await runtime.stop(target.attemptID);
        const stopped = await source(target);
        if (stopped?.state !== "stopped") return false;
      }
      if (!maintenanceImage || !/^[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}$/.test(maintenanceImage))
        throw new Error("Retained Stop requires the published, pinned Factory runtime tools image");
      const runner = await readRunner();
      const nativeInput = retainedStopInput.parse({
        stopID: target.stopID,
        attemptID: target.attemptID,
        sessionID: target.sessionID,
        promptID: target.promptID,
        modelID: fresh.modelID,
        version: upstream.openCode.version,
      });
      let recoveryID = target.stopID;
      for (;;) {
        signal?.throwIfAborted();
        const declaration: RetainedStopDeclaration = {
          ...nativeInput,
          ...(recoveryID !== target.stopID ? { recoveryID } : {}),
          workspaceID: fresh.workspaceID,
          projectID: fresh.projectID,
          workerID: fresh.workerID,
          namespace: fresh.namespace,
          namespaceUID: fresh.namespaceUID,
          claimUID: fresh.claimUID,
          sourcePodName: `source-${fresh.resourceKey}`,
          sourcePodUID: fresh.sourcePodUID,
          storageNode: fresh.storageNode,
          sourceDirectory: fresh.sourceDirectory,
          image: maintenanceImage,
          runnerSHA256: createHash("sha256").update(runner).digest("hex"),
          input: nativeInput,
        };
        const saved = (await record("intent", undefined, recoveryID)) as
          | RetainedStopDeclaration
          | undefined;
        const intended = saved ?? declaration;
        if (!saved) await record("intent", intended, recoveryID);
        // Reopening an existing observation uses the original runner declaration.
        // A newer build may observe it, but cannot replace its selected program.
        if (
          !same(
            { ...intended, image: declaration.image, runnerSHA256: declaration.runnerSHA256 },
            declaration,
          )
        )
          throw new Error("Retained Stop Source or native artifact changed");
        const successor = (await record("successor", undefined, recoveryID)) as
          | { recoveryID: string; previousUID: string }
          | undefined;
        if (successor) {
          const failure = (await record("failure", undefined, recoveryID)) as
            | { uid: string; terminal: string }
            | undefined;
          if (
            !failure ||
            failure.uid !== successor.previousUID ||
            !["exited", "not-started"].includes(failure.terminal)
          )
            throw new Error("Native Stop successor has no exact terminal predecessor proof");
          await client.remove(intended, successor.previousUID);
          recoveryID = successor.recoveryID;
          continue;
        }
        const proof = (await record("proof", undefined, recoveryID)) as
          | { uid: string; result: unknown }
          | undefined;
        if (proof) {
          const result = retainedStopResult.parse(proof.result);
          if (!same(result, { ...nativeInput, confirmed: true, nativeProcessExited: true }))
            throw new Error("Retained Stop proof belongs to another native input");
          await client.remove(intended, proof.uid);
          await record("completed", { result, source: sourceIdentity });
          return true;
        }
        let observed = await client.observe(intended, signal);
        const attempted = await record("attempt", undefined, recoveryID);
        if (observed && !attempted)
          throw new Error("A native Stop Pod exists without its recorded create attempt");
        if (!observed) {
          if (attempted)
            throw new Error("Retained Stop create outcome is unconfirmed; its Pod is absent");
          if (
            intended.runnerSHA256 !== declaration.runnerSHA256 ||
            intended.image !== declaration.image
          )
            throw new Error("The original native Stop runner is unavailable");
          // This receipt is committed before the single external create.
          await record("attempt", { attempted: true }, recoveryID);
          observed = await client.create(intended, runner);
        }
        const receipt = (await record("receipt", undefined, recoveryID)) as
          | { uid: string }
          | undefined;
        if (receipt && receipt.uid !== observed.uid)
          throw new Error("Retained Stop Pod UID changed");
        if (!receipt) await record("receipt", { uid: observed.uid }, recoveryID);
        while (!["Succeeded", "Failed"].includes(observed.phase)) {
          signal?.throwIfAborted();
          await Bun.sleep(500);
          const next = await client.observe(intended, signal);
          if (!next || next.uid !== observed.uid)
            throw new Error("Retained Stop Pod disappeared or changed identity");
          observed = next;
        }
        if (observed.phase === "Failed") {
          const changedProgram =
            intended.image !== declaration.image ||
            intended.runnerSHA256 !== declaration.runnerSHA256;
          if (!observed.terminal || !changedProgram)
            throw new Error("The retained native Stop process failed; no replacement was started");
          const nextID = operationID(
            `${recoveryID}:${observed.uid}:${declaration.image}:${declaration.runnerSHA256}`,
            "successor",
          );
          await record("failure", { uid: observed.uid, terminal: observed.terminal }, recoveryID);
          await record("successor", { recoveryID: nextID, previousUID: observed.uid }, recoveryID);
          await client.remove(intended, observed.uid);
          recoveryID = nextID;
          continue;
        }
        const result = retainedStopResult.parse(observed.result);
        if (!same(result, { ...nativeInput, confirmed: true, nativeProcessExited: true }))
          throw new Error("Retained Stop returned another native input");
        await record("proof", { uid: observed.uid, result }, recoveryID);
        await client.remove(intended, observed.uid);
        await record("completed", { result, source: sourceIdentity });
        return true;
      }
    } finally {
      try {
        if (locked)
          await lock`SELECT pg_advisory_unlock(hashtextextended(
            ${`retained-native-stop:${current.workerID}`},0))`;
      } finally {
        await lock.end({ timeout: 1 });
      }
    }
  };
}
