import { z } from "zod";
import type { createDatabase } from "../../../../packages/db/src/client";
import { projectDevelopmentAuthorityIn } from "../access/controller";
import { CommandError } from "../command-error";
import { runtimeFactoryURL } from "../runtime/endpoints";
import { runtimeSourceCapability } from "../runtime/git-http";
import { RuntimeParentOperationError, type RuntimeHub } from "../runtime/hub";

const sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
export const personalGitStatus = z.strictObject({
  head: sha,
  branch: z.string(),
  files: z.array(z.strictObject({ path: z.string(), status: z.string().length(2) })).max(1000),
});
const mutation = z.strictObject({
  commandID: z.uuid(),
  expectedHead: sha,
  message: z.string().max(240).default(""),
});
type Database = ReturnType<typeof createDatabase>;
type Source = {
  projectID: string;
  branch: string;
  attemptID: string;
  authorName: string;
  authorEmail: string;
};
type Operation = {
  workspaceID: string;
  userID: string;
  attemptID: string;
  action: string;
  expectedHead: string;
  branch: string;
  message: string;
  state: string;
  result: unknown;
  failure: string | null;
};

export function personalGitCapability(commandID: string) {
  return runtimeSourceCapability(`personal-git:${commandID}`);
}

export async function personalGitRepository(database: Database, commandID: string) {
  const [operation] = await database.client<
    Array<{ repository: string; projectID: string; userID: string }>
  >`
    SELECT project.repository_url AS repository,workspace.project_id AS "projectID",
      operation.user_id AS "userID"
    FROM factory.personal_git_operation operation
    JOIN factory.development_workspace workspace ON workspace.id=operation.workspace_id
    JOIN factory.project project ON project.id=workspace.project_id
    JOIN factory.runtime_attempt attempt ON attempt.id=operation.runtime_attempt_id
    WHERE operation.id=${commandID} AND operation.state='attempted'
      AND operation.action IN ('fetch','pull') AND workspace.kind='personal'
      AND workspace.owner_user_id=operation.user_id AND attempt.workspace_id=workspace.id
      AND attempt.state='ready' AND attempt.stop_intended_at IS NULL`;
  if (!operation) return null;
  await database.client.begin((sql) =>
    projectDevelopmentAuthorityIn(sql, operation.userID, operation.projectID),
  );
  return operation.repository;
}

