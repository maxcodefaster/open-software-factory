import { factoryRequestURL } from "../request-origin";
import {
  type ConnectorMessage,
  MAX_APP_AUTHORIZATION_BYTES,
  MAX_BROWSER_APP_HEADER_BYTES,
  MAX_BROWSER_APP_HEADERS,
  MAX_RESPONSE_COOKIE_BYTES,
  MAX_RESPONSE_COOKIES,
} from "./hub-types";

export function browserAppRequestHeaders(input: Headers) {
  const connection = new Set(
    input
      .get("connection")
      ?.split(",")
      .map((name) => name.trim().toLowerCase()),
  );
  const headers: Record<string, string> = {};
  let appAuthorization: string | undefined;
  let count = 0;
  let bytes = 0;
  for (const [name, value] of input) {
    if (
      connection.has(name) ||
      /^(?:host|content-length|connection|keep-alive|te|trailer|transfer-encoding|upgrade|forwarded|via|x-real-ip)$/.test(
        name,
      ) ||
      /^(?:proxy-|x-forwarded-|x-factory-|ate-|sec-websocket-|x-original-|x-rewrite-)/.test(name)
    )
      continue;
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (
      ++count > MAX_BROWSER_APP_HEADERS ||
      bytes > MAX_BROWSER_APP_HEADER_BYTES ||
      /[^\t\x20-\x7e\x80-\xff]/.test(value)
    )
      throw new Error("Invalid Browser App request headers");
    if (name === "authorization") {
      if (
        Buffer.byteLength(value) > MAX_APP_AUTHORIZATION_BYTES ||
        /[^\x20-\x7e\x80-\xff]/.test(value)
      )
        throw new Error("Invalid Browser App authorization");
      appAuthorization = value;
    } else headers[name] = value;
  }
  return { headers, ...(appAuthorization ? { appAuthorization } : {}) };
}

export function runtimeResponseHeaders(message: ConnectorMessage) {
  const headers = new Headers(message.headers);
  if (message.cookies === undefined) return headers;
  if (!Array.isArray(message.cookies) || message.cookies.length > MAX_RESPONSE_COOKIES)
    throw new Error("Invalid runtime response cookies");
  headers.delete("set-cookie");
  let bytes = 0;
  for (const cookie of message.cookies) {
    if (
      typeof cookie !== "string" ||
      !cookie ||
      cookie.length > MAX_RESPONSE_COOKIE_BYTES ||
      /[^\t\x20-\x7e\x80-\xff]/.test(cookie)
    )
      throw new Error("Invalid runtime response cookies");
    bytes += Buffer.byteLength(cookie);
    if (bytes > MAX_RESPONSE_COOKIE_BYTES) throw new Error("Invalid runtime response cookies");
    headers.append("set-cookie", cookie);
  }
  return headers;
}

export function isAppProcessName(value: string | undefined): value is string {
  return value === "app" || /^app-[a-z][a-z0-9-]{0,26}$/.test(value ?? "");
}

export function safeRuntimeHeaders(headers: Headers) {
  const result: Record<string, string> = {};
  for (const [name, value] of headers) {
    switch (name.toLowerCase()) {
      case "authorization":
      case "cookie":
      case "connection":
      case "host":
      case "origin":
      case "proxy-authorization":
      case "sec-websocket-key":
      case "sec-websocket-version":
      case "sec-websocket-protocol":
      case "sec-websocket-extensions":
      case "upgrade":
      case "x-forwarded-host":
      case "x-forwarded-proto":
      case "x-forwarded-prefix":
      case "forwarded":
        break;
      default:
        result[name] = value;
    }
  }
  return result;
}

export function appRuntimeHeaders(request: Request, path: string, originScoped = false) {
  const headers = safeRuntimeHeaders(request.headers);
  const url = factoryRequestURL(request, process.env["FACTORY_BASE_URL"]);
  const prefix = url.pathname.slice(0, url.pathname.length - new URL(path, url).pathname.length);
  // Internal health/browser-tool requests deliberately have no browser proxy
  // context. They never receive cookies or caller-supplied forwarding headers.
  if (!url.pathname.startsWith("/runtime/")) return headers;
  if (!/^\/runtime\/[a-f0-9-]{36}\/(app|preview\/app(?:-[a-z][a-z0-9-]{0,26})?)$/.test(prefix))
    throw new Error("App runtime path is not scoped");
  headers["x-forwarded-host"] = url.host;
  headers["x-forwarded-proto"] = url.protocol.slice(0, -1);
  // Origin-scoped routing uses this mount internally, not as the App's public base.
  headers["x-forwarded-prefix"] = originScoped ? "" : prefix;
  if (request.headers.get("origin") === url.origin) headers["origin"] = url.origin;
  const cookies = request.headers
    .get("cookie")
    ?.split(";")
    .map((value) => value.trim())
    .filter((value) => {
      const name = value.slice(0, value.indexOf("="));
      return (
        /^[A-Za-z0-9._~-]+$/.test(name) &&
        !/^(?:__Host-|__Secure-)?(?:factory[._-]|better-auth[._-]|theia-connection-token)/i.test(
          name,
        )
      );
    });
  if (cookies?.length) headers["cookie"] = cookies.join("; ");
  return headers;
}

