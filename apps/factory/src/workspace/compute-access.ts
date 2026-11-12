import type { createDatabase } from "../../../../packages/db/src/client";
import { nativeLifecycleWindowMS } from "../../../../packages/runtime-domain/src/timing";
import { workspaceWriteAuthorityIn } from "../access/change-writer";
import { workspaceAuthorityIn } from "../access/workspace";
import { CommandError } from "../command-error";
import type { createRuntimeController } from "../runtime/controller";
import type { RuntimeHub } from "../runtime/hub";

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
    const [attempt] = await database.client<{ id: string; state: string }[]>`SELECT id,state
      FROM factory.runtime_attempt WHERE workspace_id=${workspaceID} ORDER BY generation DESC LIMIT 1`;
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
    if (attempt.state === "paused" || attempt.state === "resuming") {
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
    const [current] = await database.client<{ id: string }[]>`SELECT id FROM factory.runtime_attempt
      WHERE workspace_id=${workspaceID} ORDER BY generation DESC LIMIT 1`;
    if (current?.id !== attempt.id)
      throw new CommandError("conflict", "Workspace compute changed during preparation");
    await authorize();
    return attempt.id;
  };
}
