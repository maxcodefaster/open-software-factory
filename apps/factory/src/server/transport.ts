import type { ServerWebSocket } from "bun";
import { hashConnectorToken } from "../../../../packages/runtime-domain/src/identity";
import { runtimeWriteAuthorityIn } from "../access/change-writer";
import { CommandError } from "../command-error";
import { json } from "../http";
import { serveFactory } from "../http-listener";
import { factoryRequestURL } from "../request-origin";
import { createRuntimeWriterBoundary } from "../runtime/browser-writer";
import {
  appRuntimeSocketContext,
  RuntimeHub,
  type RuntimeSocketData,
  theiaConnectionToken,
} from "../runtime/hub";
import { runtimeAppRequest } from "../runtime-app-request";
import type { DeveloperEditorSocketData } from "../workspace/developer-ide-edge";
import type { FactoryApplication } from "./application";
import { createFactoryProtocols, type FactoryProtocolServices } from "./protocols";

type FactoryTransportServices = FactoryProtocolServices &
  Pick<
    FactoryApplication,
    "factoryHost" | "startFetch" | "staticAssets" | "serverFunctionEndpoint"
  >;

export function startFactoryTransport(application: FactoryTransportServices) {
  const {
    database,
    developerIDEEdge,
    factoryHost,
    factoryOrigin,
    runtimeAccess,
    runtimeHub,
    runtimeReady,
  } = application;
  const protocols = createFactoryProtocols(application);
  const { FACTORY_PORT } = process.env;
  type FactorySocketData = RuntimeSocketData | DeveloperEditorSocketData;
  const runtimeWriter = createRuntimeWriterBoundary(runtimeHub, async (data, send) => {
    if (data.kind !== "browser" || !data.accessToken)
      throw new Error("Interactive identity is required");
    const accessToken = data.accessToken;
    const userID = await runtimeAccess.user(accessToken);
    await database.client.begin(async (sql) => {
      await runtimeWriteAuthorityIn(sql, data.attemptID, userID);
      if (!runtimeAccess.has(accessToken)) throw new Error("Interactive access revoked");
      send();
    });
  });
  const servers = serveFactory<FactorySocketData>(factoryHost, {
    port: Number(FACTORY_PORT ?? 3000),
    idleTimeout: 180,
    async fetch(request, server) {
      const connectionRequest = request;
      request = runtimeAppRequest(request, factoryOrigin);
      const url = factoryRequestURL(request, factoryOrigin);
      if (/^\/internal\/build-browser\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(url.pathname))
        // Cold image preparation has its own 180-second bound, followed by the
        // bounded container and cold Chrome setup. Do not time out transport first.
        server.timeout(request, 270);
      if (
        developerIDEEdge.matches(url.pathname) &&
        request.headers.get("upgrade")?.toLowerCase() === "websocket"
      ) {
        try {
          const data = url.pathname.includes("/__factory/")
            ? await developerIDEEdge.executionSocketData(request)
            : await developerIDEEdge.socketData(request);
          if (data instanceof Response) return data;
          if (!server.upgrade(connectionRequest, { data }))
            return json({ error: "Editor connection failed" }, 500);
          return undefined;
        } catch (cause) {
          if (cause instanceof CommandError) return json({ error: cause.message }, cause.status);
          return json({ error: "Editor connection unavailable" }, 503);
        }
      }
      if (url.pathname === "/internal/runtime-connect") {
        const data = runtimeHub.authorize(request, hashConnectorToken);
        if (!data) return new Response("Unauthorized", { status: 401 });
        if (
          !server.upgrade(connectionRequest, {
            data,
            headers: { "sec-websocket-protocol": RuntimeHub.protocol() },
          })
        ) {
          return new Response("Upgrade failed", { status: 500 });
        }
        return undefined;
      }
      const factoryTerminalSocket = url.pathname.match(
        /^\/runtime\/([0-9a-f-]+)\/ide\/__factory\/terminal\/([a-zA-Z0-9_-]{1,64})$/,
      );
      if (factoryTerminalSocket && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const attemptID = factoryTerminalSocket[1];
        const terminalID = factoryTerminalSocket[2];
        const accessToken = attemptID
          ? await runtimeAccess.authorize(request, attemptID, "ide")
          : undefined;
        if (!attemptID || !accessToken) {
          return new Response("Runtime access required", { status: 401 });
        }
        if (!(await runtimeReady(attemptID))) {
          return new Response("Runtime is not ready", { status: 409 });
        }
        if (
          !server.upgrade(connectionRequest, {
            data: {
              kind: "browser",
              attemptID,
              channel: "terminal",
              path: `/${terminalID}`,
              accessToken,
            },
          })
        ) {
          return new Response("Upgrade failed", { status: 500 });
        }
        return undefined;
      }
      const appPreviewSocket = url.pathname.match(
        /^\/runtime\/([0-9a-f-]+)\/preview\/(app(?:-[a-z][a-z0-9-]{0,26})?)(\/.*)?$/,
      );
      if (appPreviewSocket && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const [, attemptID, appChannel, suffix] = appPreviewSocket;
        const accessToken = attemptID
          ? await runtimeAccess.authorize(request, attemptID, "app", appChannel)
          : undefined;
        if (!attemptID || !appChannel || !accessToken) {
          return new Response("Runtime access required", { status: 401 });
        }
        if (!(await runtimeReady(attemptID))) {
          return new Response("Runtime is not ready", { status: 409 });
        }
        if (!runtimeHub.hasAppChannel(attemptID, appChannel)) {
          return new Response("Declared App is not available", { status: 404 });
        }
        const socketContext = appRuntimeSocketContext(request, `${suffix || "/"}${url.search}`);
        if (
          !server.upgrade(connectionRequest, {
            ...(socketContext.protocol
              ? { headers: { "sec-websocket-protocol": socketContext.protocol } }
              : {}),
            data: {
              kind: "browser",
              attemptID,
              channel: appChannel,
              path: `${suffix || "/"}${url.search}`,
              ...socketContext,
              accessToken,
            },
          })
        ) {
          return new Response("Upgrade failed", { status: 500 });
        }
        return undefined;
      }
      const channelSocket = url.pathname.match(/^\/runtime\/([0-9a-f-]+)\/(app|ide)(\/.*)?$/);
      if (channelSocket && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const [, attemptID, channel, suffix] = channelSocket;
        if (!attemptID || (channel !== "app" && channel !== "ide"))
          return new Response("Not found", { status: 404 });
        const accessToken = await runtimeAccess.authorize(request, attemptID, channel);
        if (!accessToken) return new Response("Runtime access required", { status: 401 });
        if (!(await runtimeReady(attemptID)))
          return new Response("Runtime is not ready", { status: 409 });
        const path = `${suffix || "/"}${url.search}`;
        const connectionToken =
          channel === "ide" ? theiaConnectionToken(request.headers) : undefined;
        const socketContext: { headers?: Record<string, string>; protocol?: string } =
          channel === "app" ? appRuntimeSocketContext(request, path) : {};
        if (
          !server.upgrade(connectionRequest, {
            ...(socketContext.protocol
              ? { headers: { "sec-websocket-protocol": socketContext.protocol } }
              : {}),
            data: {
              kind: "browser",
              attemptID,
              channel,
              path,
              accessToken,
              ...socketContext,
              ...(connectionToken ? { theiaConnectionToken: connectionToken } : {}),
            },
          })
        )
          return new Response("Upgrade failed", { status: 500 });
        return undefined;
      }
      if (url.pathname === "/_server" || url.pathname.startsWith("/_server/"))
        return application.serverFunctionEndpoint(request);
      if (/^\/(?:api|internal|runtime|editor|health|hooks)(?:\/|$)/.test(url.pathname))
        return application.startFetch(request, { context: { protocols } });
      return application.staticAssets(request);
    },
    websocket: {
      maxPayloadLength: 12 << 20,
      open(socket) {
        if (socket.data.kind === "developer-editor") {
          developerIDEEdge.open(socket as ServerWebSocket<DeveloperEditorSocketData>);
          return;
        }
        if (
          socket.data.kind === "browser" &&
          socket.data.accessToken &&
          !runtimeAccess.has(socket.data.accessToken)
        ) {
          socket.close(1008, "Runtime access revoked");
          return;
        }
        runtimeWriter.open(socket as ServerWebSocket<RuntimeSocketData>);
      },
      message(socket, message) {
        if (socket.data.kind === "developer-editor")
          developerIDEEdge.message(socket as ServerWebSocket<DeveloperEditorSocketData>, message);
        else runtimeWriter.message(socket as ServerWebSocket<RuntimeSocketData>, message);
      },
      close(socket) {
        if (socket.data.kind === "developer-editor")
          developerIDEEdge.close(socket as ServerWebSocket<DeveloperEditorSocketData>);
        else runtimeWriter.close(socket as ServerWebSocket<RuntimeSocketData>);
      },
    },
  });
  return servers;
}
