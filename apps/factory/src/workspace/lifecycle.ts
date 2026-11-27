import { and, desc, eq, sql as expression, isNull } from "drizzle-orm";
import { z } from "zod";
import { type createDatabase, type DatabaseTransaction, drizzleTransaction } from "#db/client";
import { change, operation, runtimeAttempt } from "#db/schema";
import { personalWorkspaceIdentity } from "#workspace-domain/workspace";
import { projectDevelopmentAuthorityIn } from "../access/authority";
import { workspaceWriteAuthorityIn } from "../access/change-writer";
import { type WorkspaceAuthority, workspaceAuthorityIn } from "../access/workspace";
import { CommandError } from "../command-error";
import type { createRuntimeController } from "../runtime/api";

type LifecycleInput = { workspaceID: string; requestID: string };
type StartInput = {
  workspaceID?: string | undefined;
  projectID?: string | undefined;
  requestID: string;
};

class LifecycleReplay extends Error {
  constructor(readonly result: unknown) {
    super("This lifecycle request was already dispatched");
  }
}

const invalidResult = z.strictObject({
  error: z.strictObject({ code: z.literal("invalid"), message: z.string() }),
});
function observedResult(result: unknown) {
  const rejected = invalidResult.safeParse(result);
  if (rejected.success) throw new CommandError("invalid", rejected.data.error.message);
  return result;
}

const LIFECYCLE_KIND = "workspace.lifecycle";

