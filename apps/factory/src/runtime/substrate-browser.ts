import { createHmac } from "node:crypto";
import {
  connectSubstrateBrowser,
  type SubstrateBrowserOperation,
  SubstrateBrowserOperationError,
} from "#runtime-kubernetes/substrate-browser-client";
import { createSubstrateControl, type SubstrateCall } from "#runtime-kubernetes/substrate-control";
import { type RuntimeHub, RuntimeParentOperationError } from "./hub";
import { trackNativeOperation } from "./native-lock";
import {
  type BrowserConnection,
  closeBrowserResources,
  prepareBrowserConnection,
} from "./substrate-browser-lifecycle";
import {
  type BrowserDatabase,
  type BrowserExecutionAuthority,
  type BrowserExecutionScope,
  type BrowserInstallation,
  configuredSubstrateBrowser,
  type NativeResourceState,
  sameBrowserScope,
} from "./substrate-browser-state";
import type { SubstrateInstallationConfiguration } from "./substrate-workspaces";

export {
  type BrowserExecutionAuthority,
  type BrowserExecutionScope,
  configuredSubstrateBrowser,
  type NativeResourceState,
};

// Two concrete native resources in the existing Attempt's Atespace. No private
// Docker, global Owner credential, WorkerPool provisioning or lifecycle loop.
export function createSubstrateBrowsers(
  database: BrowserDatabase,
  hub: RuntimeHub,
  secret: string,
  installation: SubstrateInstallationConfiguration,
  options: {
    browser?: BrowserInstallation;
    call?: SubstrateCall;
    connect?: typeof connectSubstrateBrowser;
  } = {},
) {
  const connections = new Map<string, BrowserConnection>();
  const call = options.call ?? createSubstrateControl(installation.connection);
  const connect = options.connect ?? connectSubstrateBrowser;
  const token = (id: string) =>
    createHmac("sha256", secret).update(`factory-native-browser-v1:${id}`).digest("hex");
  const deps = {
    database,
    hub,
    installation,
    browser: options.browser,
    call,
    connect,
    token,
  };

  async function locked<T>(id: string, work: () => Promise<T>) {
    return trackNativeOperation(
      (async () => {
        const sql = database.coordination();
        try {
          await sql`SELECT pg_advisory_lock(hashtextextended(${`native-browser:${id}`},0))`;
          const [current] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
          if (current?.name !== installation.database)
            throw new Error("Native Browser database differs from its installation");
          return await work();
        } finally {
          try {
            await sql`SELECT pg_advisory_unlock(hashtextextended(${`native-browser:${id}`},0))`;
          } finally {
            await sql.end({ timeout: 1 });
          }
        }
      })(),
    );
  }

  return {
    async prepare(
      scope: BrowserExecutionScope,
      authorize: BrowserExecutionAuthority,
      signal?: AbortSignal,
    ) {
      return locked(scope.id, () =>
        prepareBrowserConnection(deps, connections, scope, authorize, signal),
      );
    },
    async operation(
      scope: BrowserExecutionScope,
      operation: SubstrateBrowserOperation,
      beforeSend: (send: () => void) => Promise<void>,
    ) {
      const live = connections.get(scope.id);
      if (!live) {
        if (operation.action === "browser-renew") return {};
        throw new RuntimeParentOperationError(
          operation.action,
          "browser session requires owned cleanup after parent restart; do not replay a UI mutation",
        );
      }
      if (!sameBrowserScope(live.scope, scope))
        throw new Error("Native Browser operation changed owner");
      try {
        return await live.client.operation(operation, beforeSend);
      } catch (cause) {
        if (cause instanceof SubstrateBrowserOperationError)
          throw new RuntimeParentOperationError(cause.action, cause.message);
        throw cause;
      }
    },
    async close(scope: BrowserExecutionScope) {
      const connection = connections.get(scope.id);
      connection?.client.close();
      connections.delete(scope.id);
      return locked(scope.id, () => closeBrowserResources(deps, scope));
    },
  };
}
