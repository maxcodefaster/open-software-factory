import { and, desc, eq, isNull, sql as query } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { type createDatabase, drizzleTransaction } from "#db/client";
import { authUser, developmentWorkspace, operation, project, runtimeAttempt } from "#db/schema";
import { projectDevelopmentAuthorityIn } from "../access/authority";
import { workspaceWriteAuthorityIn } from "../access/change-writer";
import { workspaceAuthorityIn } from "../access/workspace";
import { CommandError } from "../command-error";
import { substrateFactoryURL } from "../runtime/endpoints";
import {
  type RuntimeHub,
  RuntimeParentOperationError,
  runtimeSourceCapability,
} from "../runtime/transport-api";

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
  binding: unknown;
};

const PERSONAL_GIT_KIND = "workspace.personal_git";

export function personalGitCapability(commandID: string) {
  return runtimeSourceCapability(`personal-git:${commandID}`);
}

export async function personalGitRepository(database: Database, commandID: string) {
  const [record] = await database.db
    .select({
      repository: project.repositoryUrl,
      projectID: developmentWorkspace.projectId,
      userID: operation.createdBy,
      workspaceID: operation.scopeId,
    })
    .from(operation)
    .innerJoin(developmentWorkspace, query`${developmentWorkspace.id}::text = ${operation.scopeId}`)
    .innerJoin(project, eq(project.id, developmentWorkspace.projectId))
    .innerJoin(
      runtimeAttempt,
      query`${runtimeAttempt.id}::text = ${operation.payload}->>'runtimeAttemptId'`,
    )
    .where(
      and(
        eq(operation.id, commandID),
        eq(operation.kind, PERSONAL_GIT_KIND),
        eq(operation.state, "attempted"),
        query`${operation.payload}->>'action' IN ('fetch', 'pull')`,
        eq(developmentWorkspace.kind, "personal"),
        eq(runtimeAttempt.workspaceId, developmentWorkspace.id),
        eq(runtimeAttempt.state, "ready"),
        isNull(runtimeAttempt.stopIntendedAt),
      ),
    );
  if (!record?.userID) return null;
  const userID = record.userID;
  await database.client.begin((sql) => workspaceAuthorityIn(sql, record.workspaceID, userID, true));
  return record.repository;
}

