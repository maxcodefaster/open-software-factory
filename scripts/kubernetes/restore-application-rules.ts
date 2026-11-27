// Quiescence rules, history table list, and read-only verification SQL for restored applications.
import {
  check,
  type Document,
  equal,
  type LoadedApplicationFixture,
  type Snapshot,
} from "./restore-application-types";

// Deliberately conservative eligibility, not a general recovery classifier.
// Unknown/nonterminal external work fails closed. Historical unknown accounting is
// admitted only for the finalized owners audited below, with complete history witnesses.
export const idleRules: Record<string, string> = {
  agent_turn: "state::text NOT IN ('completed','failed','stopped')",
  change: "state::text NOT IN ('delivered','cancelled','failed')",
  change_agent_session: "stop_pending OR state::text NOT IN ('stopped','failed','committed')",
  change_writer: "state NOT IN ('unassigned','human','agent')",
  change_commit_operation: "state::text NOT IN ('succeeded','failed')",
  verification: "state::text NOT IN ('succeeded','failed','cancelled')",
  runtime_attempt:
    "state::text <> 'stopped' OR (atespace IS NOT NULL AND NOT create_rejected AND deleted_at IS NULL)",
  substrate_source:
    "owner <> 'service' OR NOT writable OR checkpoint IS NULL OR service_base IS NULL",
  build_browser_session: "state <> 'closed'",
  operation: `CASE kind
    WHEN 'projects.setup_readiness' THEN state NOT IN ('ready','failed')
    WHEN 'projects.setup_draft' THEN state IN ('creating','checking')
    WHEN 'projects.repository_intent' THEN state NOT IN ('committed','failed')
    WHEN 'project.setup_inspection' THEN state NOT IN ('complete','confirmed','superseded','failed')
    WHEN 'project.delivery_policy' THEN false
    WHEN 'project.delivery_queue' THEN false
    WHEN 'user.ui_preference' THEN false
    WHEN 'knowledge.page_alias' THEN false
    WHEN 'knowledge.generation' THEN state NOT IN ('succeeded','failed')
    WHEN 'knowledge.source_update' THEN state <> 'ready' OR (payload->>'eventVersion')::bigint <> (payload->>'handledVersion')::bigint
    WHEN 'attachment.storage' THEN false
    WHEN 'attachment.turn_context' THEN false
    WHEN 'learning.source_artifact' THEN false
    WHEN 'learning.policy' THEN state = 'enabled'
    WHEN 'learning.trial' THEN true
    WHEN 'mcp.share_proposal' THEN false
    WHEN 'mcp.choice' THEN false
    WHEN 'skills.share_proposal' THEN false
    WHEN 'skills.choice' THEN false
    WHEN 'installation.maintenance' THEN state = 'enabled'
    WHEN 'environments.environment' THEN false
    WHEN 'delivery.staging_preview' THEN false
    WHEN 'releases.access' THEN state NOT IN ('active','revoked')
    WHEN 'releases.attempt' THEN completed_at IS NULL
    WHEN 'tickets.responsibility' THEN false
    WHEN 'tickets.follow' THEN false
    WHEN 'inbox.receipt' THEN false
    WHEN 'tickets.implementation_order' THEN state NOT IN ('started','cancelled')
    WHEN 'usage.coding_pause' THEN false
    WHEN 'access.identity_setup' THEN state NOT IN ('active','superseded')
    WHEN 'access.identity_configuration' THEN false
    WHEN 'access.forge_connection' THEN state <> 'ready'
    WHEN 'access.change_editing_request' THEN false
    WHEN 'access.revocation' THEN (payload->>'processedVersion')::bigint <> (payload->>'version')::bigint
    WHEN 'access.external_identity' THEN false
    WHEN 'usage.rate_override' THEN false
    WHEN 'usage.replay_cursor' THEN false
    WHEN 'coding.session_archive' THEN state <> 'saved'
    WHEN 'coding.turn_mcp' THEN false
    WHEN 'coding.turn_skill' THEN false
    WHEN 'workspace.developer_ide' THEN state <> 'stopped'
    WHEN 'review.scenario' THEN false
    WHEN 'workspace.submission' THEN NOT EXISTS (
      SELECT 1 FROM factory.change_commit_operation commit_op
      JOIN factory.runtime_attempt attempt ON attempt.id=commit_op.runtime_attempt_id
      JOIN factory.development_workspace workspace ON workspace.id=attempt.workspace_id
      WHERE commit_op.id=operation.id AND commit_op.source='workspace'
        AND commit_op.created_by=(operation.payload->>'actorId')::uuid
        AND commit_op.idempotency_key='workspace:'||CAST(operation.id AS text)
        AND workspace.id=(operation.scope_id)::uuid AND workspace.kind='ticket'
        AND workspace.change_id=commit_op.change_id AND commit_op.completed_at IS NOT NULL
        AND operation.payload->>'prepareAttemptedAt' IS NOT NULL
        AND ((commit_op.state='succeeded' AND commit_op.last_error IS NULL
          AND commit_op.commit_sha IS NOT NULL AND commit_op.observed_remote_sha=commit_op.commit_sha)
        OR (commit_op.state='failed' AND commit_op.commit_sha IS NULL AND commit_op.observed_remote_sha IS NULL
          AND commit_op.last_error IN ('workspace has no changes to commit',
            'workspace HEAD no longer matches the commit intent',
            'an ordinary commit cannot accept an unadmitted merge'))))
    WHEN 'models.role_probe' THEN state = 'probing'
    WHEN 'models.connection_write' THEN state <> 'committed'
    WHEN 'forge.account' THEN state NOT IN ('ready','disabled')
    WHEN 'forge.branch' THEN state <> 'confirmed'
    WHEN 'forge.grant' THEN state <> 'confirmed' OR result->'confirmed' IS DISTINCT FROM payload->'desired'
    WHEN 'environments.write' THEN state NOT IN ('committed','discarded')
    WHEN 'mcp.secret_write' THEN state NOT IN ('committed','superseded')
    WHEN 'mcp.token_refresh' THEN state <> 'committed'
    WHEN 'mcp.connect' THEN true
    WHEN 'mcp.oauth_flow' THEN state NOT IN ('completed','failed')
    WHEN 'releases.mirror_command' THEN state NOT IN ('completed','acknowledged','failed')
    WHEN 'workspace.personal_git' THEN state NOT IN ('succeeded','failed')
    WHEN 'workspace.command' THEN state NOT IN ('exited','cancelled','failed','interrupted')
    WHEN 'workspace.file_op' THEN completed_at IS NULL
    WHEN 'workspace.file_transfer' THEN state <> 'released'
    WHEN 'workspace.terminal_op' THEN completed_at IS NULL
    WHEN 'workspace.lifecycle' THEN completed_at IS NULL
    WHEN 'workspace.share_decision' THEN completed_at IS NULL
    WHEN 'delivery.branch_create' THEN state NOT IN ('succeeded','failed')
    WHEN 'delivery.promotion' THEN state NOT IN ('succeeded','failed')
    WHEN 'delivery.pull_request' THEN state NOT IN ('succeeded','failed')
    WHEN 'delivery.merge' THEN state NOT IN ('succeeded','failed')
    WHEN 'attachments.draft' THEN false
    WHEN 'runtime.environment_intent' THEN false
    WHEN 'runtime.staging_configuration' THEN false
    WHEN 'runtime.capacity_installation' THEN false
    WHEN 'runtime.worker_capacity' THEN NOT COALESCE((payload->>'rejected')::boolean, false) AND result->'pool' IS NULL
    WHEN 'runtime.actor_rpc' THEN result IS NULL
    WHEN 'runtime.input_stop' THEN completed_at IS NULL
    WHEN 'runtime.compute_wait' THEN true
    WHEN 'runtime.browser' THEN state <> 'closed'
    ELSE true
  END`,
  monitoring_hook: "enabled",
  monitoring_incident: "state IN ('queued','diagnosing','implementing','uncertain')",
  learning_review: "state IN ('pending','running','uncertain')",
  audit_event: `kind='learning.command' AND payload->'input'->>'kind'='review-now' AND NOT EXISTS (
    SELECT 1 FROM factory.learning_review review WHERE review.kind='work'
    AND review.project_id=(audit_event.payload->'input'->>'projectId')::uuid
    AND review.owner_id IS NOT DISTINCT FROM
      (CASE WHEN audit_event.payload->'input'->>'scope'='personal' THEN audit_event.actor_id END)
    AND review.developer_only=(audit_event.payload->'input'->>'developerOnly')::boolean
    AND review.created_at>audit_event.created_at)`,
  project_release: "state NOT IN ('published','failed')",
  candidate_review: "state NOT IN ('passed','changes-requested','failed')",
  // Model recovery touches only probing rows; Wiki recovery touches only running generations.
  // Neither replays a finalized owner. Do not generalize this to turn:* Coding journals:
  // usage/record-opencode.ts can still drain or markUnavailable after settlement.
  usage_operation: `settled_at IS NULL OR outcome IS NULL
    OR outcome NOT IN ('completed','failed','interrupted','unknown')
    OR (outcome='unknown' AND (NOT EXISTS (
      SELECT 1 FROM factory.usage_entry entry WHERE entry.operation_id=usage_operation.id
        AND entry.source='unobserved' AND entry.outcome='unknown') OR NOT (
      (purpose='probe' AND project_id IS NULL AND EXISTS (
        SELECT 1 FROM factory.operation probe
        WHERE probe.kind='models.role_probe'
          AND usage_operation.id='probe:'||CAST(probe.id AS text)
          AND probe.state IN ('finished','uncertain') AND probe.completed_at IS NOT NULL
          AND probe.result IS NOT NULL AND usage_operation.user_id=probe.created_by
          AND usage_operation.model=probe.payload->>'modelId'
          AND usage_operation.engine=CASE WHEN probe.payload->>'role'='build' THEN 'opencode' ELSE 'mastra' END))
      OR (purpose='wiki' AND engine='mastra' AND EXISTS (
        SELECT 1 FROM factory.operation generation
        WHERE generation.kind='knowledge.generation' AND generation.scope_type='project'
          AND usage_operation.id LIKE 'wiki:'||CAST(generation.id AS text)||':_%:_%'
          AND generation.state IN ('succeeded','failed') AND generation.completed_at IS NOT NULL
          AND CAST(usage_operation.project_id AS text)=generation.scope_id
          AND usage_operation.user_id=generation.created_by)))))`,
  ticket: "trash_stop_pending",
};

