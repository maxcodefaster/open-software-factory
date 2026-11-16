import { z } from "zod";
import type { AgentTurnTransaction } from "../agent/turn-store";

// These are internal calls under the caller's validated Turn/Change transaction.
// The ordinary human handoff has neither mode and always needs its real fence.
export type SourceRoleFence =
  | {
      mode: "initial-bootstrap";
      sql: AgentTurnTransaction;
      turnID: string;
      ownerToken: string;
    }
  | {
      mode: "dispatch";
      sql: AgentTurnTransaction;
      turnID: string;
      ownerToken: string;
      attemptID: string;
      sessionID: string;
    };

const retainedBootstrapTemplate = z.object({
  metadata: z.object({ uid: z.string(), version: z.string(), atespace: z.string() }),
  containers: z.array(
    z.object({
      name: z.string(),
      image: z.string(),
      env: z.array(z.object({ name: z.string(), value: z.string() })),
    }),
  ),
});
const sourceBootstrap = z.object({
  sourceHandoff: z.literal(true),
  assignment: z.object({
    runtimeAttemptId: z.string(),
    generation: z.literal(1),
    repositoryIdentity: z.string(),
    workspaceFolder: z.literal("/home/rootless/persist/project"),
    connectorStateDir: z.literal("/home/rootless/persist/connector"),
    preserveWorkspace: z.literal(true),
  }),
  source: z.object({ workspaceId: z.string(), projectId: z.string() }),
});

// Called only after the native owner verified the template's immutable profile.
// Never persist or return the credential-bearing bootstrap body.
export function templateInitialSourceRole(
  value: unknown,
  identity: { attemptID: string; workspaceID: string; projectID: string; workloadImage: string },
) {
  const parsed = retainedBootstrapTemplate.safeParse(value);
  if (!parsed.success) return false;
  const workload = parsed.data.containers.filter((container) => container.name === "workload");
  const container = workload[0];
  if (workload.length !== 1 || !container || container.image !== identity.workloadImage)
    return false;
  const environment = container.env.filter((item) => item.name === "FACTORY_SUBSTRATE_BOOTSTRAP");
  if (environment.length !== 1) return false;
  let bootstrap: z.infer<typeof sourceBootstrap>;
  try {
    bootstrap = sourceBootstrap.parse(JSON.parse(environment[0]?.value ?? ""));
  } catch {
    return false;
  }
  return (
    bootstrap.assignment.runtimeAttemptId === identity.attemptID &&
    bootstrap.assignment.repositoryIdentity === identity.projectID &&
    bootstrap.source.workspaceId === identity.workspaceID &&
    bootstrap.source.projectId === identity.projectID
  );
}