/** MCP and IDE commands share one durable intent and never redispatch an unknown outcome. */
export function createWorkspaceLifecycle(
  database: ReturnType<typeof createDatabase>,
  runtimes: Pick<
    ReturnType<typeof createRuntimeController>,
    "start" | "startPersisted" | "pause" | "get"
  >,
) {
  async function authorize(
    sql: DatabaseTransaction,
    userID: string,
    workspaceID: string,
    action: "start" | "pause",
  ): Promise<Pick<WorkspaceAuthority, "projectID" | "changeID">> {
    // Pausing compute does not acquire editing. Native Pause separately refuses
    // active or unconfirmed Coding; Start retains its existing writer grant.
    return action === "pause"
      ? workspaceAuthorityIn(sql, workspaceID, userID, true)
      : workspaceWriteAuthorityIn(sql, workspaceID, userID);
  }
  async function claim(
    sql: DatabaseTransaction,
    userID: string,
    input: LifecycleInput,
    action: "start" | "pause",
    targetID?: string,
  ) {
    await authorize(sql, userID, input.workspaceID, action);
    const db = drizzleTransaction(sql);
    await db
      .insert(operation)
      .values({
        id: input.requestID,
        kind: LIFECYCLE_KIND,
        scopeType: "workspace",
        scopeId: input.workspaceID,
        idempotencyKey: `${LIFECYCLE_KIND}:${input.requestID}`,
        state: "intended",
        createdBy: userID,
        payload: {
          runtimeAttemptId: targetID ?? null,
          action,
        },
      })
      .onConflictDoNothing();
    const [record] = await db
      .select({
        workspaceID: operation.scopeId,
        actorID: operation.createdBy,
        action: expression<string>`${operation.payload}->>'action'`,
        dispatchAttemptedAt: expression<
          string | null
        >`${operation.payload}->>'dispatchAttemptedAt'`,
        result: operation.result,
      })
      .from(operation)
      .where(and(eq(operation.id, input.requestID), eq(operation.kind, LIFECYCLE_KIND)))
      .for("update");
    if (
      !record ||
      record.workspaceID !== input.workspaceID ||
      record.actorID !== userID ||
      record.action !== action
    )
      throw new CommandError(
        "conflict",
        "This lifecycle request already records another operation",
      );
    if (record.dispatchAttemptedAt !== null) return { claimed: false, result: record.result };
    await db
      .update(operation)
      .set({
        state: "dispatched",
        payload: expression`${operation.payload} || jsonb_build_object('dispatchAttemptedAt', now())`,
        updatedAt: expression`now()`,
      })
      .where(and(eq(operation.id, input.requestID), eq(operation.kind, LIFECYCLE_KIND)));
    return { claimed: true, result: null };
  }
  async function complete(userID: string, input: LifecycleInput, result: unknown) {
    await drizzleTransaction(database.client)
      .update(operation)
      .set({
        state: "completed",
        result: (result ?? { state: "uncertain" }) as Record<string, unknown>,
        completedAt: expression`now()`,
        updatedAt: expression`now()`,
      })
      .where(and(eq(operation.id, input.requestID), eq(operation.kind, LIFECYCLE_KIND)));
    await database.client.begin((sql) => workspaceAuthorityIn(sql, input.workspaceID, userID));
    return result;
  }
  async function reject(userID: string, input: LifecycleInput, cause: unknown): Promise<never> {
    // A validated rejection is a known response, not an uncertain native reply.
    // Never use this path for transport errors or unavailable external outcomes.
    if (cause instanceof CommandError && cause.code === "invalid") {
      const rows = await drizzleTransaction(database.client)
        .update(operation)
        .set({
          state: "rejected",
          result: { error: { code: cause.code, message: cause.message } },
          error: cause.message,
          completedAt: expression`now()`,
          updatedAt: expression`now()`,
        })
        .where(
          and(
            eq(operation.id, input.requestID),
            eq(operation.kind, LIFECYCLE_KIND),
            eq(operation.scopeId, input.workspaceID),
            eq(operation.createdBy, userID),
            expression`${operation.payload}->>'dispatchAttemptedAt' IS NOT NULL`,
            isNull(operation.completedAt),
          ),
        )
        .returning({ id: operation.id });
      if (rows.length)
        await database.client.begin((sql) => workspaceAuthorityIn(sql, input.workspaceID, userID));
    }
    throw cause;
  }
  async function execute(userID: string, input: LifecycleInput, action: "start" | "pause") {
    const access = await database.client.begin((sql) =>
      authorize(sql, userID, input.workspaceID, action),
    );
    const [target] =
      action === "pause"
        ? await drizzleTransaction(database.client)
            .select({ id: runtimeAttempt.id })
            .from(runtimeAttempt)
            .where(
              and(
                eq(runtimeAttempt.workspaceId, input.workspaceID),
                access.changeID
                  ? eq(
                      runtimeAttempt.id,
                      drizzleTransaction(database.client)
                        .select({ id: change.runtimeAttemptId })
                        .from(change)
                        .where(eq(change.id, access.changeID)),
                    )
                  : undefined,
              ),
            )
            .orderBy(desc(runtimeAttempt.generation))
            .limit(1)
        : [];
    if (action === "pause" && !target)
      throw new CommandError("not-found", "No execution exists for this Workspace");
    const claimed = await database.client.begin((sql) =>
      claim(sql, userID, input, action, target?.id),
    );
    if (!claimed.claimed)
      return observedResult(claimed.result ?? { requestID: input.requestID, state: "uncertain" });
    try {
      const result =
        action === "start"
          ? access.changeID
            ? await runtimes.startPersisted(access.changeID, userID)
            : await runtimes.start(access.projectID, userID, input.workspaceID)
          : target
            ? ((await runtimes.pause(target.id)) ?? (await runtimes.get(target.id)))
            : null;
      return complete(userID, input, result);
    } catch (cause) {
      return reject(userID, input, cause);
    }
  }
  return {
    async start(userID: string, input: StartInput) {
      if (input.workspaceID)
        return execute(userID, { ...input, workspaceID: input.workspaceID }, "start");
      const projectID = input.projectID ?? "";
      await database.client.begin((sql) => projectDevelopmentAuthorityIn(sql, userID, projectID));
      const { workspaceID } = personalWorkspaceIdentity(projectID, userID);
      const command = { workspaceID, requestID: input.requestID };
      const [retained] = await drizzleTransaction(database.client)
        .select({ id: operation.id })
        .from(operation)
        .where(
          and(
            eq(operation.id, input.requestID),
            eq(operation.kind, LIFECYCLE_KIND),
            eq(operation.scopeId, workspaceID),
            eq(operation.createdBy, userID),
            expression`${operation.payload}->>'action' = 'start'`,
            expression`${operation.payload}->>'dispatchAttemptedAt' IS NOT NULL`,
          ),
        );
      if (retained) return execute(userID, command, "start");
      try {
        const result = await runtimes.start(
          projectID,
          userID,
          undefined,
          async (sql, initializedID) => {
            if (initializedID !== workspaceID)
              throw new CommandError("conflict", "Personal Workspace identity changed");
            const claimed = await claim(sql, userID, command, "start");
            if (!claimed.claimed) throw new LifecycleReplay(claimed.result);
          },
        );
        return complete(userID, command, result);
      } catch (cause) {
        if (!(cause instanceof LifecycleReplay)) return reject(userID, command, cause);
        return observedResult(cause.result ?? { requestID: input.requestID, state: "uncertain" });
      }
    },
    pause: (userID: string, input: LifecycleInput) => execute(userID, input, "pause"),
  };
}
