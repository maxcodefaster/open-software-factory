import { desc, eq } from "drizzle-orm";
import type { createDatabase } from "../../../../packages/db/src/client";
import { runtimeAttempt, runtimeComputeWait } from "../../../../packages/db/src/schema";
import { nativeLifecycleWindowMS } from "../../../../packages/runtime-domain/src/timing";
import { workspaceWriteAuthorityIn } from "../access/change-writer";
import { workspaceAuthorityIn } from "../access/workspace";
import { CommandError } from "../command-error";
import { type createRuntimeController } from "../runtime/api";
import { type RuntimeHub } from "../runtime/transport-api";

/** Demand resumes an existing Sandbox. It never replaces explicit Stop or a failed attempt. */
export function createWorkspaceComputeAccess(
  database: ReturnType<typeof createDatabase>,
  hub: Pick<RuntimeHub, "ready">,
  runtime: Pick<ReturnType<typeof createRuntimeController>, "start" | "startPersisted" | "get">,
  closing: () => boolean,
) {
  return async (workspaceID: string, userID: string, write = true, expectedAttemptID?: string) => {
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
        computeWait: runtimeComputeWait.reason,
      })
      .from(runtimeAttempt)
      .leftJoin(runtimeComputeWait, eq(runtimeComputeWait.attemptId, runtimeAttempt.id))
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
    if (
      attempt.state === "paused" ||
      attempt.state === "resuming" ||
      (attempt.state === "starting" && attempt.computeWait === "compute-capacity")
    ) {
      // Resume changes compute state and still needs current development writer authority.
      await database.client.begin((sql) => workspaceWriteAuthorityIn(sql, workspaceID, userID));
      if (access.changeID) await runtime.startPersisted(access.changeID, userID);
      else await runtime.start(access.projectID, userID, workspaceID);
    }
    const deadline = Date.now() + nativeLifecycleWindowMS;
    while (!hub.ready(attempt.id)) {
      if (closing())
        throw new CommandError("unavailable", "Factory is stopping. No operation was dispatched.");
      const observed = await runtime.get(attempt.id);
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
    const [current] = await database.db
      .select({ id: runtimeAttempt.id })
      .from(runtimeAttempt)
      .where(eq(runtimeAttempt.workspaceId, workspaceID))
      .orderBy(desc(runtimeAttempt.generation))
      .limit(1);
    if (current?.id !== attempt.id)
      throw new CommandError("conflict", "Workspace compute changed during preparation");
    await authorize();
    return attempt.id;
  };
}
