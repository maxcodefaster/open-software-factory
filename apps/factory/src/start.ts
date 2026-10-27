import { getRequestEvent } from "@solidjs/web";
import { createMiddleware, createStart } from "@tanstack/solid-start";
import type { FactoryProtocols } from "./server/protocols";
import type { FactoryFunctionContext } from "./server-functions/context";

declare module "@tanstack/solid-router" {
  interface Register {
    server: { requestContext: { factory?: FactoryFunctionContext; protocols?: FactoryProtocols } };
  }
}

const trustedHost = createMiddleware().server(async ({ context, next }) => {
  const host = context as
    | {
        factory?: FactoryFunctionContext;
        protocols?: FactoryProtocols;
      }
    | undefined;
  // This runs before parsing client function context. Publishing an explicit
  // null prevents a client from supplying a replacement when no host is bound.
  return next({ context: { factory: host?.factory ?? null, protocols: host?.protocols } });
});

const factoryRequest = createMiddleware({ type: "function" }).server(async ({ context, next }) => {
  // Authority comes from the existing host, never from serialized client context.
  const event = getRequestEvent();
  const factory = (context as { factory?: FactoryFunctionContext } | undefined)?.factory;
  if (!factory) throw new Response("Factory host unavailable", { status: 503 });
  if (event && factory) event.locals["factory"] = factory;
  return next();
});

export const startInstance = createStart(() => ({
  requestMiddleware: [trustedHost],
  functionMiddleware: [factoryRequest],
}));
