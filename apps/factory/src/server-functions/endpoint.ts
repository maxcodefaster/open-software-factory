import { z } from "zod";
import { SystemContractError } from "../../../../packages/system-contract/src/system-contract";
import { CommandError } from "../command-error";
import { json } from "../http";
import type { FactoryFunctionContext, FactoryServices } from "./context";
import type { ServerResult } from "./result";

async function run<T>(execute: () => Promise<T>): Promise<ServerResult<T>> {
  try {
    return { ok: true, value: await execute() };
  } catch (cause) {
    if (cause instanceof CommandError)
      return { ok: false, status: cause.status, message: cause.message };
    if (cause instanceof z.ZodError)
      return { ok: false, status: 400, message: "Invalid command. Check the entered values." };
    if (cause instanceof SystemContractError)
      return { ok: false, status: 422, message: cause.message };
    console.error("Factory server function failed");
    return {
      ok: false,
      status: 500,
      message: "Factory command failed. Its outcome is unconfirmed.",
    };
  }
}

type FunctionHandler = (
  request: Request,
  options: {
    context: { factory: FactoryFunctionContext };
  },
) => Promise<Response>;

export function createServerFunctionEndpoint(dependencies: {
  origin: string;
  session(request: Request): Promise<{ user: { id: string } } | null>;
  services: FactoryServices;
  maintenance(): Promise<boolean>;
  requireFresh(request: Request): Promise<unknown>;
  publicFunctionIDs?: ReadonlySet<string>;
  functionIDs?: ReadonlySet<string>;
  handle: FunctionHandler;
}) {
  return async (request: Request) => {
    if (request.method !== "POST")
      return json({ error: "Method not allowed" }, 405, { "cache-control": "no-store" });
    // Restore the configured public origin after TLS termination. Never trust forwarded headers.
    const origin = request.headers.get("origin");
    if (origin !== dependencies.origin || request.headers.get("sec-fetch-site") === "none")
      return json({ error: "Factory command origin is invalid" }, 403, {
        "cache-control": "no-store",
      });
    const target = new URL(request.url);
    const publicRead = [...(dependencies.publicFunctionIDs ?? [])].some(
      (id) => target.pathname === `/_server/data/${id}`,
    );
    const session = await dependencies.session(request);
    if (!session && !publicRead)
      return json({ error: "Authentication required" }, 401, { "cache-control": "no-store" });
    const id = target.pathname.split("/").at(-1) ?? "";
    if (dependencies.functionIDs && !dependencies.functionIDs.has(id))
      return json({ error: "Factory was updated. Reload before continuing." }, 404, {
        "cache-control": "no-store",
        "x-server-function-unknown": "true",
      });
    const factory: FactoryFunctionContext = {
      ...dependencies.services,
      get actorID() {
        if (!session) throw new CommandError("forbidden", "Authentication required");
        return session.user.id;
      },
      readBootstrap: () => dependencies.services.bootstrap.get(session),
      signal: request.signal,
      async assertSession() {
        const current = await dependencies.session(request);
        if (!session || !current || current.user.id !== session.user.id)
          throw new CommandError("forbidden", "Session access ended");
      },
      run,
      async isFresh() {
        try {
          await dependencies.requireFresh(request);
          return true;
        } catch {
          return false;
        }
      },
      async beforeWrite(fresh) {
        if (!session) throw new CommandError("forbidden", "Authentication required");
        if (await dependencies.maintenance())
          throw new CommandError(
            "unavailable",
            "Factory is being updated. Your saved work is retained. Try again after maintenance.",
          );
        if (fresh) {
          try {
            await dependencies.requireFresh(request);
          } catch {
            throw new CommandError("forbidden", "Sign in again before changing protected settings");
          }
        }
      },
    };
    const canonical = new URL(`${target.pathname}${target.search}`, dependencies.origin);
    const canonicalRequest = new Request(canonical, request);
    // TLS termination can leave Fetch Metadata describing the proxy hop.
    // Only the exact public Origin accepted above may use the canonical host.
    canonicalRequest.headers.set("sec-fetch-site", "same-origin");
    const response = await dependencies.handle(canonicalRequest, {
      context: { factory },
    });
    // Native function bodies can carry long-lived typed streams even though
    // their content type is not SSE. Do not buffer or transform that wire.
    response.headers.set("cache-control", "no-store, no-transform");
    response.headers.set("x-accel-buffering", "no");
    return response;
  };
}