export const historyTables = [
  "requirement_revision",
  "requirement_approval",
  "technical_design_revision",
  "substrate_source",
  "substrate_provision",
  "runtime_attempt",
  "development_workspace",
  "agent_turn",
  "change",
  "change_writer",
  "change_agent_turn_intent",
  // Idle terminal workflow rows must not change during startup/read/save/logout.
  // Verification retry retains its failed receipt in execution_policy_command before
  // resetting the current Verification, so witness both, not just the latest result.
  "change_agent_session",
  "verification",
  "candidate_review",
  "review_feedback",
  "audit_event",
  "delivery_approval",
  // Complete original rows, including failed submissions, unknown outcomes and replay cursors.
  // Both source observations and every restored snapshot must match these independent digests.
  "change_commit_operation",
  "usage_operation",
  "usage_entry",
  "operation",
];

function sqlDigest(query: string) {
  // Hash a JSONB array, ordered by canonical row JSONB text under C collation.
  return `(SELECT json_build_object('rows',count(*),'sha256',encode(factory.digest(convert_to(
    COALESCE(jsonb_agg(row ORDER BY row::text COLLATE "C"),'[]'::jsonb)::text,'UTF8'),'sha256'),'hex'))
    FROM (${query}) witness(row))`;
}

export function applicationSQL(f: LoadedApplicationFixture) {
  const w = f.expected;
  const t = `'${w.ticket.id}'::uuid`,
    p = `'${w.project.id}'::uuid`,
    s = `'${w.source.workspaceID}'::uuid`;
  const history: Record<string, string> = Object.fromEntries(
    historyTables.map((table) => [table, `SELECT to_jsonb(t) FROM factory.${table} t`]),
  );
  history["other_tickets"] = `SELECT to_jsonb(t) FROM factory.ticket t WHERE id<>${t}`;
  history["old_documents"] =
    `SELECT to_jsonb(t) FROM factory.ticket_document_revision t WHERE id<>'${f.save.commandID}'::uuid`;
  history["protected_ticket"] =
    `SELECT to_jsonb(t)-ARRAY['description','version','updated_at'] FROM factory.ticket t WHERE id=${t}`;
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '${f.limits.seconds * 1000}ms';
SET LOCAL timezone = 'UTC';
SET LOCAL extra_float_digits = 3;
SET LOCAL bytea_output = 'hex';
SELECT json_build_object(
 'readOnly',current_setting('transaction_read_only'),'database',current_database(),
 'schema',(SELECT source_digest FROM factory.schema_migration WHERE version=1),
 'busy',(SELECT json_object_agg(name,amount) FROM (${Object.entries(idleRules)
   .map(
     ([table, where]) =>
       `SELECT '${table}' AS name,count(*) AS amount FROM factory.${table} WHERE ${where}`,
   )
   .join(" UNION ALL ")}) busy),
 'history',json_build_object(${Object.entries(history)
   .map(([key, query]) => `'${key}',${sqlDigest(query)}`)
   .join(",")}),
 'project',(SELECT row_to_json(v) FROM (SELECT id,name,slug,repository_url AS "repositoryUrl",default_branch AS "defaultBranch",actor_template_path AS "actorTemplatePath" FROM factory.project WHERE id=${p}) v),
 'ticket',(SELECT row_to_json(v) FROM (SELECT id,project_id AS "projectId",title,description,state,version::integer FROM factory.ticket WHERE id=${t} AND trashed_at IS NULL AND converted_to_epic_id IS NULL) v),
 'documents',COALESCE((SELECT json_agg(v ORDER BY ordinal DESC) FROM (SELECT id,ordinal,title,description,canonical_content AS "canonicalContent",content_digest AS "contentDigest",requirement_revision_id AS "requirementRevisionId" FROM factory.ticket_document_revision WHERE ticket_id=${t}) v),'[]'::json),
 'requirements',COALESCE((SELECT json_agg(v ORDER BY ordinal DESC) FROM (SELECT id,ordinal,canonical_content AS "canonicalContent",content_digest AS "contentDigest" FROM factory.requirement_revision WHERE ticket_id=${t}) v),'[]'::json),
 'scope',COALESCE((SELECT requirement_revision_id FROM factory.requirement_approval WHERE ticket_id=${t}),
   (SELECT id FROM factory.requirement_revision WHERE ticket_id=${t} ORDER BY ordinal DESC LIMIT 1)),
 'source',(SELECT json_build_object('eligible',s.owner='service' AND s.writable AND s.service_base IS NOT NULL AND s.checkpoint IS NOT NULL AND w.project_id=${p}
   AND EXISTS(SELECT 1 FROM factory.runtime_attempt a
     WHERE a.workspace_id=s.workspace_id AND a.state='stopped' AND a.actor_uid=s.actor_uid AND a.deleted_at IS NOT NULL),
   'sha256',encode(factory.digest(convert_to(to_jsonb(s)::text,'UTF8'),'sha256'),'hex'))
   FROM factory.substrate_source s JOIN factory.development_workspace w ON w.id=s.workspace_id WHERE s.workspace_id=${s}),
 'account',(SELECT row_to_json(v) FROM (SELECT id,email FROM auth."user" WHERE id='${f.account.id}'::uuid) v),
 'sessions',COALESCE((SELECT json_agg(id ORDER BY id) FROM auth.session WHERE user_id='${f.account.id}'::uuid),'[]'::json),
 'saved',(SELECT row_to_json(v) FROM (SELECT id,ticket_id AS "ticketID",created_by AS "createdBy",author_kind AS "authorKind",proposal_entry_id AS "proposalEntryID" FROM factory.ticket_document_revision WHERE id='${f.save.commandID}'::uuid) v)
);
COMMIT;`;
}

export function expectedNewDocument(f: LoadedApplicationFixture): Document {
  const latest = f.expected.documents[0];
  check(latest);
  return {
    ...latest,
    id: f.save.commandID,
    ordinal:
      Math.max(
        ...f.expected.documents.map((d) => d.ordinal),
        ...f.expected.requirements.map((r) => r.ordinal),
      ) + 1,
    title: f.expected.ticket.title,
    description: f.save.description,
    requirementRevisionId: f.expected.requirementRevisionID,
  };
}

export function verifySnapshot(f: LoadedApplicationFixture, value: Snapshot, after = false) {
  check(
    value.readOnly === "on" &&
      value.database === "factory" &&
      value.schema === f.expected.schemaDigest,
  );
  check(
    equal(Object.keys(value.busy).sort(), Object.keys(idleRules).sort()) &&
      Object.values(value.busy).every((v) => v === 0),
  );
  check(
    equal(value.history, f.expected.history) &&
      equal(value.project, f.expected.project) &&
      equal(value.account, f.account) &&
      value.source?.eligible === true &&
      value.source.sha256 === f.expected.source.leaseSHA256 &&
      equal(value.requirements, f.expected.requirements) &&
      value.scope === f.expected.requirementRevisionID,
  );
  check(
    equal(value.ticket, {
      ...f.expected.ticket,
      ...(after ? { description: f.save.description, version: f.expected.ticket.version + 1 } : {}),
    }),
  );
  check(
    after
      ? value.saved?.id === f.save.commandID &&
          value.saved.ticketID === f.expected.ticket.id &&
          value.saved.createdBy === f.account.id &&
          value.saved.authorKind === "human" &&
          value.saved.proposalEntryID === null
      : value.saved === null,
  );
  const old = value.documents.filter((doc: Document) => doc.id !== f.save.commandID);
  check(
    equal(old, f.expected.documents) && value.documents.length === old.length + (after ? 1 : 0),
  );
  if (after) check(equal(value.documents[0], expectedNewDocument(f)));
}
