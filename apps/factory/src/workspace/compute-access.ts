import { and, desc, eq, sql as expression } from "drizzle-orm";
import type { createDatabase } from "#db/client";
import { operation, runtimeAttempt } from "#db/schema";
import { nativeLifecycleWindowMS } from "#runtime-domain/timing";
import { workspaceWriteAuthorityIn } from "../access/change-writer";
import { workspaceAuthorityIn } from "../access/workspace";
import { CommandError } from "../command-error";
import type { createRuntimeController } from "../runtime/api";
import type { RuntimeHub } from "../runtime/transport-api";

/** Demand resumes the original native Workspace, never inference or failed compute. */
export function createWorkspaceComputeAccess(
  database: ReturnType<typeof createDatabase>,
  hub: Pick<RuntimeHub, "ready" | "sourceConnected">,
  runtime: Pick<
    ReturnType<typeof createRuntimeController>,
    "start" | "startPersisted" | "resumeForSource" | "get"
  >,
  closing: () => boolean,
) {
  return async (
    workspaceID: string,
    userID: string,
    write = true,
    expectedAttemptID?: string,
    signal?: AbortSignal,
    sourceOnly = false,
  ) => {
    signal?.throwIfAborted();
    const authorize = () =>
      database.client.begin(async (sql) => {
        const access = write
          ? await workspaceWriteAuthorityIn(sql, workspaceID, userID)
          : await workspaceAuthorityIn(sql, workspaceID, userID, true);
        return { projectID: access.projectID, changeID: access.changeID };
      });
    const access = await authorize();
    const [attempt] = await database.db
      .select({
        id: runtimeAttempt.id,
        state: runtimeAttempt.state,
        computeWait: expression<string | null>`${operation.payload}->>'reason'`,
      })
      .from(runtimeAttempt)
      .leftJoin(
        operation,
        and(
          eq(operation.kind, "runtime.compute_wait"),
          eq(operation.scopeType, "runtime_attempt"),
          eq(operation.scopeId, expression`${runtimeAttempt.id}::text`),
          eq(
            operation.idempotencyKey,
            expression`'runtime.compute_wait:' || ${runtimeAttempt.id}::text`,
          ),
        ),
      )
      .where(eq(runtimeAttempt.workspaceId, workspaceID))
      .orderBy(desc(runtimeAttempt.generation))
      .limit(1);
    if (expectedAttemptID && attempt?.id !== expectedAttemptID)
      throw new CommandError(
        "conflict",
        "Execution handle belongs to a different Runtime Attempt. It cannot wake replacement compute.",
      );
    if (
      !attempt ||
      ["stopped", "stop-intended", "stopping", "failed", "cleanup-failed"].includes(attempt.state)
    )
      throw new CommandError(
        "conflict",
        "Start this Workspace explicitly before accessing compute",
      );
    if (closing()) throw new CommandError("unavailable", "Factory is stopping");
    signal?.throwIfAborted();
    if (
      attempt.state === "paused" ||
      attempt.state === "resuming" ||
      (attempt.state === "starting" && attempt.computeWait === "compute-capacity")
    ) {
      if (sourceOnly && !write) {
        // Current-file observation resumes only this retained Actor, not Start
        // or a Change writer. Personal observation shares still cannot wake.
        await runtime.resumeForSource(attempt.id, userID);
      } else {
        await database.client.begin((sql) => workspaceWriteAuthorityIn(sql, workspaceID, userID));
        signal?.throwIfAborted();
        if (access.changeID) await runtime.startPersisted(access.changeID, userID);
        else await runtime.start(access.projectID, userID, workspaceID);
      }
    }
    signal?.throwIfAborted();
    const deadline = Date.now() + nativeLifecycleWindowMS;
    for (;;) {
      signal?.throwIfAborted();
      if (closing())
        throw new CommandError("unavailable", "Factory is stopping. No operation was dispatched.");
      const [current] = await database.db
        .select({ id: runtimeAttempt.id, state: runtimeAttempt.state })
        .from(runtimeAttempt)
        .where(eq(runtimeAttempt.workspaceId, workspaceID))
        .orderBy(desc(runtimeAttempt.generation))
        .limit(1);
      if (current?.id !== attempt.id)
        throw new CommandError("conflict", "Workspace compute changed during preparation");
      // Connector hello can precede its persisted readiness update. Retain the
      // ordinary ready fast path, but never release a waking Save before both.
      if (
        sourceOnly
          ? ["starting", "ready"].includes(current.state) && hub.sourceConnected(attempt.id)
          : current.state === "ready" && hub.ready(attempt.id)
      )
        break;
      const observed = await runtime.get(attempt.id);
      signal?.throwIfAborted();
      if (observed?.state === "starting" && observed.native?.state === "ACTOR_STATE_SUSPENDED")
        throw new CommandError(
          "unavailable",
          "Compute startup is unconfirmed. No operation was dispatched; observe the existing startup before retrying.",
        );
      if (
        !observed ||
        !["create-intended", "starting", "ready", "paused", "resuming"].includes(observed.state)
      )
        throw new CommandError(
          "conflict",
          "Compute is unavailable. Observe its recorded outcome before retrying.",
        );
      if (Date.now() >= deadline)
        throw new CommandError(
          "unavailable",
          "Compute preparation is not confirmed. No operation was dispatched.",
        );
      await Bun.sleep(100);
    }
    await authorize();
    signal?.throwIfAborted();
    return attempt.id;
  };
}
