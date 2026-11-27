import type { createDatabase } from "#db/client";
import { createBuildBrowserController } from "../../apps/factory/src/agent/browser-controller";
import type { createSubstrateBrowsers } from "../../apps/factory/src/runtime/browser-api";
import type { RuntimeHub } from "../../apps/factory/src/runtime/transport-api";

// Product-controller tests use a controlled native owner. Reusing the existing
// recorded Hub peer here does not retain a Parent browser execution path in Factory.
export function createBuildBrowserFixture(
  database: ReturnType<typeof createDatabase>,
  hub: RuntimeHub,
  secret: string,
  media?: Parameters<typeof createBuildBrowserController>[3],
) {
  const native: Pick<
    ReturnType<typeof createSubstrateBrowsers>,
    "prepare" | "operation" | "close"
  > = {
    async prepare(_scope, authorize, signal) {
      signal?.throwIfAborted();
      await authorize(() => {});
    },
    operation(scope, operation, beforeSend) {
      return hub.parentOperation(scope.attemptID, operation, beforeSend);
    },
    async close(scope) {
      await hub.parentOperation(scope.attemptID, {
        operationId: crypto.randomUUID(),
        action: "browser-close",
        runtimeAttemptId: scope.attemptID,
        generation: scope.generation,
        data: JSON.stringify({
          sessionId: scope.id,
          turnId: scope.turnID,
          agentSessionId: scope.agentSessionID,
          ownerId: scope.ownerID,
          expiresAt: new Date(0).toISOString(),
          call: { name: "", arguments: {} },
        }),
      });
    },
  };
  return Object.assign(createBuildBrowserController(database, secret, native, media), { native });
}
