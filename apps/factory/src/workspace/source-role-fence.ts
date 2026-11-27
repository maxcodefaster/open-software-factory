import { z } from "zod";
import type { DatabaseTransaction } from "#db/client";

// Internal commissions bind the current Turn. Reconnection waits outside SQL;
// real role acknowledgements share the caller's validated Turn/Change transaction.
// Ordinary human handoff has no mode and always needs its real fence.
export type SourceRoleFence =
  | {
      mode: "retained-preparation";
      turnID: string;
      ownerToken: string;
      attemptID: string;
    }
  | {
      mode: "initial-bootstrap";
      sql: DatabaseTransaction;
      turnID: string;
      ownerToken: string;
    }
  | {
      mode: "dispatch";
      sql: DatabaseTransaction;
      turnID: string;
      ownerToken: string;
      attemptID: string;
      sessionID: string;
    };

// A pending repair/review may reconnect ONLY its already admitted canonical
// Actor. This is read-only Source preparation, not a writer grant, bootstrap
// exemption or permission to replay the previous Session's input.
export async function retainedSourcePreparationIn(sql: DatabaseTransaction, attemptID: string) {
  const [row] = await sql<
    {
      changeID: string;
      workspaceID: string;
      userID: string;
      turnID: string;
      ownerToken: string;
      epoch: string;
      state: string;
    }[]
  >`SELECT c.id AS "changeID",w.id AS "workspaceID",turn.created_by AS "userID",
      turn.id AS "turnID",turn.owner_token AS "ownerToken",writer.epoch::text,a.state
    FROM factory.runtime_attempt a
    JOIN factory.development_workspace w ON w.id=a.workspace_id AND w.project_id=a.project_id
      AND w.change_id=a.change_id AND w.kind='ticket'
    JOIN factory.change c ON c.id=w.change_id AND c.runtime_attempt_id=a.id
      AND c.project_id=a.project_id AND c.state='active' AND c.cancel_requested_at IS NULL
    JOIN factory.change_writer writer ON writer.change_id=c.id AND writer.state='agent-preparing'
      AND NOT writer.fence_required AND writer.fence_attempt_id=a.id
    JOIN factory.agent_turn turn ON turn.id=writer.turn_id AND turn.change_id=c.id
      AND turn.project_id=a.project_id AND turn.ticket_id=c.ticket_id
      AND turn.state='pending' AND turn.owner_token IS NOT NULL
      AND turn.owner_expires_at>clock_timestamp() AND turn.authority->>'mode'='build'
      AND turn.input->>'kind' IN ('change-repair','change-review')
    JOIN factory.change_agent_turn_intent input ON input.turn_id=turn.id
      AND input.change_id=c.id AND input.runtime_attempt_id IS NULL
    JOIN factory.change_agent_session session ON session.change_id=c.id
      AND session.runtime_attempt_id=a.id AND session.state='committed' AND NOT session.stop_pending
      AND session.native_session_confirmed_at IS NOT NULL
    JOIN factory.agent_turn previous ON previous.id=session.active_turn_id
      AND previous.change_id=c.id AND previous.state='completed' AND previous.id<>turn.id
    JOIN factory.change_agent_turn_intent prior ON prior.turn_id=previous.id AND prior.change_id=c.id
      AND prior.runtime_attempt_id=a.id AND prior.session_id=session.opencode_session_id
      AND prior.prompt_id<>input.prompt_id
    JOIN factory.substrate_source source ON source.workspace_id=w.id AND source.actor_uid=a.actor_uid
      AND source.owner='actor' AND source.writable AND source.checkpoint_id IS NULL
    WHERE a.id=${attemptID} AND a.state IN ('paused','starting','ready')
      AND a.actor_uid IS NOT NULL AND a.create_attempted_at IS NOT NULL AND NOT a.create_rejected
      AND a.delete_intended_at IS NULL AND a.deleted_at IS NULL
      AND a.binding_intent->>'sourceRestoreProtocol'='2'
      AND a.observation#>>'{metadata,uid}'=a.actor_uid::text
      AND a.observation#>>'{status,state}' IN ('ACTOR_STATE_SUSPENDED','ACTOR_STATE_RESUMING','ACTOR_STATE_RUNNING')
      AND a.checkpoint->>'actorUID'=a.actor_uid::text
      AND a.checkpoint#>>'{durableSnapshot,state}'='SNAPSHOT_STORAGE_STATE_COMPLETED'
      AND a.ready_at IS NOT NULL AND a.failure IS NULL AND a.stop_intended_at IS NULL
      AND ((turn.input->>'kind'='change-repair' AND NOT (turn.authority ? 'review')
        AND NOT input.bootstrap
        AND input.session_id=COALESCE(session.implementation_session_id,prior.session_id)
        AND EXISTS(SELECT 1 FROM factory.change_agent_turn_intent implementation
          JOIN factory.agent_turn coding ON coding.id=implementation.turn_id
            AND coding.change_id=c.id AND coding.state='completed'
            AND coding.authority->>'mode'='build' AND NOT (coding.authority ? 'review')
          WHERE implementation.change_id=c.id AND implementation.runtime_attempt_id=a.id
            AND implementation.session_id=input.session_id AND implementation.prompt_id<>input.prompt_id))
        OR (turn.input->>'kind'='change-review' AND turn.authority ? 'review'
          AND input.bootstrap AND input.session_id<>prior.session_id))
      AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt newer
        WHERE newer.workspace_id=w.id AND newer.generation>a.generation)
      AND NOT EXISTS(SELECT 1 FROM factory.operation stopped
        WHERE stopped.kind='runtime.input_stop' AND stopped.scope_type='runtime_attempt'
          AND stopped.scope_id=a.id::text)
      AND NOT EXISTS(SELECT 1 FROM factory.agent_turn other WHERE other.change_id=c.id AND other.id<>turn.id
        AND other.state IN ('pending','dispatching','running','uncertain'))
      AND NOT EXISTS(SELECT 1 FROM factory.change_commit_operation operation
        WHERE operation.change_id=c.id AND operation.state NOT IN ('succeeded','failed'))`;
  return row ?? null;
}

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
    generation: z.number().int().positive(),
    repositoryIdentity: z.string(),
    workspaceFolder: z.literal("/var/lib/factory/source/project"),
    connectorStateDir: z.literal("/var/lib/factory/control"),
    preserveWorkspace: z.literal(true),
  }),
  source: z.object({ workspaceId: z.string(), projectId: z.string() }),
});

