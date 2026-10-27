import { configureServerFunctionsClient } from "@solidjs/web/server-functions/client";

// Start RC forwards AbortSignal but not its custom-fetch option to Solid's
// invocation channel. Use the native request hook for draft retention instead.
// Start still owns identities, serialization and dispatch; no request is replayed.
export function configureFactoryFunctionClient(retainDraft: unknown) {
  const id = (retainDraft as { serverFnMeta?: { id?: unknown } }).serverFnMeta?.id;
  if (typeof id !== "string" || !id)
    throw new Error("Compiled draft-retention function identity is missing");
  configureServerFunctionsClient({
    prepareRequest: (init, context) => (context.id === id ? { ...init, keepalive: true } : init),
  });
}
