import type { SystemContract } from "../../../../packages/system-contract/src/system-contract";
import { appRuntimeOrigin } from "../runtime-origins";

export function runtimePublicFactoryOrigin(value: string | undefined) {
  if (value === undefined) return null;
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== value)
    throw new Error("Runtime App publication requires an exact HTTP(S) Factory origin");
  return value;
}

export function runtimeAppOrigins(
  publicFactoryOrigin: string | null,
  attemptID: string,
  contract: SystemContract,
): Record<string, string> | undefined {
  if (!publicFactoryOrigin) return undefined;
  runtimePublicFactoryOrigin(publicFactoryOrigin);
  return Object.fromEntries(
    contract.apps.map((app) => [
      String(app.port),
      appRuntimeOrigin(
        publicFactoryOrigin,
        attemptID,
        app.id === contract.primaryApp ? "app" : `app-${app.id}`,
      ),
    ]),
  );
}
