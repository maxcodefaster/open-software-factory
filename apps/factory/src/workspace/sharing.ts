import { and, asc, eq, isNull, ne, sql as query } from "drizzle-orm";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import {
  accountAccess,
  authUser,
  developmentWorkspace,
  projectMembership,
  workspaceShare,
  workspaceShareDecision,
} from "../../../../packages/db/src/schema";
import {
  type WorkspaceShareInput,
  workspaceShareInput,
  workspaceShareView,
} from "../../../../packages/workspace-domain/src/sharing";
import { projectDevelopmentAuthorityIn } from "../access/controller";
import { workspaceAuthorityIn } from "../access/workspace";
import { CommandError } from "../command-error";

type Database = ReturnType<typeof createDatabase>;

export function createWorkspaceSharing(
  database: Database,
  revoke: (workspaceID: string, userID: string) => void | Promise<void>,
) {
  async function reconcile(id: string) {
    await database.client.begin(async (sql) => {
      const db = drizzleTransaction(sql);
      const [decision] = await db
        .select({
          workspaceID: workspaceShareDecision.workspaceId,
          userID: workspaceShareDecision.userId,
          permission: workspaceShareDecision.permission,
          version: query<string>`${workspaceShareDecision.result}->>'version'`,
          reconciled: query<boolean>`${workspaceShareDecision.accessReconciledAt} IS NOT NULL`,
        })
        .from(workspaceShareDecision)
        .where(eq(workspaceShareDecision.id, id));
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
        .update(workspaceShareDecision)
        .set({ accessReconciledAt: query`now()` })
        .where(
          and(eq(workspaceShareDecision.id, id), isNull(workspaceShareDecision.accessReconciledAt)),
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
        const [previous] = await db
          .select({
            workspaceID: workspaceShareDecision.workspaceId,
            userID: workspaceShareDecision.userId,
            actorID: workspaceShareDecision.actorId,
            permission: workspaceShareDecision.permission,
            expectedVersion: query<string>`${workspaceShareDecision.expectedVersion}::text`,
            result: workspaceShareDecision.result,
          })
          .from(workspaceShareDecision)
          .where(eq(workspaceShareDecision.id, input.commandID));
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
        await db.insert(workspaceShareDecision).values({
          id: input.commandID,
          workspaceId: input.workspaceID,
          userId: input.userID,
          actorId: actorID,
          permission: input.permission,
          expectedVersion: input.expectedVersion,
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
        .select({ id: workspaceShareDecision.id })
        .from(workspaceShareDecision)
        .where(isNull(workspaceShareDecision.accessReconciledAt))
        .orderBy(asc(workspaceShareDecision.createdAt), asc(workspaceShareDecision.id));
      for (const row of pending) await reconcile(row.id);
    },
  };
}
