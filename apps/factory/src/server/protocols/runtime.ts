import { runtimeWriteAuthorityIn } from "../../access/change-writer";
import { CommandError } from "../../command-error";
import { json } from "../../http";
import { factoryRequestURL } from "../../request-origin";
import { runtimeDocumentRequest } from "../../runtime/demand";
import {
  previewBridgeResponse,
  previewRendererResponse,
  scopeRuntimeEmbedding,
} from "../../runtime/embedding";
import { scopeTheiaConnectionCookie } from "../../runtime/hub";
import { previewAttachmentFailure } from "../../runtime/preview-attachment-failure";
import { runtimeAppOriginRoute } from "../../runtime-origins";
import type { FactoryApplication } from "../application";

import { protocolFailure } from "./failure";

type RuntimeServices = Pick<
  FactoryApplication,
  | "database"
  | "demandRuntime"
  | "factoryOrigin"
  | "runtimeAccess"
  | "runtimeController"
  | "runtimeHub"
  | "runtimeReady"
  | "sameRuntimeOrigin"
>;
export function createRuntimeProtocol(services: RuntimeServices) {
  const {
    database,
    demandRuntime,
    factoryOrigin,
    runtimeAccess,
    runtimeController,
    runtimeHub,
    runtimeReady,
    sameRuntimeOrigin,
  } = services;
  return async (request: Request): Promise<Response> => {
    try {
      const url = factoryRequestURL(request, factoryOrigin);
      const originApp = runtimeAppOriginRoute(factoryOrigin, url);
      const channelRequest = url.pathname.match(/^\/runtime\/([0-9a-f-]+)\/(app|ide)(\/.*)?$/);
      if (channelRequest) {
        const [, attemptID, channel, suffix] = channelRequest;
        if (!attemptID || (channel !== "app" && channel !== "ide"))
          return new Response("Not found", { status: 404 });
        const redeemed = await runtimeAccess.redeem(
          url,
          attemptID,
          channel,
          channel === "app" && originApp?.attemptID === attemptID && originApp.channel === "app"
            ? "/"
            : `/runtime/${attemptID}/${channel}/`,
        );
        if (redeemed) return redeemed;
        const accessToken = await runtimeAccess.authorize(request, attemptID, channel);
        if (!accessToken) {
          return json({ error: "Runtime access required" }, 401);
        }
        if (channel === "app" && suffix === "/__factory/activity" && request.method === "POST") {
          if (!sameRuntimeOrigin(request)) return json({ error: "Runtime origin is invalid" }, 403);
          return (await demandRuntime(attemptID, await runtimeAccess.user(accessToken)))
            ? new Response(null, { status: 204 })
            : json({ error: "Runtime is not ready" }, 409);
        }
        if (channel === "app" && runtimeDocumentRequest(request))
          await demandRuntime(attemptID, await runtimeAccess.user(accessToken));
        if (!(await runtimeReady(attemptID))) return json({ error: "Runtime is not ready" }, 409);
        if (channel === "ide" && suffix === "/__factory/processes") {
          return json(await runtimeController.processOutput(attemptID));
        }
        if (
          channel === "app" &&
          suffix === "/__factory/review-bridge.js" &&
          request.method === "GET"
        )
          return previewBridgeResponse(factoryOrigin);
        if (
          channel === "app" &&
          suffix === "/__factory/review-renderer.js" &&
          request.method === "GET"
        )
          return previewRendererResponse();
        const processAction =
          channel === "ide"
            ? suffix?.match(
                /^\/__factory\/processes\/(app(?:-[a-z][a-z0-9-]{0,26})?)\/(start|stop|restart)$/,
              )
            : undefined;
        if (processAction && request.method === "POST") {
          if (!sameRuntimeOrigin(request)) return json({ error: "Runtime origin is invalid" }, 403);
          const process = processAction[1];
          const action = processAction[2] as "start" | "stop" | "restart";
          if (!process) return json({ error: "Declared App is required" }, 400);
          try {
            const userID = await runtimeAccess.user(accessToken);
            return database.client.begin(async (sql) => {
              await runtimeWriteAuthorityIn(sql, attemptID, userID);
              return json(await runtimeController.processAction(attemptID, process, action));
            });
          } catch (cause) {
            return json(
              { error: cause instanceof Error ? cause.message : "Process action failed" },
              409,
            );
          }
        }
        const terminalClose =
          channel === "ide"
            ? suffix?.match(/^\/__factory\/terminals\/([a-zA-Z0-9_-]{1,64})$/)
            : undefined;
        if (terminalClose && request.method === "DELETE") {
          if (!sameRuntimeOrigin(request)) return json({ error: "Runtime origin is invalid" }, 403);
          const terminalID = terminalClose[1];
          if (!terminalID) return json({ error: "Terminal session is required" }, 400);
          try {
            const userID = await runtimeAccess.user(accessToken);
            return database.client.begin(async (sql) => {
              await runtimeWriteAuthorityIn(sql, attemptID, userID);
              return json(await runtimeController.closeTerminal(attemptID, terminalID));
            });
          } catch (cause) {
            return json(
              { error: cause instanceof Error ? cause.message : "Terminal close failed" },
              409,
            );
          }
        }
        const path = `${suffix || "/"}${url.search}`;
        const response = await runtimeHub.request(
          attemptID,
          channel,
          request,
          path,
          async (send) => {
            if (!runtimeAccess.has(accessToken))
              throw new CommandError("forbidden", "Runtime access revoked");
            send();
          },
          accessToken,
          channel === "app" && originApp?.attemptID === attemptID && originApp.channel === "app",
        );
        return channel === "ide"
          ? scopeTheiaConnectionCookie(response, `/runtime/${attemptID}/ide/`)
          : scopeRuntimeEmbedding(
              response,
              factoryOrigin,
              `/runtime/${attemptID}/app/__factory/review-bridge.js`,
            );
      }
      const appPreviewRequest = url.pathname.match(
        /^\/runtime\/([0-9a-f-]+)\/preview\/(app(?:-[a-z][a-z0-9-]{0,26})?)(\/.*)?$/,
      );
      if (appPreviewRequest) {
        const [, attemptID, appChannel, suffix] = appPreviewRequest;
        if (!attemptID || !appChannel) return new Response("Not found", { status: 404 });
        const redeemed = await runtimeAccess.redeem(
          url,
          attemptID,
          "app",
          originApp?.attemptID === attemptID && originApp.channel === appChannel
            ? "/"
            : `/runtime/${attemptID}/preview/${appChannel}/`,
          appChannel,
        );
        if (redeemed) return redeemed;
        const accessToken = await runtimeAccess.authorize(request, attemptID, "app", appChannel);
        if (!accessToken) {
          return json({ error: "Runtime access required" }, 401);
        }
        if (suffix === "/__factory/activity" && request.method === "POST") {
          if (!sameRuntimeOrigin(request)) return json({ error: "Runtime origin is invalid" }, 403);
          return (await demandRuntime(attemptID, await runtimeAccess.user(accessToken)))
            ? new Response(null, { status: 204 })
            : json({ error: "Runtime is not ready" }, 409);
        }
        if (runtimeDocumentRequest(request))
          await demandRuntime(attemptID, await runtimeAccess.user(accessToken));
        if (!(await runtimeReady(attemptID))) return json({ error: "Runtime is not ready" }, 409);
        if (!runtimeHub.hasAppChannel(attemptID, appChannel)) {
          return json({ error: "Declared App is not available" }, 404);
        }
        if (suffix === "/__factory/review-bridge.js" && request.method === "GET")
          return previewBridgeResponse(factoryOrigin);
        if (suffix === "/__factory/review-renderer.js" && request.method === "GET")
          return previewRendererResponse();
        const response = await runtimeHub.request(
          attemptID,
          appChannel,
          request,
          `${suffix || "/"}${url.search}`,
          async (send) => {
            if (!runtimeAccess.has(accessToken))
              throw new CommandError("forbidden", "Runtime access revoked");
            send();
          },
          accessToken,
          originApp?.attemptID === attemptID && originApp.channel === appChannel,
        );
        return scopeRuntimeEmbedding(
          response,
          factoryOrigin,
          `/runtime/${attemptID}/preview/${appChannel}/__factory/review-bridge.js`,
        );
      }
      return new Response("Not found", { status: 404 });
    } catch (cause) {
      return previewAttachmentFailure(request, factoryOrigin, protocolFailure(request, cause));
    }
  };
}