export function createPersonalGit(
  database: Database,
  hub: Pick<RuntimeHub, "connected" | "parentOperation">,
) {
  async function source(workspaceID: string, userID: string, write = false): Promise<Source> {
    await database.client.begin((sql) => workspaceAuthorityIn(sql, workspaceID, userID, write));
    const [row] = await database.db
      .select({
        projectID: developmentWorkspace.projectId,
        branch: project.defaultBranch,
        attemptID: runtimeAttempt.id,
        authorName: authUser.name,
        authorEmail: authUser.email,
        binding: runtimeAttempt.bindingIntent,
      })
      .from(developmentWorkspace)
      .innerJoin(project, eq(project.id, developmentWorkspace.projectId))
      .innerJoin(authUser, eq(authUser.id, userID))
      .innerJoin(
        runtimeAttempt,
        and(
          eq(runtimeAttempt.workspaceId, developmentWorkspace.id),
          eq(runtimeAttempt.state, "ready"),
          isNull(runtimeAttempt.stopIntendedAt),
        ),
      )
      .where(
        and(eq(developmentWorkspace.id, workspaceID), eq(developmentWorkspace.kind, "personal")),
      )
      .orderBy(desc(runtimeAttempt.generation))
      .limit(1);
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
          if (["status", "diff"].includes(input["action"] ?? ""))
            await workspaceAuthorityIn(sql, workspaceID, userID);
          else await workspaceWriteAuthorityIn(sql, workspaceID, userID);
          const attempt = alias(runtimeAttempt, "attempt");
          const workspace = alias(developmentWorkspace, "workspace");
          const [current] = await drizzleTransaction(sql)
            .select({ id: attempt.id })
            .from(attempt)
            .innerJoin(workspace, eq(workspace.id, attempt.workspaceId))
            .where(
              and(
                eq(attempt.id, saved.attemptID),
                eq(attempt.workspaceId, workspaceID),
                eq(workspace.kind, "personal"),
                eq(attempt.state, "ready"),
                isNull(attempt.stopIntendedAt),
              ),
            )
            .for("share", { of: [attempt, workspace] });
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
      if (action !== "commit" && action !== "fetch" && action !== "pull")
        throw new CommandError("invalid", "Unsupported Git action");
      const input = mutation.parse(raw);
      if (action === "commit" && !input.message.trim())
        throw new CommandError("invalid", "Enter a commit message");
      const saved = await source(workspaceID, userID, true);
      const connection = database.coordination();
      try {
        const db = drizzleTransaction(connection);
        await connection`SELECT pg_advisory_lock(hashtext(${`personal-git:${workspaceID}`}))`;
        const idempotencyKey = `${PERSONAL_GIT_KIND}:${input.commandID}`;
        await db
          .insert(operation)
          .values({
            id: input.commandID,
            kind: PERSONAL_GIT_KIND,
            scopeType: "workspace",
            scopeId: workspaceID,
            idempotencyKey,
            state: "intended",
            createdBy: userID,
            payload: {
              runtimeAttemptId: saved.attemptID,
              action,
              expectedHead: input.expectedHead,
              branch: saved.branch,
              message: input.message,
            },
          })
          .onConflictDoNothing();
        const [record] = await db
          .select({
            workspaceID: operation.scopeId,
            attemptID: query<string>`${operation.payload}->>'runtimeAttemptId'`,
            userID: operation.createdBy,
            action: query<string>`${operation.payload}->>'action'`,
            expectedHead: query<string>`${operation.payload}->>'expectedHead'`,
            branch: query<string>`${operation.payload}->>'branch'`,
            message: query<string>`${operation.payload}->>'message'`,
            state: operation.state,
            result: operation.result,
            failure: operation.error,
          })
          .from(operation)
          .where(and(eq(operation.id, input.commandID), eq(operation.kind, PERSONAL_GIT_KIND)));
        if (
          !record ||
          record.workspaceID !== workspaceID ||
          record.userID !== userID ||
          record.action !== action ||
          record.expectedHead !== input.expectedHead ||
          record.message !== input.message
        )
          throw new CommandError("conflict", "Git command identity belongs to another request");
        if (record.state === "succeeded") return personalGitStatus.parse(record.result);
        if (record.state !== "intended")
          throw new CommandError(
            "conflict",
            record.failure ?? "The previous Git outcome is unconfirmed. Inspect Git status",
          );
        // Recheck authority and execution after waiting for the Workspace lock.
        const current = await source(workspaceID, userID, true);
        if (current.attemptID !== record.attemptID || current.branch !== record.branch)
          throw new CommandError("conflict", "Workspace execution or default branch changed");
        await db
          .update(operation)
          .set({
            state: "attempted",
            payload: query`${operation.payload} || jsonb_build_object('attemptedAt', now())`,
            updatedAt: query`now()`,
          })
          .where(
            and(
              eq(operation.id, input.commandID),
              eq(operation.kind, PERSONAL_GIT_KIND),
              eq(operation.state, "intended"),
            ),
          );
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
                    repository: substrateFactoryURL(
                      `/internal/personal-git/${input.commandID}/${personalGitCapability(input.commandID)}`,
                      saved.binding,
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
          await db
            .update(operation)
            .set({
              state: "succeeded",
              result: status,
              completedAt: query`now()`,
              updatedAt: query`now()`,
            })
            .where(and(eq(operation.id, input.commandID), eq(operation.kind, PERSONAL_GIT_KIND)));
          return status;
        } catch (cause) {
          const known =
            cause instanceof RuntimeParentOperationError || cause instanceof CommandError;
          const failure = known
            ? cause.message
            : "Git outcome is unconfirmed. Inspect Git status before issuing another command";
          await db
            .update(operation)
            .set({
              state: known ? "failed" : "uncertain",
              error: failure,
              completedAt: known ? new Date() : null,
              updatedAt: query`now()`,
            })
            .where(and(eq(operation.id, input.commandID), eq(operation.kind, PERSONAL_GIT_KIND)));
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