export function appRuntimeSocketContext(request: Request, path: string, originScoped = false) {
  const protocol = request.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim();
  return {
    headers: appRuntimeHeaders(request, path, originScoped),
    ...(protocol && /^[!#$%&'*+.^_`|~A-Za-z0-9-]{1,128}$/.test(protocol) ? { protocol } : {}),
  };
}

export function theiaConnectionToken(headers: Headers) {
  const cookie = headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("theia-connection-token="));
  const token = cookie?.slice("theia-connection-token=".length);
  return token && token.length <= 256 && /^[A-Za-z0-9._~-]+$/.test(token) ? token : undefined;
}

// An untrusted App cannot set Factory/IDE credentials or cookies for other
// runtime paths. Preserve values/expiry, but bind browser state to its runtime
// path and top-level site so sessions also work in Factory's cross-site iframe.
export function scopeAppCookies(response: Response, path: string, originScoped = false) {
  if (!/^\/runtime\/[a-f0-9-]{36}\/(app|preview\/app(?:-[a-z][a-z0-9-]{0,26})?)$/.test(path))
    throw new Error("App cookie path is not scoped");
  const headers = new Headers(response.headers);
  const cookies = headers
    .getSetCookie()
    .flatMap((value) => value.split(/,(?=\s*[A-Za-z0-9._~-]+=)/));
  headers.delete("set-cookie");
  for (const cookie of cookies) {
    const [pair, ...attributes] = cookie.split(";").map((value) => value.trim());
    if (!pair) continue;
    const name = pair.slice(0, pair.indexOf("="));
    if (
      !/^[A-Za-z0-9._~-]+$/.test(name) ||
      /^(?:__Host-|(?:__Secure-)?(?:factory[._-]|better-auth[._-]|theia-connection-token))/i.test(
        name,
      )
    )
      continue;
    const safe = attributes.filter(
      (value) => !/^(?:domain|path|samesite|secure|partitioned)(?:\s*=|$)/i.test(value),
    );
    headers.append(
      "set-cookie",
      [
        pair,
        ...safe,
        `Path=${originScoped ? "/" : path}`,
        "SameSite=None",
        "Secure",
        "Partitioned",
      ].join("; "),
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function scopeTheiaConnectionCookie(response: Response, runtimePath: string) {
  const setCookie = response.headers.get("set-cookie");
  const token = setCookie?.match(/(?:^|,\s*)theia-connection-token=([^;]+)/)?.[1];
  if (!token || !/^[A-Za-z0-9._~-]{1,256}$/.test(token)) return response;
  const headers = new Headers(response.headers);
  headers.set(
    "set-cookie",
    `theia-connection-token=${token}; Path=${runtimePath}; HttpOnly; SameSite=None; Secure; Partitioned`,
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function isCheckpointTraffic(channel: string, request: Request, path: string): boolean {
  return (
    channel === "source" &&
    request.method === "POST" &&
    new URL(request.url).origin === "http://source.internal" &&
    /^\/v1\/workspaces\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/(?:checkpoint|chunk)$/.test(
      path,
    )
  );
}

export function validateBrowserAppSocketPath(path: string): void {
  const target = new URL(path, "http://browser.internal");
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.length > 16 << 10 ||
    /[\r\n\0\\]/.test(path) ||
    target.origin !== "http://browser.internal" ||
    target.hash
  )
    throw new Error("Browser App WebSocket path is invalid");
}

export function parseBrowserAppSocketProtocol(headers: Headers): string {
  const protocols = headers.get("sec-websocket-protocol")?.split(",") ?? [];
  if (
    protocols.length > 16 ||
    protocols.some((value) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(value.trim()))
  )
    throw new Error("Browser App WebSocket protocol is invalid");
  return protocols[0]?.trim() ?? "";
}