export async function initialSourceRoleIn(
  sql: AgentTurnTransaction,
  workspaceID: string,
  attemptID: string,
  epoch: string,
  commission: Extract<SourceRoleFence, { mode: "initial-bootstrap" }>,
) {
  const [row] = await sql<
    {
      atespace: string;
      template: unknown;
      templateUID: string;
      templateVersion: string;
      templateSHA256: string;
      provisionSHA256: string;
    }[]
  >`SELECT binding.atespace,provision.template,
      binding.intent->>'templateUID' AS "templateUID",
      binding.intent->>'templateVersion' AS "templateVersion",
      binding.intent->>'templateSHA256' AS "templateSHA256",
      provision.intent->>'templateSHA256' AS "provisionSHA256"
    FROM factory.runtime_attempt a
    JOIN factory.development_workspace workspace ON workspace.id=a.workspace_id
      AND workspace.project_id=a.project_id AND workspace.change_id=a.change_id
      AND workspace.kind='ticket' AND workspace.substrate
    JOIN factory.change change ON change.id=a.change_id AND change.runtime_attempt_id=a.id
      AND change.project_id=a.project_id AND change.state='starting'
    JOIN factory.change_writer writer ON writer.change_id=change.id
      AND writer.state='agent-preparing' AND writer.epoch=${epoch}::bigint
      AND NOT writer.fence_required AND writer.fence_attempt_id=a.id
    JOIN factory.agent_turn current ON current.id=writer.turn_id AND current.id=${commission.turnID}
      AND current.change_id=change.id AND current.state='pending'
      AND current.owner_token=${commission.ownerToken}
      AND current.owner_expires_at>clock_timestamp()
      AND current.input->>'kind'='change-start' AND current.authority->>'mode'='build'
      AND NOT (current.authority ? 'review')
    JOIN factory.change_agent_turn_intent input ON input.turn_id=current.id
      AND input.change_id=change.id AND input.bootstrap AND input.runtime_attempt_id IS NULL
    JOIN factory.substrate_binding binding ON binding.runtime_attempt_id=a.id
      AND binding.actor_uid IS NOT NULL AND binding.create_attempted_at IS NOT NULL
      AND NOT binding.create_rejected AND binding.checkpoint IS NULL
      AND binding.delete_intended_at IS NULL AND binding.deleted_at IS NULL
      AND binding.observation#>>'{metadata,uid}'=binding.actor_uid::text
      AND binding.observation#>>'{status,state}'='ACTOR_STATE_RESUMING'
      AND binding.intent->>'deployment'='fresh-workspaces'
    JOIN factory.substrate_actor_rpc resumed ON resumed.runtime_attempt_id=a.id
      AND resumed.action='resume' AND resumed.origin_key='initial'
      AND resumed.origin_checkpoint IS NULL AND resumed.actor_uid=binding.actor_uid
      AND resumed.attempted_at IS NOT NULL AND resumed.outcome IS NULL AND resumed.stop_id IS NULL
    JOIN factory.substrate_workspace provision ON provision.workspace_id=workspace.id
      AND provision.generation=1 AND provision.template IS NOT NULL
      AND provision.intent#>>'{configuration,deployment}'='fresh-workspaces'
    JOIN factory.substrate_source source ON source.workspace_id=workspace.id
      AND source.actor_uid=binding.actor_uid AND source.owner='actor' AND source.writable
      AND source.writer_epoch=1 AND source.generation=0 AND source.checkpoint_id IS NULL
      AND source.checkpoint IS NULL AND source.service_base IS NULL
    WHERE workspace.id=${workspaceID} AND a.id=${attemptID} AND a.substrate
      AND a.generation=1 AND a.state='starting' AND a.ready_at IS NULL
      AND a.failure IS NULL AND a.stop_intended_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt newer
        WHERE newer.workspace_id=workspace.id AND newer.generation>a.generation)
      AND NOT EXISTS(SELECT 1 FROM factory.change_agent_session WHERE change_id=change.id)
      AND NOT EXISTS(SELECT 1 FROM factory.substrate_input_stop WHERE runtime_attempt_id=a.id)
      AND NOT EXISTS(SELECT 1 FROM factory.substrate_actor_rpc other
        WHERE other.runtime_attempt_id=a.id AND other.action='suspend')
      AND NOT EXISTS(SELECT 1 FROM factory.change_editing_decision WHERE change_id=change.id)
      AND NOT EXISTS(SELECT 1 FROM factory.workspace_submission WHERE workspace_id=workspace.id)
      AND NOT EXISTS(SELECT 1 FROM factory.change_commit_operation WHERE change_id=change.id)
      AND NOT EXISTS(SELECT 1 FROM factory.agent_turn previous
        LEFT JOIN factory.change_agent_turn_intent prior ON prior.turn_id=previous.id
        WHERE previous.change_id=change.id AND previous.id<>current.id
          AND (previous.state NOT IN ('failed','stopped') OR prior.turn_id IS NULL
            OR prior.change_id<>change.id OR NOT prior.bootstrap
            OR prior.runtime_attempt_id IS NOT NULL OR previous.authority ? 'review'))`;
  if (!row) return false;
  // Provisioning retains metadata only. Reading the credential-bearing native
  // specification belongs to its existing runtime owner, never this cache.
  const parsed = retainedBootstrapTemplate.pick({ metadata: true }).safeParse(row.template);
  if (!parsed.success) return false;
  const template = parsed.data;
  return (
    template.metadata.uid === row.templateUID &&
    template.metadata.version === row.templateVersion &&
    template.metadata.atespace === row.atespace &&
    row.templateSHA256 === row.provisionSHA256
  );
}
