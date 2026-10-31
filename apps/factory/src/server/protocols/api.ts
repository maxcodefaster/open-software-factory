import { z } from "zod";
import { json, sameFactoryOrigin } from "../../http";
import { installationInMaintenance } from "../../installation/maintenance";
import { factoryRequestURL } from "../../request-origin";
import { appRuntimeOrigin } from "../../runtime-origins";
import { handleZeroMutate, handleZeroQuery } from "../../zero/http";
import type { FactoryApplication } from "../application";

import { protocolFailure } from "./failure";

type ApiServices = Pick<
  FactoryApplication,
  | "accessController"
  | "attachmentRoutes"
  | "database"
  | "demandRuntime"
  | "developerIDEEdge"
  | "factoryAuth"
  | "factoryOrigin"
  | "forgeIdentityRoutes"
  | "mcpOAuthCallback"
  | "requireSession"
  | "reviewMediaRoutes"
  | "runtimeAccess"
  | "runtimeHub"
  | "runtimeReady"
  | "runtimeController"
  | "sourceProtocol"
  | "wikiSourceUpdates"
>;
export function createApiProtocol(services: ApiServices) {
  const {
    accessController,
    attachmentRoutes,
    database,
    demandRuntime,
    developerIDEEdge,
    factoryAuth,
    factoryOrigin,
    forgeIdentityRoutes,
    mcpOAuthCallback,
    requireSession,
    reviewMediaRoutes,
    runtimeAccess,
    runtimeHub,
    runtimeReady,
    runtimeController,
    sourceProtocol,
    wikiSourceUpdates,
  } = services;
  return async (request: Request): Promise<Response> => {
    try {
      const url = factoryRequestURL(request, factoryOrigin);
      if (
        process.env["FACTORY_HELM_RELEASE"] &&
        !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
        new URL(request.url).pathname.startsWith("/api/") &&
        !new URL(request.url).pathname.startsWith("/api/auth/") &&
        new URL(request.url).pathname !== "/api/zero/query" &&
        (await installationInMaintenance(database))
      )
        return json(
          {
            error:
              "Factory is being updated. Your saved work is retained. Try again after maintenance.",
          },
          503,
          { "retry-after": "30" },
        );
      const sourceEvent = url.pathname.match(/^\/api\/wiki\/source-events\/([0-9a-f-]{36})$/);
      if (sourceEvent?.[1]) return await wikiSourceUpdates.receive(request, sourceEvent[1]);
      if (url.pathname === "/api/auth/.well-known/openid-configuration" && request.method === "GET")
        return json(await factoryAuth.discovery());
      if (url.pathname.startsWith("/api/auth/")) return factoryAuth.handler(request);
      if (url.pathname === "/api/zero/query" && request.method === "POST") {
        return handleZeroQuery(request, database, await requireSession(request));
      }
      if (url.pathname === "/api/zero/mutate" && request.method === "POST") {
        if (!sameFactoryOrigin(request))
          return json({ error: "Factory command origin is invalid" }, 403);
        return handleZeroMutate(request, database, await requireSession(request));
      }
      if (
        url.pathname.startsWith("/api/") &&
        request.method !== "GET" &&
        !sameFactoryOrigin(request)
      ) {
        return json({ error: "Factory command origin is invalid" }, 403);
      }
      if (url.pathname.startsWith("/api/attachments/")) {
        const session = await requireSession(request);
        if (!session) return json({ error: "Authentication required" }, 401);
        return (
          (await attachmentRoutes(request, session.user.id)) ?? new Response(null, { status: 404 })
        );
      }
      if (url.pathname.startsWith("/api/")) {
        const session = await requireSession(request);
        if (!session) return json({ error: "Authentication required" }, 401);
        await accessController.authorizeAPI(request, session.user.id);
        if (url.pathname === "/api/admin/worker/recover" && request.method === "POST") {
          const input = z.strictObject({ requestID: z.uuid() }).parse(await request.json());
          return json(
            await runtimeController.recoverWorker({
              actorID: session.user.id,
              requestID: input.requestID,
            }),
          );
        }
        const forgeIdentityResponse = await forgeIdentityRoutes(request, session.user.id);
        if (forgeIdentityResponse) return forgeIdentityResponse;
        const reviewMediaResponse = await reviewMediaRoutes(request, session.user.id);
        if (reviewMediaResponse) return reviewMediaResponse;
        const mcpResponse = await mcpOAuthCallback(request, session.user.id);
        if (mcpResponse) return mcpResponse;
        const sourceResponse = await sourceProtocol(request, session.user.id);
        if (sourceResponse) return sourceResponse;
      }
      if (url.pathname === "/api/developer-ide/access" && request.method === "GET") {
        const session = await requireSession(request);
        if (!session) return json({ error: "Authentication required" }, 401);
        const workspaceID = url.searchParams.get("workspace") ?? undefined;
        if (workspaceID && !/^[a-f0-9-]{36}$/.test(workspaceID))
          return json({ error: "Workspace identity is invalid" }, 400);
        return Response.redirect(
          await developerIDEEdge.issue(
            session.user.id,
            session.session.id,
            url.searchParams.get("embed") === "1",
            workspaceID,
          ),
          302,
        );
      }
      if (url.pathname === "/api/runtime-access" && request.method === "GET") {
        const session = await requireSession(request);
        if (!session) return json({ error: "Authentication required" }, 401);
        const path = url.searchParams.get("path");
        const parsed = path?.match(
          /^\/runtime\/([0-9a-f-]+)\/(app|ide|preview\/(app(?:-[a-z][a-z0-9-]{0,26})?))\//,
        );
        const attemptID = parsed?.[1];
        const route = parsed?.[2];
        const previewChannel = parsed?.[3];
        const channel = route === "ide" ? "ide" : "app";
        if (!path || !attemptID || !route) {
          return json({ error: "Runtime path is invalid" }, 400);
        }
        await accessController.requireRuntime(session.user.id, attemptID, channel);
        if (
          !(channel === "app"
            ? await demandRuntime(attemptID, session.user.id)
            : await runtimeReady(attemptID))
        )
          return json({ error: "Runtime is not ready" }, 409);
        if (previewChannel && !runtimeHub.hasAppChannel(attemptID, previewChannel)) {
          return json({ error: "Declared App is not available" }, 404);
        }
        const token = await runtimeAccess.issue({
          attemptID,
          channel,
          ...(channel === "app" ? { appChannel: previewChannel ?? "app" } : {}),
          userID: session.user.id,
          sessionID: session.session.id,
          expires: Date.now() + 8 * 60 * 60 * 1_000,
          mode: url.searchParams.get("embed") === "1" ? "embedded" : "top-level",
        });
        const destination = new URL(
          path,
          process.env["FACTORY_BASE_URL"] ?? "http://127.0.0.1:3000",
        );
        destination.host = new URL(
          appRuntimeOrigin(factoryOrigin, attemptID, previewChannel ?? channel),
        ).host;
        destination.searchParams.set("factory-grant", token);
        return Response.redirect(destination, 302);
      }
      return json({ error: "Not found" }, 404);
    } catch (cause) {
      return protocolFailure(request, cause);
    }
  };
}
