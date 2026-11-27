import { and, asc, eq, isNull, ne, sql as query } from "drizzle-orm";
import { type createDatabase, drizzleTransaction } from "#db/client";
import {
  accountAccess,
  authUser,
  developmentWorkspace,
  operation,
  projectMembership,
  workspaceShare,
} from "#db/schema";
import {
  type WorkspaceShareInput,
  workspaceShareInput,
  workspaceShareView,
} from "#workspace-domain/sharing";
import { projectDevelopmentAuthorityIn } from "../access/authority";
import { workspaceAuthorityIn } from "../access/workspace";
import { CommandError } from "../command-error";

type Database = ReturnType<typeof createDatabase>;

const SHARE_DECISION_KIND = "workspace.share_decision";

export function createWorkspaceSharing(
  database: Database,
  revoke: (workspaceID: string, userID: string) => void | Promise<void>,
) {
  async function reconcile(id: string) {
    await database.client.begin(async (sql) => {
      const db = drizzleTransaction(sql);
      const [decision] = await db
        .select({
          workspaceID: operation.scopeId,
          userID: query<string>`${operation.payload}->>'userId'`,
          permission: query<"observe" | "collaborate" | null>`${operation.payload}->>'permission'`,
          version: query<string>`${operation.result}->>'version'`,
          reconciled: query<boolean>`${operation.completedAt} IS NOT NULL`,
        })
        .from(operation)
        .where(and(eq(operation.id, id), eq(operation.kind, SHARE_DECISION_KIND)));
      if (!decision || decision.reconciled) return;
      // Serialize with sharing decisions and new authorized source access, not with runtime work.
      await db
        .select({ id: developmentWorkspace.id })
        .from(developmentWorkspace)
        .where(eq(developmentWorkspace.id, decision.workspaceID))
        .for("update");
      const [current] = await db
        .select({ version: query<string>`${workspaceShare.version}::text` })
        .from(workspaceShare)
        .where(
          and(
            eq(workspaceShare.workspaceId, decision.workspaceID),
            eq(workspaceShare.userId, decision.userID),
          ),
        );
      // A delayed old revoke must not close access obtained through a later sharing decision.
      if (current?.version === decision.version && decision.permission !== "collaborate")
        await revoke(decision.workspaceID, decision.userID);
      await db
        .update(operation)
        .set({ state: "reconciled", completedAt: query`now()`, updatedAt: query`now()` })
        .where(
          and(
            eq(operation.id, id),
            eq(operation.kind, SHARE_DECISION_KIND),
            isNull(operation.completedAt),
          ),
        );
    });
  }
  return {
    async view(userID: string, workspaceID: string) {
      return database.client.begin(async (sql) => {
        const workspace = await workspaceAuthorityIn(sql, workspaceID, userID);
        if (workspace.ownerID !== userID || workspace.kind !== "personal")
          throw new CommandError("forbidden", "Only the Workspace owner manages sharing");
        const members = await drizzleTransaction(sql)
          .select({
            userID: projectMembership.userId,
            name: authUser.name,
            permission: query<
              "observe" | "collaborate" | null
            >`CASE WHEN ${workspaceShare.revokedAt} IS NULL THEN ${workspaceShare.permission} ELSE NULL END`,
            version: query<string>`COALESCE(${workspaceShare.version},0)::text`,
          })
          .from(projectMembership)
          .innerJoin(authUser, eq(authUser.id, projectMembership.userId))
          .innerJoin(accountAccess, eq(accountAccess.userId, projectMembership.userId))
          .leftJoin(
            workspaceShare,
            and(
              eq(workspaceShare.userId, projectMembership.userId),
              eq(workspaceShare.workspaceId, workspaceID),
            ),
          )
          .where(
            and(
              eq(projectMembership.projectId, workspace.projectID),
              eq(projectMembership.role, "developer"),
              ne(projectMembership.userId, userID),
              isNull(accountAccess.disabledAt),
              isNull(accountAccess.directoryDisabledAt),
            ),
          )
          .orderBy(asc(authUser.name), asc(authUser.id));
        return {
          workspaceID,
          members: members.map((row) => ({ ...row, version: Number(row.version) })),
        };
      });
    },
    async decide(actorID: string, value: WorkspaceShareInput) {
      const input = workspaceShareInput.parse(value);
      const result = await database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        const [workspace] = await db
          .select({
            projectID: developmentWorkspace.projectId,
            ownerID: developmentWorkspace.ownerUserId,
            kind: developmentWorkspace.kind,
          })
          .from(developmentWorkspace)
          .where(eq(developmentWorkspace.id, input.workspaceID))
          .for("update");
        if (!workspace || workspace.ownerID !== actorID || workspace.kind !== "personal")
          throw new CommandError("not-found", "Owned personal Workspace not found");
        await projectDevelopmentAuthorityIn(sql, actorID, workspace.projectID);
        if (input.userID === actorID)
          throw new CommandError("conflict", "The owner cannot remove their own Workspace access");
        const idempotencyKey = `${SHARE_DECISION_KIND}:${input.commandID}`;
        const [previous] = await db
          .select({
            workspaceID: operation.scopeId,
            userID: query<string>`${operation.payload}->>'userId'`,
            actorID: operation.createdBy,
            permission: query<
              "observe" | "collaborate" | null
            >`${operation.payload}->>'permission'`,
            expectedVersion: query<string>`${operation.payload}->>'expectedVersion'`,
            result: operation.result,
          })
          .from(operation)
          .where(eq(operation.idempotencyKey, idempotencyKey));
        if (previous) {
          if (
            previous.workspaceID !== input.workspaceID ||
            previous.userID !== input.userID ||
            previous.actorID !== actorID ||
            previous.permission !== input.permission ||
            Number(previous.expectedVersion) !== input.expectedVersion
          )
            throw new CommandError(
              "conflict",
              "This sharing command already records a different decision",
            );
          return workspaceShareView.parse(previous.result);
        }
        // Removal still works after a member lost Project access. New grants do not elevate it.
        if (input.permission !== null)
          await projectDevelopmentAuthorityIn(sql, input.userID, workspace.projectID);
        const [current] = await db
          .select({ version: query<string>`${workspaceShare.version}::text` })
          .from(workspaceShare)
          .where(
            and(
              eq(workspaceShare.workspaceId, input.workspaceID),
              eq(workspaceShare.userId, input.userID),
            ),
          )
          .for("update");
        if (Number(current?.version ?? 0) !== input.expectedVersion)
          throw new CommandError(
            "conflict",
            "Workspace sharing changed. Refresh before deciding again.",
          );
        const next = workspaceShareView.parse({
          workspaceID: input.workspaceID,
          userID: input.userID,
          permission: input.permission,
          version: input.expectedVersion + 1,
        });
        const sharing = {
          permission: input.permission ?? "observe",
          version: next.version,
          grantedBy: actorID,
          revokedAt: input.permission === null ? query`now()` : null,
        };
        await db
          .insert(workspaceShare)
          .values({ workspaceId: input.workspaceID, userId: input.userID, ...sharing })
          .onConflictDoUpdate({
            target: [workspaceShare.workspaceId, workspaceShare.userId],
            set: { ...sharing, grantedAt: query`now()` },
          });
        await db.insert(operation).values({
          id: input.commandID,
          kind: SHARE_DECISION_KIND,
          scopeType: "workspace",
          scopeId: input.workspaceID,
          idempotencyKey,
          state: "pending",
          createdBy: actorID,
          payload: {
            userId: input.userID,
            permission: input.permission,
            expectedVersion: input.expectedVersion,
          },
          result: next,
        });
        if (input.permission !== null)
          await db
            .update(developmentWorkspace)
            .set({ collaborationEnabled: true })
            .where(eq(developmentWorkspace.id, input.workspaceID));
        return next;
      });
      await reconcile(input.commandID);
      return result;
    },
    async recover() {
      const pending = await database.db
        .select({ id: operation.id })
        .from(operation)
        .where(and(eq(operation.kind, SHARE_DECISION_KIND), isNull(operation.completedAt)))
        .orderBy(asc(operation.createdAt), asc(operation.id));
      for (const row of pending) await reconcile(row.id);
    },
  };
}