export function createPersonalGit(
  database: Database,
  hub: Pick<RuntimeHub, "connected" | "parentOperation">,
) {
  async function source(workspaceID: string, userID: string): Promise<Source> {
    const [row] = await database.client<Source[]>`
      SELECT workspace.project_id AS "projectID",project.default_branch AS branch,
        attempt.id AS "attemptID",person.name AS "authorName",person.email AS "authorEmail"
      FROM factory.development_workspace workspace
      JOIN factory.project project ON project.id=workspace.project_id
      JOIN auth."user" person ON person.id=workspace.owner_user_id
      JOIN LATERAL (SELECT id FROM factory.runtime_attempt WHERE workspace_id=workspace.id
        AND state='ready' AND stop_intended_at IS NULL ORDER BY generation DESC LIMIT 1) attempt ON true
      WHERE workspace.id=${workspaceID} AND workspace.kind='personal' AND workspace.owner_user_id=${userID}`;
    if (!row) throw new CommandError("conflict", "Open your personal Workspace before using Git");
    await database.client.begin((sql) => projectDevelopmentAuthorityIn(sql, userID, row.projectID));
    if (!hub.connected(row.attemptID))
      throw new CommandError("unavailable", "Workspace compute is reconnecting");
    return row;
  }
  async function invoke(
    saved: Source,
    id: string,
    input: Readonly<Record<string, string>>,
    workspaceID: string,
    userID: string,
  ) {
    return hub.parentOperation(
      saved.attemptID,
      {
        operationId: id,
        action: "workspace-git",
        data: JSON.stringify({ ...input, branch: saved.branch }),
      },
      (send) =>
        database.client.begin(async (sql) => {
          await projectDevelopmentAuthorityIn(sql, userID, saved.projectID);
          const [current] = await sql`
            SELECT attempt.id FROM factory.runtime_attempt attempt
            JOIN factory.development_workspace workspace ON workspace.id=attempt.workspace_id
            WHERE attempt.id=${saved.attemptID} AND attempt.workspace_id=${workspaceID}
              AND workspace.kind='personal' AND workspace.owner_user_id=${userID}
              AND attempt.state='ready' AND attempt.stop_intended_at IS NULL
            FOR SHARE OF attempt,workspace`;
          if (!current) throw new CommandError("conflict", "Personal Workspace execution changed");
          send();
        }),
    );
  }
  return {
    async read(workspaceID: string, userID: string, path?: string) {
      const saved = await source(workspaceID, userID);
      try {
        const result = await invoke(
          saved,
          crypto.randomUUID(),
          {
            action: path === undefined ? "status" : "diff",
            ...(path === undefined ? {} : { path }),
          },
          workspaceID,
          userID,
        );
        const raw: unknown = JSON.parse(result.data ?? "null");
        return path === undefined
          ? personalGitStatus.parse(raw)
          : z.strictObject({ diff: z.string().max(256 * 1024) }).parse(raw);
      } catch (cause) {
        if (cause instanceof CommandError) throw cause;
        throw new CommandError(
          "unavailable",
          cause instanceof RuntimeParentOperationError
            ? cause.message
            : "Git is unavailable. Reopen your personal Workspace and refresh Git status",
        );
      }
    },
    async mutate(workspaceID: string, userID: string, action: string, raw: unknown) {
      if (!["commit", "fetch", "pull"].includes(action))
        throw new CommandError("invalid", "Unsupported Git action");
      const input = mutation.parse(raw);
      if (action === "commit" && !input.message.trim())
        throw new CommandError("invalid", "Enter a commit message");
      const saved = await source(workspaceID, userID);
      const connection = database.coordination();
      try {
        await connection`SELECT pg_advisory_lock(hashtext(${`personal-git:${workspaceID}`}))`;
        await connection`INSERT INTO factory.personal_git_operation(
          id,workspace_id,runtime_attempt_id,user_id,action,expected_head,branch,message)
          VALUES(${input.commandID},${workspaceID},${saved.attemptID},${userID},${action},
            ${input.expectedHead},${saved.branch},${input.message}) ON CONFLICT DO NOTHING`;
        const [operation] = await connection<Operation[]>`
          SELECT workspace_id AS "workspaceID",runtime_attempt_id AS "attemptID",user_id AS "userID",
            action,expected_head AS "expectedHead",branch,message,state,result,failure
          FROM factory.personal_git_operation WHERE id=${input.commandID}`;
        if (
          !operation ||
          operation.workspaceID !== workspaceID ||
          operation.userID !== userID ||
          operation.action !== action ||
          operation.expectedHead !== input.expectedHead ||
          operation.message !== input.message
        )
          throw new CommandError("conflict", "Git command identity belongs to another request");
        if (operation.state === "succeeded") return personalGitStatus.parse(operation.result);
        if (operation.state !== "intended")
          throw new CommandError(
            "conflict",
            operation.failure ?? "The previous Git outcome is unconfirmed. Inspect Git status",
          );
        // Recheck authority and execution after waiting for the Workspace lock.
        const current = await source(workspaceID, userID);
        if (current.attemptID !== operation.attemptID || current.branch !== operation.branch)
          throw new CommandError("conflict", "Workspace execution or default branch changed");
        await connection`UPDATE factory.personal_git_operation SET state='attempted',attempted_at=now()
          WHERE id=${input.commandID} AND state='intended'`;
        try {
          const result = await invoke(
            saved,
            input.commandID,
            {
              action,
              expectedHead: input.expectedHead,
              message: input.message,
              authorName: saved.authorName,
              authorEmail: saved.authorEmail,
              ...(action !== "commit"
                ? {
                    repository: runtimeFactoryURL(
                      `/internal/personal-git/${input.commandID}/${personalGitCapability(input.commandID)}`,
                    ),
                  }
                : {}),
            },
            workspaceID,
            userID,
          );
          const status = personalGitStatus.parse(JSON.parse(result.data ?? "null"));
          // source_revision is the immutable initialization basis, not the
          // moving Git HEAD. Retain the new HEAD only in this operation outcome.
          await connection`UPDATE factory.personal_git_operation SET state='succeeded',
            result=${JSON.stringify(status)}::text::jsonb,completed_at=now() WHERE id=${input.commandID}`;
          return status;
        } catch (cause) {
          const known =
            cause instanceof RuntimeParentOperationError || cause instanceof CommandError;
          const failure = known
            ? cause.message
            : "Git outcome is unconfirmed. Inspect Git status before issuing another command";
          await connection`UPDATE factory.personal_git_operation
            SET state=${known ? "failed" : "uncertain"},failure=${failure},
              completed_at=${known ? new Date() : null} WHERE id=${input.commandID}`;
          throw new CommandError(known ? "conflict" : "unavailable", failure);
        }
      } finally {
        try {
          await connection`SELECT pg_advisory_unlock(hashtext(${`personal-git:${workspaceID}`}))`;
        } finally {
          await connection.end({ timeout: 1 });
        }
      }
    },
  };
}
