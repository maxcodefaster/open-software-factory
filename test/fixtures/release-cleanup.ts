import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { z } from "zod";
import { deliveryViewSchema } from "../../apps/factory/src/delivery/contracts";
import {
  attemptsResponseSchema,
  runtimeAttemptSchema,
} from "../../apps/factory/src/runtime/contracts";
import { requireSubstrateActor } from "../../apps/factory/src/runtime/substrate";
import { absentBoundNativeResource } from "../../apps/factory/src/runtime/substrate-bound-provisioning";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { systemContract } from "../../packages/system-contract/src/system-contract";
import { readResetResources } from "../../scripts/factory/reset-resources";
import {
  editorFixtureNamespaces,
  requireOwnedProjectSourceRetention,
} from "./editor-source-resources";
import { eventually } from "./factory-process";
import {
  readReleaseNativeBinding,
  readReleaseNativeTemplate,
  type releaseInstallation,
} from "./release-installation";
import { callFactoryFunction } from "./server-functions";

type Fixture = Awaited<ReturnType<typeof releaseInstallation>>;

export function releaseSourceFile(value: unknown) {
  // The native Go Source File's []byte content is base64 JSON, not UTF-8 text.
  const file = z
    .object({ content: z.base64(), version: z.string().regex(/^[a-f0-9]{64}$/) })
    .parse(value);
  const bytes = Buffer.from(file.content, "base64");
  if (createHash("sha256").update(bytes).digest("hex") !== file.version)
    throw new Error("Retained release Source bytes differ from their reported version");
  return {
    version: file.version,
    contract: systemContract.parse(JSON.parse(bytes.toString("utf8"))),
  };
}