// Called only after the native owner verified the template's immutable profile.
// Never persist or return the credential-bearing bootstrap body.
export function templateInitialSourceRole(
  value: unknown,
  identity: {
    attemptID: string;
    generation: number;
    workspaceID: string;
    projectID: string;
    workloadImage: string;
  },
) {
  const parsed = retainedBootstrapTemplate.safeParse(value);
  if (!parsed.success) return false;
  const workload = parsed.data.containers.filter(
    (container) => container.name === "factory-control",
  );
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
    bootstrap.assignment.generation === identity.generation &&
    bootstrap.assignment.repositoryIdentity === identity.projectID &&
    bootstrap.source.workspaceId === identity.workspaceID &&
    bootstrap.source.projectId === identity.projectID
  );
}

export async function initialSourceRoleIn(
  sql: DatabaseTransaction,
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
  >`SELECT a.atespace,provision.resources->'template'->'value' AS template,
      a.binding_intent->>'templateUID' AS "templateUID",
      a.binding_intent->>'templateVersion' AS "templateVersion",
      a.binding_intent->>'templateSHA256' AS "templateSHA256",
      provision.intent->>'templateSHA256' AS "provisionSHA256"
    FROM factory.runtime_attempt a
    JOIN factory.development_workspace workspace ON workspace.id=a.workspace_id
      AND workspace.project_id=a.project_id AND workspace.change_id=a.change_id
      AND workspace.kind='ticket'
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
    JOIN factory.operation resumed ON resumed.kind='runtime.actor_rpc'
      AND resumed.scope_type='runtime_attempt' AND resumed.scope_id=a.id::text
      AND resumed.idempotency_key='runtime.actor_rpc:'||a.id::text||':resume:initial'
      AND resumed.payload->>'action'='resume' AND resumed.payload->>'originKey'='initial'
      AND NULLIF(resumed.payload->'originCheckpoint','null'::jsonb) IS NULL
      AND (resumed.payload->>'actorUid')::uuid=a.actor_uid
      AND (resumed.payload->>'attemptedAt') IS NOT NULL AND resumed.result IS NULL
      AND (resumed.payload->>'stopId') IS NULL
    JOIN factory.substrate_provision provision ON provision.owner_id=workspace.id
      AND provision.kind='workspace' AND provision.generation=a.generation
      AND jsonb_typeof(provision.resources->'template'->'value')='object'
      AND provision.intent#>>'{configuration,deployment}'='fresh-workspaces'
    JOIN factory.substrate_source source ON source.workspace_id=workspace.id
      AND source.actor_uid=a.actor_uid AND source.owner='actor' AND source.writable
      AND source.checkpoint_id IS NULL AND source.seed_confirmed_at IS NOT NULL
      AND source.service_base::text=source.seed->>'id'
      AND source.seed->>'workspaceID'=workspace.id::text
      AND source.seed->>'projectID'=a.project_id::text AND source.seed->>'revision'=a.revision
      AND source.seed->>'repositoryURL'=provision.intent->>'repositoryURL'
      AND source.seed->>'branch'=provision.intent->>'branch'
      AND source.checkpoint->>'workspaceID'=workspace.id::text
      AND source.checkpoint->'actorUID'='null'::jsonb
      AND source.checkpoint->'seedID'=source.seed->'id'
      AND source.generation>0
      AND (source.checkpoint->>'generation')::bigint=source.generation
      AND (source.checkpoint->>'writerEpoch')::bigint+1=source.writer_epoch
    WHERE workspace.id=${workspaceID} AND a.id=${attemptID}
      AND a.state='starting' AND a.ready_at IS NULL
      AND a.failure IS NULL AND a.stop_intended_at IS NULL
      AND a.actor_uid IS NOT NULL AND a.create_attempted_at IS NOT NULL
      AND NOT a.create_rejected AND a.checkpoint IS NULL
      AND a.delete_intended_at IS NULL AND a.deleted_at IS NULL
      AND a.observation#>>'{metadata,uid}'=a.actor_uid::text
      AND a.observation#>>'{status,state}'='ACTOR_STATE_RESUMING'
      AND a.binding_intent->>'deployment'='fresh-workspaces'
      AND a.binding_intent->>'sourceRestoreProtocol'='2'
      AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt newer
        WHERE newer.workspace_id=workspace.id AND newer.generation>a.generation)
      AND NOT EXISTS(SELECT 1 FROM factory.runtime_attempt other
        WHERE other.workspace_id=workspace.id AND other.id<>a.id AND (
          other.generation<a.generation AND other.state='stopped'
          AND other.deleted_at IS NOT NULL AND other.binding_intent->>'sourceRestoreProtocol'='2'
          AND other.binding_intent->>'projectID'=a.project_id::text
          AND other.binding_intent->>'workspaceID'=workspace.id::text
          AND other.binding_intent->>'generation'=other.generation::text) IS NOT TRUE)
      AND NOT EXISTS(SELECT 1 FROM factory.change_agent_session WHERE change_id=change.id)
      AND NOT EXISTS(SELECT 1 FROM factory.operation stopped
        WHERE stopped.kind='runtime.input_stop' AND stopped.scope_type='runtime_attempt'
          AND stopped.scope_id=a.id::text)
      AND NOT EXISTS(SELECT 1 FROM factory.operation other
        WHERE other.kind='runtime.actor_rpc' AND other.scope_type='runtime_attempt'
          AND other.scope_id=a.id::text AND other.payload->>'action'='suspend')
      AND NOT EXISTS(SELECT 1 FROM factory.audit_event decision
        WHERE decision.kind='access.change_editing_decision'
          AND decision.scope_type='change' AND decision.scope_id=change.id::text)
      AND NOT EXISTS(SELECT 1 FROM factory.operation submission
        WHERE submission.kind='workspace.submission' AND submission.scope_type='workspace'
          AND submission.scope_id=workspace.id::text)
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
