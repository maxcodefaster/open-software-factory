import { callFactoryFunction } from "./server-functions";
import { serverCall } from "../../apps/factory/src/server-functions/result";
import { expect } from "bun:test";
import { attemptsResponseSchema, deliveryViewSchema } from "../../apps/factory/src/api-contracts";
import type { releaseInstallation } from "./release-installation";
import { eventually } from "./factory-process";

type Fixture = Awaited<ReturnType<typeof releaseInstallation>>;

async function namespaces() {
  const child = Bun.spawn(["kubectl", "--context", "orbstack", "get", "namespaces", "-o", "json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [text, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (status !== 0) throw new Error("Release namespace observation failed");
  const result = JSON.parse(text) as {
    items: Array<{ metadata: { name: string; uid: string; labels?: Record<string, string> } }>;
  };
  return result.items.map(({ metadata }) => ({
    name: metadata.name,
    uid: metadata.uid,
    projectID: metadata.labels?.["factory.dev/project"],
  }));
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
  const before = await namespaces();
  const ownedNamespaces = await database.client<Array<{ name: string }>>`
    SELECT kubernetes_namespace AS name FROM factory.runtime_attempt WHERE project_id = ${projectID}
    UNION SELECT kubernetes_namespace AS name FROM factory.development_workspace WHERE project_id = ${projectID}`;
  const names = new Set(ownedNamespaces.map((value) => value.name));
  const owned = before.filter((value) => names.has(value.name));
  expect(owned.every((value) => value.projectID === projectID)).toBe(true);
  expect(
    before.filter((value) => value.projectID === projectID).every((value) => names.has(value.name)),
  ).toBe(true);
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
  for (const runtime of runtimes.filter(
    (value) => value.runtimeKind === "staging" && !["stopped", "failed"].includes(value.state),
  ))
    await serverCall(
      callFactoryFunction(f.base, "stopRuntimeAttempt", [runtime.id], { cookie: cookie }),
    );
  await eventually(
    async () => {
      const [change] = await database.client<
        Array<{ state: string }>
      >`SELECT state FROM factory.change WHERE id = ${dependentChangeID}`;
      const pending =
        await database.client`SELECT id FROM factory.runtime_attempt WHERE project_id = ${projectID} AND state NOT IN ('stopped', 'failed')`;
      const remaining = (await namespaces()).filter((value) => names.has(value.name));
      return { state: change?.state, pending: pending.length, remaining: remaining.length };
    },
    (value) => value.state === "cancelled" && value.pending === 0 && value.remaining === 0,
    "Owned release runtime cleanup did not complete",
    180_000,
  );
  const after = await namespaces();
  for (const namespace of before.filter((value) => !names.has(value.name)))
    expect(after.find((value) => value.name === namespace.name)?.uid).toBe(namespace.uid);
  await f.record("owned-cleanup", {
    projectID,
    removed: owned,
    remaining: [],
    unrelatedNamespacesRetained: before.filter((value) => !names.has(value.name)).length,
  });
  await f.save("cleanup", 0);
}