export async function releaseCleanup(f: Fixture) {
  const { state, database } = f;
  const { projectID, changeID, dependentChangeID } = state;
  if (!projectID || !changeID || !dependentChangeID || !state.completed.includes("final-visuals"))
    throw new Error("Final release journey and visuals required before owned cleanup");
  const projects = await database.client<Array<{ id: string; slug: string; repository: string }>>`
    SELECT id, slug, repository_url AS repository FROM factory.project`;
  expect([...projects]).toEqual([{ id: projectID, slug: f.slug, repository: f.repositoryURL }]);
  const cookie = await f.login("developer");
  const namespacesBefore = await editorFixtureNamespaces();
  // Include isolated Verification/prebuild attempts omitted from the customer
  // runtime list. Rejected/uncreated bindings refuse before any cleanup effect.
  const attempts = await database.client<{ id: string }[]>`
    SELECT id FROM factory.runtime_attempt WHERE project_id=${projectID} ORDER BY id`;
  const owned = await Promise.all(
    attempts.map(({ id }) => readReleaseNativeBinding(database, projectID, id)),
  );
  for (const binding of owned) {
    const actor = await absentBoundNativeResource(
      f.native(binding.intent.connection).call,
      "GetActor",
      {
        actor: { atespace: binding.atespace, name: binding.actorName },
      },
    );
    if (actor && binding.deletedAt)
      throw new Error("Recorded stopped release Actor is still present");
    if (actor) requireSubstrateActor(actor, binding);
    else if (!binding.deletedAt)
      throw new Error("Original release Actor absence has no confirmed Stop");
  }
  const readSources = async () => {
    const sources = [];
    for (const workspaceID of new Set(
      owned.flatMap((binding) => (binding.workspaceID ? [binding.workspaceID] : [])),
    )) {
      const response = await fetch(`${f.base}/api/workspaces/${workspaceID}/source/read`, {
        method: "POST",
        headers: { cookie, origin: f.base, "content-type": "application/json" },
        body: JSON.stringify({ path: ".factory/system.json" }),
        signal: AbortSignal.timeout(15_000),
      });
      expect(response.status).toBe(200);
      sources.push({ workspaceID, ...releaseSourceFile(await response.json()) });
    }
    expect(sources.length).toBeGreaterThan(0);
    return sources;
  };
  const sourceBefore = await readSources();
  const delivered = deliveryViewSchema.parse(
    await serverCall(callFactoryFunction(f.base, "getDelivery", [changeID], { cookie: cookie })),
  );
  expect(delivered.mergedCommitSha).toBe(state.deliveredSHA);
  const dependent = deliveryViewSchema.parse(
    await serverCall(
      callFactoryFunction(f.base, "getDelivery", [dependentChangeID], { cookie: cookie }),
    ),
  );
  expect(dependent.verificationState).toBe("succeeded");
  const turns = await database.client`
    SELECT id, input->>'kind' AS kind, state, change_id, outcome_summary FROM factory.agent_turn
    WHERE project_id = ${projectID} ORDER BY created_at, id`;
  const decisions = await database.client`
    SELECT approval.id, approval.ticket_id, approval.requirement_revision_id, approval.approved_by
    FROM factory.requirement_approval approval JOIN factory.ticket ticket ON ticket.id = approval.ticket_id
    WHERE ticket.project_id = ${projectID}`;
  const runtimes = attemptsResponseSchema.parse(
    await serverCall(
      callFactoryFunction(f.base, "getRuntimeAttempts", [projectID], { cookie: cookie }),
    ),
  ).attempts;
  await f.record("final-customer-state", {
    projectID,
    delivered,
    dependent,
    turns: [...turns],
    requirementApprovals: [...decisions],
    runtimes: runtimes.map(({ id, state, runtimeKind }) => ({
      id,
      state,
      runtimeKind,
    })),
  });
  await serverCall(
    callFactoryFunction(f.base, "cancelChange", [dependentChangeID], { cookie: cookie }),
  );
  const receipts = [];
  for (const binding of owned) {
    const stopped = runtimeAttemptSchema.parse(
      await serverCall(callFactoryFunction(f.base, "stopRuntimeAttempt", [binding.id], { cookie })),
    );
    expect(stopped).toMatchObject({
      id: binding.id,
      projectId: projectID,
      state: "stopped",
      native: { engine: "substrate", state: "deleted" },
    });
    receipts.push({ id: stopped.id, state: stopped.state, native: stopped.native });
  }
  await eventually(
    async () => {
      const [change] = await database.client<
        Array<{ state: string }>
      >`SELECT state FROM factory.change WHERE id = ${dependentChangeID}`;
      const pending =
        await database.client`SELECT id FROM factory.runtime_attempt WHERE project_id = ${projectID} AND state <> 'stopped'`;
      return { state: change?.state, pending: pending.length };
    },
    (value) => value.state === "cancelled" && value.pending === 0,
    "Owned release runtime cleanup did not complete",
    180_000,
  );
  await requireOwnedProjectSourceRetention(database, projectID);
  const sources = await readSources();
  expect(sources).toEqual(sourceBefore);
  for (const binding of owned) {
    const after = await readReleaseNativeBinding(database, projectID, binding.id);
    expect(after.actorUID).toBe(binding.actorUID);
    expect(after.intent).toEqual(binding.intent);
    expect(after.deletedAt).not.toBeNull();
    expect(
      await absentBoundNativeResource(f.native(binding.intent.connection).call, "GetActor", {
        actor: { atespace: binding.atespace, name: binding.actorName },
      }),
    ).toBeNull();
    await readReleaseNativeTemplate(f.native(binding.intent.connection), binding);
  }
  const inventory = await readResetResources(database);
  expect(new Set(inventory.nativeScopes.map(({ name }) => name))).toEqual(
    new Set(owned.map(({ atespace }) => atespace)),
  );
  const after = await editorFixtureNamespaces();
  for (const namespace of namespacesBefore)
    expect(after.find((value) => value.name === namespace.name)?.uid).toBe(namespace.uid);
  await f.record("owned-cleanup", {
    projectID,
    stopped: receipts,
    absentActors: owned.map(({ id, actorUID, atespace, actorName }) => ({
      id,
      actorUID,
      atespace,
      actorName,
    })),
    retainedSources: sources,
    retainedNativeScopes: inventory.nativeScopes.map(({ name }) => name),
    unrelatedNamespacesRetained: namespacesBefore.length,
  });
  await f.save("cleanup", 0);
}
