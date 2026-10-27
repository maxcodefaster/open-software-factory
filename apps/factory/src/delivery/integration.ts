import type { createDatabase } from "../../../../packages/db/src/client";
import { lockChangeWriterIn } from "../access/change-writer";
import { projectAuthorityIn } from "../access/controller";
import type { createAgentController } from "../agent/controller";
import { CommandError } from "../command-error";
import { runtimeRepositoryCloneURL } from "../runtime/endpoints";
import type { RuntimeHub } from "../runtime/hub";
import { RuntimeParentOperationError } from "../runtime/hub";

type Operation = {
  id: string;
  changeID: string;
  attemptID: string;
  parent: string;
  base: string;
  branch: string;
  message: string;
  state: string;
  sha: string | null;
  error: string | null;
  userID: string;
  repository: string;
};

// Integration uses the existing checkout and Factory commit/push protocol.
// Only an observed Git conflict enters the retained implementation Session.
export function createChangeIntegration(
  database: ReturnType<typeof createDatabase>,
  hub: RuntimeHub,
  agent: {
    prompt(
      ...args: Parameters<ReturnType<typeof createAgentController>["prompt"]>
    ): Promise<unknown>;
  },
  runtime: { startPersisted(id: string, userID: string): Promise<unknown> },
) {
  async function operation(changeID: string) {
    const [row] = await database.client<Operation[]>`
      SELECT operation.id,operation.change_id AS "changeID",operation.runtime_attempt_id AS "attemptID",
        operation.expected_parent_sha AS parent,operation.integration_base_sha AS base,
        operation.branch_name AS branch,operation.commit_message AS message,operation.state,
        operation.commit_sha AS sha,operation.last_error AS error,operation.created_by AS "userID",
        project.repository_url AS repository
      FROM factory.change_commit_operation operation JOIN factory.change change ON change.id=operation.change_id
      JOIN factory.project project ON project.id=change.project_id
      WHERE operation.change_id=${changeID} AND operation.source='integration'
      ORDER BY operation.sequence DESC LIMIT 1`;
    return row;
  }
  async function send(
    op: Operation,
    action: "git-prepare-integration" | "git-observe-commit" | "git-push",
  ) {
    const [current] = await database.client<
      { id: string }[]
    >`SELECT current.id FROM factory.change change
      JOIN factory.runtime_attempt current ON current.id=change.runtime_attempt_id
      JOIN factory.runtime_attempt original ON original.id=${op.attemptID}
      WHERE change.id=${op.changeID} AND current.state='ready' AND original.workspace_id=current.workspace_id`;
    if (!current)
      throw new CommandError("unavailable", "The Ticket Workspace is not ready for integration.");
    const repositoryURL = op.repository.startsWith("file://")
      ? op.repository
      : runtimeRepositoryCloneURL(op.repository);
    return hub.parentOperation(
      current.id,
      {
        operationId: op.id,
        action,
        expectedSha: op.parent,
        mergeParentSha: op.base,
        commitMessage: op.message,
        authorName: "Open Software Factory",
        authorEmail: "factory@localhost",
        repositoryURL,
        branch: op.branch,
        commitSha: op.sha ?? "",
        username: process.env["FACTORY_FORGEJO_OWNER"] ?? "factory",
        password: process.env["FACTORY_FORGEJO_TOKEN"] ?? "",
      },
      async (forward) => {
        await database.client.begin(async (sql) => {
          const writer = await lockChangeWriterIn(sql, op.changeID);
          await projectAuthorityIn(sql, op.userID, writer.projectID);
          const [valid] =
            await sql`SELECT operation.id FROM factory.change_commit_operation operation
          JOIN factory.change change ON change.id=operation.change_id
          JOIN factory.ticket ticket ON ticket.id=change.ticket_id
          JOIN factory.requirement_approval approval ON approval.id=change.requirement_approval_id
          JOIN factory.change_agent_session session ON session.change_id=change.id
          JOIN factory.runtime_attempt current ON current.id=change.runtime_attempt_id
          JOIN factory.runtime_attempt original ON original.id=operation.runtime_attempt_id
          JOIN factory.project_delivery_queue queue ON queue.project_id=change.project_id AND queue.change_id=change.id
          WHERE operation.id=${op.id} AND operation.source='integration'
            AND operation.expected_parent_sha=${op.parent} AND operation.merge_parent_sha=${op.base}
            AND operation.state=${action === "git-push" ? "push-intended" : "commit-intended"}
            AND (${action !== "git-push"} OR operation.commit_sha=${op.sha})
            AND change.state='active' AND change.cancel_requested_at IS NULL AND ticket.trashed_at IS NULL
            AND session.state='committed' AND NOT session.stop_pending
            AND current.id=${current.id} AND current.state='ready' AND current.workspace_id=original.workspace_id
            AND approval.requirement_revision_id=(SELECT id FROM factory.requirement_revision WHERE ticket_id=ticket.id ORDER BY ordinal DESC LIMIT 1)
            AND NOT EXISTS(SELECT 1 FROM factory.agent_turn WHERE change_id=change.id AND state IN ('pending','dispatching','running','uncertain'))`;
          if (!valid || !writer.available || writer.state !== "agent")
            throw new CommandError(
              "conflict",
              "Integration writing authority changed before dispatch.",
            );
          forward();
        });
      },
    );
  }
  return {
    async reconcile(changeID: string, base: string) {
      let op = await operation(changeID);
      if (op?.state === "failed" && op.error !== "integration has conflicts") {
        const [later] = await database.client`SELECT id FROM factory.change_commit_operation
          WHERE change_id=${changeID} AND sequence>(SELECT sequence FROM factory.change_commit_operation WHERE id=${op.id})
            AND state='succeeded' LIMIT 1`;
        if (!later) return false;
      }
      if (op?.state === "failed" && op.error === "integration has conflicts") {
        const [later] = await database.client`SELECT id FROM factory.change_commit_operation
          WHERE change_id=${changeID} AND sequence>(SELECT sequence FROM factory.change_commit_operation WHERE id=${op.id})
            AND state='succeeded' LIMIT 1`;
        if (!later) {
          await agent.prompt(
            changeID,
            [
              `Factory started integration of exact main commit ${op.base} into candidate ${op.parent}. Git reported conflicts.`,
              "The existing Ticket checkout retains this exact merge. Resolve only where both approved intentions are clear.",
              "If resolution needs a product or architecture decision, ask the human and stop. Do not silently change approved scope.",
              "Do not start another merge, abort this merge, rebase, commit or push. Preserve MERGE_HEAD. Resolve the files and run relevant checks.",
              "Factory will create the two-parent commit, fresh Verification and independent review.",
            ].join("\n\n"),
            op.userID,
            op.id,
            true,
          );
          return false;
        }
      }
      if (!op || ["succeeded", "failed"].includes(op.state)) {
        const created = await database.client.begin(async (sql) => {
          const writer = await lockChangeWriterIn(sql, changeID);
          if (!writer.available || writer.state !== "agent") return false;
          const [row] = await sql<{ id: string; userID: string }[]>`
            SELECT change.id,change.created_by AS "userID" FROM factory.change change
            JOIN factory.change_agent_session session ON session.change_id=change.id
            JOIN factory.project_delivery_queue queue ON queue.change_id=change.id
            WHERE change.id=${changeID} AND session.state='committed' AND NOT session.stop_pending
              AND NOT EXISTS(SELECT 1 FROM factory.agent_turn WHERE change_id=change.id AND state IN ('pending','dispatching','running','uncertain'))
              AND NOT EXISTS(SELECT 1 FROM factory.change_commit_operation WHERE change_id=change.id AND state NOT IN ('succeeded','failed'))`;
          if (!row) return false;
          await projectAuthorityIn(sql, row.userID, writer.projectID);
          await sql`INSERT INTO factory.change_commit_operation(id,change_id,runtime_attempt_id,sequence,branch_name,
            expected_parent_sha,integration_base_sha,merge_parent_sha,commit_message,idempotency_key,state,created_by,source)
            SELECT ${crypto.randomUUID()},change.id,change.runtime_attempt_id,
              (SELECT COALESCE(MAX(sequence),0)+1 FROM factory.change_commit_operation WHERE change_id=change.id),change.branch_name,
              (SELECT commit_sha FROM factory.change_commit_operation WHERE change_id=change.id AND state='succeeded' ORDER BY sequence DESC LIMIT 1),
              ${base},${base},'Integrate current main',${`integration:${changeID}:${base}:`} ||
                (SELECT commit_sha FROM factory.change_commit_operation WHERE change_id=change.id AND state='succeeded' ORDER BY sequence DESC LIMIT 1),
              'commit-intended',change.created_by,'integration'
            FROM factory.change change WHERE change.id=${changeID}`;
          return true;
        });
        if (!created) return false;
        op = await operation(changeID);
      }
      if (!op) return false;
      try {
        await runtime.startPersisted(changeID, op.userID);
      } catch {
        // Preparing compute has sent no Git frame. Keep the undispatched intent
        // available rather than turning a cold start into an uncertain write.
        return false;
      }
      const [ready] = await database.client`SELECT id FROM factory.runtime_attempt
        WHERE id=(SELECT runtime_attempt_id FROM factory.change WHERE id=${changeID}) AND state='ready'`;
      if (!ready) return false;
      try {
        if (op.state === "commit-intended") {
          const recovering = op.error !== null;
          await database.client`UPDATE factory.change_commit_operation SET last_error='Integration dispatched; exact outcome pending',updated_at=now()
            WHERE id=${op.id} AND state='commit-intended'`;
          const result = await send(
            op,
            recovering ? "git-observe-commit" : "git-prepare-integration",
          );
          if (!result.commitSHA) throw new Error("Integrated commit was not confirmed.");
          op.sha = result.commitSHA;
          await database.client`UPDATE factory.change_commit_operation SET state='push-intended',commit_sha=${op.sha},updated_at=now()
            WHERE id=${op.id} AND state='commit-intended'`;
        }
        const result = await send(op, "git-push");
        if (!op.sha || result.remoteSHA !== op.sha)
          throw new Error("Integrated remote commit was not confirmed.");
        await database.client`UPDATE factory.change_commit_operation SET state='succeeded',observed_remote_sha=${op.sha},
          last_error=NULL,completed_at=now(),updated_at=now() WHERE id=${op.id} AND state='push-intended'`;
        await database.client`UPDATE factory.change SET failure=NULL WHERE id=${changeID} AND state='active' AND failure IS NOT NULL`;
        return true;
      } catch (cause) {
        const conflict =
          cause instanceof RuntimeParentOperationError &&
          cause.message === "integration has conflicts";
        const rejected = cause instanceof CommandError && op.error === null;
        await database.client`UPDATE factory.change_commit_operation SET
          state=CASE WHEN ${conflict || rejected} THEN 'failed'::factory.change_commit_state ELSE state END,
          completed_at=CASE WHEN ${conflict || rejected} THEN now() ELSE NULL END,
          last_error=${(cause instanceof Error ? cause.message : "Integration outcome unknown").slice(0, 2000)},updated_at=now()
          WHERE id=${op.id} AND state NOT IN ('succeeded','failed')`;
        await database.client`UPDATE factory.change SET failure=${(cause instanceof Error ? cause.message : "Integration outcome unknown").slice(0, 2000)}
          WHERE id=${changeID} AND state='active'`;
        return false;
      }
    },
  };
}
