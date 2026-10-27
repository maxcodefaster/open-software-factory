import type { createDatabase } from "../../../../packages/db/src/client";
import { CommandError } from "../command-error";
import { runtimeRepositoryCloneURL } from "../runtime/endpoints";
import type { RuntimeHub } from "../runtime/hub";
import { createAgentTurnStore } from "./turn-store";

// Serialize only the frame send with Stop, approval/mode and runtime changes.
// The upstream response must never keep the authority locks or pool connection.
export function createAgentCommitTransport(
  database: ReturnType<typeof createDatabase>,
  hub: RuntimeHub,
) {
  const turns = createAgentTurnStore(database);
  const transport = (
    attemptID: string,
    operation: Record<string, string> & {
      operationId: string;
      action: "git-prepare-commit" | "git-observe-commit" | "git-push";
      expectedSha: string;
      commitSha?: string;
      branch?: string;
    },
  ) =>
    hub.parentOperation(attemptID, operation, async (send) => {
      const allowed = await turns.validateCommit(operation.operationId, async (sql) => {
        const current = await sql<Array<{ id: string; repositoryURL: string }>>`
          SELECT operation.id,project.repository_url AS "repositoryURL" FROM factory.change_commit_operation operation
          JOIN factory.change change ON change.id = operation.change_id
          JOIN factory.project project ON project.id=change.project_id
          JOIN factory.change_writer writer ON writer.change_id=change.id AND writer.state='agent' AND writer.turn_id=operation.id
          JOIN factory.change_agent_session session ON session.change_id = change.id
          JOIN factory.change_agent_turn_intent intent ON intent.turn_id = operation.id
          JOIN factory.runtime_attempt attempt ON attempt.id = operation.runtime_attempt_id
          WHERE operation.id = ${operation.operationId} AND operation.source = 'agent'
            AND operation.runtime_attempt_id = ${attemptID} AND change.runtime_attempt_id = ${attemptID}
            AND attempt.state = 'ready' AND intent.runtime_attempt_id = ${attemptID}
            AND session.runtime_attempt_id = ${attemptID} AND session.active_turn_id = operation.id
            AND session.opencode_session_id = intent.session_id AND session.state = 'waiting'
            AND NOT session.stop_pending AND operation.expected_parent_sha = ${operation.expectedSha ?? ""}
            AND COALESCE(operation.merge_parent_sha,'') = ${operation["mergeParentSha"] ?? ""}
            AND operation.state = ${operation.action !== "git-push" ? "commit-intended" : "push-intended"}
            AND (${operation.action !== "git-push"} OR
              (operation.commit_sha = ${operation.commitSha ?? ""} AND operation.branch_name = ${operation.branch ?? ""}))`;
        if (!current[0])
          throw new CommandError(
            "conflict",
            "Build commit runtime authority changed before dispatch",
          );
        if (operation.action === "git-push") {
          const repository = current[0].repositoryURL;
          const destination = repository.startsWith("file://")
            ? repository
            : runtimeRepositoryCloneURL(repository);
          if (operation["repositoryURL"] !== destination)
            throw new CommandError(
              "conflict",
              "Build push destination no longer matches its Project",
            );
        }
        send();
      });
      if (!allowed)
        throw new CommandError("conflict", "Build commit authority changed before dispatch");
    });
  return Object.assign(transport, {
    async observeRetainedCheckout(
      attemptID: string,
      operation: {
        operationId: string;
        action: "git-observe-commit";
        expectedSha: string;
        mergeParentSha?: string;
        commitMessage: string;
        authorName: string;
        authorEmail: string;
      },
    ) {
      const [replacement] = await database.client<Array<{ id: string }>>`
        SELECT current.id FROM factory.change_commit_operation operation
        JOIN factory.runtime_attempt original ON original.id = operation.runtime_attempt_id
        JOIN factory.change change ON change.id = operation.change_id
        JOIN factory.runtime_attempt current ON current.id = change.runtime_attempt_id
        WHERE operation.id = ${operation.operationId} AND operation.runtime_attempt_id = ${attemptID}
          AND operation.state = 'commit-intended' AND operation.source = 'agent'
          AND original.state IN ('stopped', 'failed') AND original.workspace_id IS NOT NULL
          AND current.workspace_id = original.workspace_id AND current.change_id = operation.change_id
          AND current.project_id = original.project_id AND current.generation > original.generation AND current.state = 'ready'`;
      if (!replacement) return transport(attemptID, operation);
      // A replacement may observe the same durable checkout, never prepare or push
      // under an old generation. The original intent and Session remain immutable.
      return hub.parentOperation(replacement.id, operation, async (send) => {
        const allowed = await turns.validateCommit(operation.operationId, async (sql) => {
          const [current] = await sql<Array<{ id: string }>>`
            SELECT current.id FROM factory.change_commit_operation operation
            JOIN factory.change change ON change.id = operation.change_id
            JOIN factory.change_agent_session session ON session.change_id = change.id
            JOIN factory.change_agent_turn_intent intent ON intent.turn_id = operation.id
            JOIN factory.runtime_attempt original ON original.id = operation.runtime_attempt_id
            JOIN factory.runtime_attempt current ON current.id = change.runtime_attempt_id
            WHERE operation.id = ${operation.operationId} AND operation.runtime_attempt_id = ${attemptID}
              AND operation.source = 'agent' AND operation.state = 'commit-intended' AND operation.expected_parent_sha = ${operation.expectedSha}
              AND COALESCE(operation.merge_parent_sha,'') = ${operation.mergeParentSha ?? ""}
              AND session.active_turn_id = operation.id AND session.state = 'waiting' AND NOT session.stop_pending
              AND session.runtime_attempt_id = original.id AND intent.runtime_attempt_id = original.id
              AND session.opencode_session_id = intent.session_id AND original.state IN ('stopped', 'failed')
              AND original.workspace_id IS NOT NULL AND current.workspace_id = original.workspace_id
              AND current.id = ${replacement.id} AND current.state = 'ready' AND current.generation > original.generation
              AND current.change_id = operation.change_id AND current.project_id = original.project_id`;
          if (!current)
            throw new CommandError(
              "conflict",
              "Retained checkout observation authority changed before dispatch",
            );
          send();
        });
        if (!allowed)
          throw new CommandError(
            "conflict",
            "Retained checkout approval changed before observation",
          );
      });
    },
  });
}
