import type { createDatabase } from "../../../../packages/db/src/client";
import type { RuntimeHub } from "../runtime/hub";
import { createRecordedOpenCodeUsage } from "../usage/record-opencode";
import { createOpenCodeClient } from "./opencode-client";

export type CodingRuntimeShutdown = (attemptID: string) => Promise<void>;

// The existing input Stop owner confirms cancellation before native teardown
// reaches this callback. Terminal inputs can still have auxiliary consumption.
// Drain the original Attempt before Source handoff or channel revocation.
export function createCodingRuntimeShutdown(
  database: ReturnType<typeof createDatabase>,
  hub: RuntimeHub,
  usage: Pick<
    ReturnType<typeof createRecordedOpenCodeUsage>,
    "drainAttempt" | "markUnavailable"
  > = createRecordedOpenCodeUsage(database),
): CodingRuntimeShutdown {
  return async (attemptID) => {
    if (hub.connected(attemptID)) {
      try {
        const client = createOpenCodeClient((request, path) =>
          hub.request(attemptID, "agent", request, path),
        );
        await usage.drainAttempt(attemptID, client);
        return;
      } catch {
        // Missing or unreadable logs retain unknown coverage, never zero usage.
      }
    }
    await usage.markUnavailable(attemptID);
  };
}
