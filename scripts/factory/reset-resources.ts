import { z } from "zod";
import type { createDatabase } from "../../packages/db/src/client";
import { runtimeIdentity } from "../../packages/runtime-domain/src/identity";
import {
  createSubstrateControl,
  type SubstrateCall,
  SubstrateRPCError,
  substrateConnection,
} from "../../packages/runtime-kubernetes/src/substrate-control";
import { developerIDEIdentity } from "../../packages/workspace-domain/src/developer-ide";

const kubernetesName = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,252}$/);
export const resetResources = z.strictObject({
  nativeScopes: z.array(
    z.strictObject({
      name: z.string().regex(/^fa-[a-f0-9]{32}$/),
      connection: substrateConnection,
    }),
  ),
  editorNamespaces: z.array(z.string().regex(/^factory-editor-[a-f0-9]{32}$/)),
  capacityPools: z.array(z.strictObject({ namespace: kubernetesName, name: kubernetesName })),
});
export type ResetResources = z.infer<typeof resetResources>;

/** Read the disposable database, never a cluster-wide ownership guess. */
export async function readResetResources(database: ReturnType<typeof createDatabase>) {
  return database.client.begin(async (sql) => {
    const pending = await sql`SELECT id FROM factory.runtime_attempt
      WHERE state NOT IN ('stopped','failed') LIMIT 1`;
    const unsettled = await sql`SELECT change_id FROM factory.change_agent_session
      WHERE stop_pending OR state IN ('starting','working')
      UNION ALL SELECT change_id FROM factory.agent_turn
      WHERE state IN ('pending','dispatching','running','uncertain')
      UNION ALL SELECT change_id FROM factory.change_commit_operation
      WHERE state NOT IN ('succeeded','failed') LIMIT 1`;
    if (pending.length || unsettled.length)
      throw new Error("Reset refused: finish active runtimes and unconfirmed Coding Stop first");
    const uncertain = await sql`SELECT 1 FROM factory.substrate_binding
      WHERE create_attempted_at IS NOT NULL AND actor_uid IS NULL AND NOT create_rejected
      UNION ALL SELECT 1 FROM factory.substrate_workspace
      WHERE (atespace_attempted_at IS NOT NULL AND atespace IS NULL AND NOT atespace_rejected)
        OR (policy_attempted_at IS NOT NULL AND policy IS NULL AND NOT policy_rejected)
        OR (template_attempted_at IS NOT NULL AND template IS NULL AND NOT template_rejected)
      UNION ALL SELECT 1 FROM factory.substrate_prebuild
      WHERE (atespace_attempted_at IS NOT NULL AND atespace IS NULL AND NOT atespace_rejected)
        OR (policy_attempted_at IS NOT NULL AND policy IS NULL AND NOT policy_rejected)
        OR (template_attempted_at IS NOT NULL AND template IS NULL AND NOT template_rejected)
      UNION ALL SELECT 1 FROM factory.substrate_verification
      WHERE (atespace_attempted_at IS NOT NULL AND atespace IS NULL AND NOT atespace_rejected)
        OR (policy_attempted_at IS NOT NULL AND policy IS NULL AND NOT policy_rejected)
        OR (template_attempted_at IS NOT NULL AND template IS NULL AND NOT template_rejected)
      UNION ALL SELECT 1 FROM factory.substrate_isolated
      WHERE (atespace_attempted_at IS NOT NULL AND atespace IS NULL AND NOT atespace_rejected)
        OR (policy_attempted_at IS NOT NULL AND policy IS NULL AND NOT policy_rejected)
        OR (template_attempted_at IS NOT NULL AND template IS NULL AND NOT template_rejected)
      UNION ALL SELECT 1 FROM factory.substrate_worker_capacity
      WHERE attempted_at IS NOT NULL AND pool IS NULL AND NOT rejected LIMIT 1`;
    if (uncertain.length)
      throw new Error(
        "Reset refused: a native create outcome is unconfirmed; its original intent was retained",
      );
    // Include provisioning intents that never reached an Actor binding. An
    // uncertain create or partially created template is not an empty runtime.
    const scopes = await sql<{ name: string; connection: unknown }[]>`
      SELECT atespace AS name,intent->'connection' AS connection FROM factory.substrate_binding
      UNION
      SELECT 'fa-'||replace(runtime_attempt_id::text,'-',''),intent#>'{configuration,connection}'
        FROM factory.substrate_prebuild
      UNION
      SELECT 'fa-'||replace(runtime_attempt_id::text,'-',''),intent#>'{configuration,connection}'
        FROM factory.substrate_verification
      UNION
      SELECT 'fa-'||replace(runtime_attempt_id::text,'-',''),intent#>'{configuration,connection}'
        FROM factory.substrate_isolated`;
    const workspaces = await sql<
      { workspaceID: string; generation: number; connection: unknown }[]
    >`SELECT workspace_id::text AS "workspaceID",generation::float8 AS generation,
      intent#>'{configuration,connection}' AS connection FROM factory.substrate_workspace`;
    const editors = await sql<{ userID: string; resourceID: string; epoch: number }[]>`
      SELECT user_id::text AS "userID",resource_id::text AS "resourceID",
        service_epoch::float8 AS epoch FROM factory.developer_ide`;
    const pools = await sql<{ namespace: string; name: string }[]>`
      SELECT intent#>>'{pool,metadata,namespace}' AS namespace,
        intent#>>'{pool,metadata,name}' AS name FROM factory.substrate_worker_capacity`;
    return resetResources.parse({
      nativeScopes: [
        ...scopes,
        ...workspaces.map((workspace) => ({
          name: `fa-${runtimeIdentity(workspace.workspaceID, workspace.generation).attemptID.replaceAll("-", "")}`,
          connection: workspace.connection,
        })),
      ],
      editorNamespaces: editors.map(
        (editor) => developerIDEIdentity(editor.userID, editor.epoch, editor.resourceID).namespace,
      ),
      capacityPools: pools,
    });
  });
}

/** Read-only. Reset never deletes native resources on the operator's behalf. */
export async function requireResetResourcesAbsent(
  input: ResetResources,
  observeKubernetes: (
    kind: "namespace" | "workerpool",
    name: string,
    namespace?: string,
  ) => Promise<boolean>,
  native: (
    connection: ResetResources["nativeScopes"][number]["connection"],
  ) => SubstrateCall = createSubstrateControl,
) {
  const resources = resetResources.parse(input);
  for (const scope of resources.nativeScopes) {
    let absent = false;
    try {
      await native(scope.connection)("GetAtespace", { atespace: { name: scope.name } });
    } catch (error) {
      if (!(error instanceof SubstrateRPCError) || error.code !== "NotFound") throw error;
      absent = true;
    }
    if (!absent)
      throw new Error(
        `Reset refused: native scope ${scope.name} still exists. Finish its exactly owned Substrate cleanup first`,
      );
  }
  for (const namespace of resources.editorNamespaces)
    if (await observeKubernetes("namespace", namespace))
      throw new Error(`Reset refused: Developer IDE Namespace ${namespace} still exists`);
  for (const pool of resources.capacityPools)
    if (await observeKubernetes("workerpool", pool.name, pool.namespace))
      throw new Error(
        `Reset refused: native capacity WorkerPool ${pool.namespace}/${pool.name} still exists`,
      );
}
