import { readFile } from "node:fs/promises";
import { z } from "zod";

const maximumFrameBytes = 4 << 20;
const protocol = "factory-native-browser-v1";
// The shared DOM lib hides Bun's server-side constructor overload and methods.
const NativeWebSocket = WebSocket as typeof WebSocket & {
  new (url: string | URL, options: Bun.WebSocketOptions): Bun.WebSocket;
};
const scopeInput = z.object({
  sessionId: z.uuid(),
  turnId: z.uuid(),
  agentSessionId: z.string().startsWith("ses").max(200),
  ownerId: z.string().regex(/^[a-f0-9]{64}$/),
});
const configurationInput = z.strictObject({
  routerURL: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "wss:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  }),
  caFile: z.string().startsWith("/"),
  credentialFile: z.string().startsWith("/"),
  atespace: z.string().regex(/^fa-[a-f0-9]{32}$/),
  actorName: z.string(),
  actorUID: z.uuid(),
  runtimeAttemptId: z.uuid(),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  scope: scopeInput,
  token: z.string().regex(/^[a-f0-9]{64}$/),
  apps: z
    .array(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/))
    .min(1)
    .max(8),
});
const headersInput = z
  .record(z.string(), z.array(z.string().max(16 << 10)).max(128))
  .refine(
    (headers) =>
      Object.keys(headers).length <= 128 &&
      Buffer.byteLength(JSON.stringify(headers)) <= 64 << 10 &&
      Object.entries(headers).every(
        ([name, values]) =>
          /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) &&
          values.every((value) => !/[\r\n\0]/.test(value)),
      ),
  );
const frameInput = z.object({
  type: z.string(),
  id: z.uuid().optional(),
  actorUID: z.uuid().optional(),
  sessionID: z.uuid().optional(),
  operation: z
    .object({
      type: z.literal("operation-response"),
      operationId: z.uuid(),
      action: z.string(),
      data: z.string().optional(),
      error: z.string().max(1024).optional(),
    })
    .optional(),
  scope: scopeInput.optional(),
  app: z.string().optional(),
  method: z.string().optional(),
  path: z
    .string()
    .max(16 << 10)
    .optional(),
  headers: headersInput.optional(),
  data: z.string().optional(),
  messageType: z.union([z.literal(1), z.literal(2)]).optional(),
  protocol: z.string().max(128).optional(),
});

export type SubstrateBrowserConfiguration = z.infer<typeof configurationInput>;
export type SubstrateBrowserOperation = {
  operationId: string;
  action: string;
  runtimeAttemptId: string;
  generation: number;
  data: string;
};
export class SubstrateBrowserOperationError extends Error {
  constructor(
    readonly action: string,
    message: string,
  ) {
    super(message);
  }
}

export type SubstrateBrowserRelay = {
  requestApp(app: string, request: Request, path: string): Promise<Response>;
  openAppSocket(app: string, request: Request, path: string): Promise<SubstrateBrowserAppSocket>;
  inspect(app: string, signal: AbortSignal): Promise<unknown>;
};
export type SubstrateBrowserAppSocket = {
  protocol: string;
  messages: ReadableStream<{ messageType: 1 | 2; data: Uint8Array }>;
  send(messageType: 1 | 2, data: Uint8Array): Promise<void>;
  close(): void;
};

// Standard native Router ingress targets Actor port 80. Bun owns mTLS and
// WebSocket I/O; no forwarding daemon, subprocess, internal SDK or retry loop.
export async function connectSubstrateBrowser(
  input: SubstrateBrowserConfiguration,
  relay: SubstrateBrowserRelay,
  signal?: AbortSignal,
  beforeConnect: (connect: () => void) => Promise<void> = async (connect) => connect(),
) {
  const config = configurationInput.parse(input);
  if (config.actorName !== `browser-${config.scope.sessionId.replaceAll("-", "")}`)
    throw new Error("Native Browser name does not match its immutable Session");
  signal?.throwIfAborted();
  const [ca, credential] = await Promise.all([
    readFile(config.caFile),
    readFile(config.credentialFile),
  ]);
  const admission = new AbortController();
  const live = signal ? AbortSignal.any([signal, admission.signal]) : admission.signal;
  let pending: ReturnType<typeof openNativeBrowserSocket> | undefined;
  try {
    await beforeConnect(() => {
      live.throwIfAborted();
      if (pending) throw new Error("Native Browser connection was already dispatched");
      pending = openNativeBrowserSocket(config, relay, ca, credential, live);
      // Adopt failures before the SQL admission transaction can finish.
      void pending.catch(() => {});
    });
    if (!pending) throw new Error("Native Browser connection was not admitted");
    return await pending;
  } catch (cause) {
    admission.abort(cause);
    await pending?.catch(() => {});
    throw cause;
  }
}

async function openNativeBrowserSocket(
  config: SubstrateBrowserConfiguration,
  relay: SubstrateBrowserRelay,
  ca: Buffer,
  credential: Buffer,
  signal: AbortSignal,
) {
  const url = new URL("/internal/factory-browser", config.routerURL);
  const socket = new NativeWebSocket(url, {
    protocols: [protocol],
    perMessageDeflate: false,
    headers: {
      "ate-target-actor": `${config.atespace}/${config.actorName}`,
      Authorization: `Bearer ${config.token}`,
      "X-Factory-Actor-UID": config.actorUID,
      "X-Factory-Browser-Session": config.scope.sessionId,
    },
    tls: {
      ca,
      cert: credential,
      key: credential,
      rejectUnauthorized: true,
      serverName: "atenet-router.ate-system.svc",
    },
  });
  let confirmed = false,
    closed = false;
  const ready = Promise.withResolvers<void>();
  const pending = new Map<
    string,
    {
      action: string;
      resolve: (value: { data?: string }) => void;
      reject: (cause: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const active = new Map<string, AbortController>();
  const appSockets = new Map<
    string,
    {
      controller: AbortController;
      socket: SubstrateBrowserAppSocket;
      queued: number;
      bytes: number;
      sending: Promise<void>;
    }
  >();
  const seen = new Set<string>();
  const end = (reason = "Native Browser connection ended; do not replay unknown operations") => {
    if (closed) return;
    closed = true;
    clearTimeout(connectTimer);
    signal?.removeEventListener("abort", aborted);
    socket.terminate();
    ready.reject(new Error(reason));
    for (const controller of active.values()) controller.abort(reason);
    active.clear();
    appSockets.clear();
    for (const operation of pending.values()) {
      clearTimeout(operation.timer);
      operation.reject(new Error(reason));
    }
    pending.clear();
  };
  const aborted = () =>
    end("Native Browser request was cancelled; do not replay unknown operations");
  signal?.addEventListener("abort", aborted, { once: true });
  const connectTimer = setTimeout(() => end("Native Browser identity was not confirmed"), 25_000);
  const send = (frame: unknown) => {
    const encoded = JSON.stringify(frame);
    if (
      closed ||
      !confirmed ||
      socket.readyState !== WebSocket.OPEN ||
      Buffer.byteLength(encoded) > maximumFrameBytes ||
      socket.bufferedAmount + Buffer.byteLength(encoded) > maximumFrameBytes
    )
      throw new Error("Native Browser frame could not be sent");
    socket.send(encoded);
  };
  const sameScope = (value: z.infer<typeof scopeInput> | undefined) =>
    value &&
    Object.entries(config.scope).every(
      ([key, expected]) => value[key as keyof typeof value] === expected,
    );
  const appPath = (path: string | undefined) => {
    if (!path?.startsWith("/") || path.startsWith("//") || /[\r\n\0\\]/.test(path))
      throw new Error("Native Browser App path is invalid");
    const target = new URL(path, "http://browser.internal");
    if (target.origin !== "http://browser.internal" || target.hash)
      throw new Error("Native Browser App path is invalid");
    return target;
  };
  const socketData = (frame: z.infer<typeof frameInput>) => {
    const data = Buffer.from(frame.data ?? "", "base64");
    if (
      !frame.messageType ||
      data.length > 64 << 10 ||
      data.toString("base64") !== (frame.data ?? "")
    )
      throw new Error("Native Browser App WebSocket frame is invalid");
    return { messageType: frame.messageType, data };
  };
  async function forward(frame: z.infer<typeof frameInput>) {
    if (
      !frame.id ||
      !sameScope(frame.scope) ||
      !frame.app ||
      !config.apps.includes(frame.app) ||
      active.size >= 32 ||
      seen.has(frame.id) ||
      seen.size >= 16384
    )
      throw new Error("Native Browser relay scope is invalid");
    seen.add(frame.id);
    const controller = new AbortController();
    active.set(frame.id, controller);
    try {
      if (frame.type === "inspection-request") {
        const context = await relay.inspect(frame.app, controller.signal);
        controller.signal.throwIfAborted();
        send({ type: "inspection-context", id: frame.id, context });
        return;
      }
      if (frame.type === "app-socket-open") {
        if (!frame.path) throw new Error("Native Browser App path is invalid");
        const target = appPath(frame.path);
        const headers = new Headers();
        for (const [name, values] of Object.entries(frame.headers ?? {}))
          for (const value of values) headers.append(name, value);
        const upstream = await relay.openAppSocket(
          frame.app,
          new Request(target, { headers, signal: controller.signal }),
          frame.path,
        );
        const close = () => upstream.close();
        controller.signal.addEventListener("abort", close, { once: true });
        try {
          controller.signal.throwIfAborted();
          appSockets.set(frame.id, {
            controller,
            socket: upstream,
            queued: 0,
            bytes: 0,
            sending: Promise.resolve(),
          });
          send({ type: "app-socket-ready", id: frame.id, protocol: upstream.protocol });
          const reader = upstream.messages.getReader();
          const cancel = () => void reader.cancel().catch(() => {});
          controller.signal.addEventListener("abort", cancel, { once: true });
          let bytes = 0;
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              controller.signal.throwIfAborted();
              bytes += value.data.byteLength;
              if (
                ![1, 2].includes(value.messageType) ||
                value.data.byteLength > 64 << 10 ||
                bytes > 16 << 20
              )
                throw new Error("Native Browser App WebSocket output exceeds its bound");
              send({
                type: "app-socket-message",
                id: frame.id,
                messageType: value.messageType,
                data: Buffer.from(value.data).toString("base64"),
              });
            }
          } finally {
            controller.signal.removeEventListener("abort", cancel);
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
          controller.signal.throwIfAborted();
          send({ type: "app-socket-close", id: frame.id });
        } finally {
          appSockets.delete(frame.id);
          controller.signal.removeEventListener("abort", close);
          upstream.close();
        }
        return;
      }
      if (
        !frame.method ||
        !/^[A-Z]{1,32}$/.test(frame.method) ||
        ["CONNECT", "TRACE"].includes(frame.method) ||
        !frame.path?.startsWith("/") ||
        frame.path.startsWith("//") ||
        /[\r\n\0\\]/.test(frame.path) ||
        frame.headers?.["Upgrade"] ||
        frame.headers?.["upgrade"]
      )
        throw new Error("Native Browser App request is invalid");
      const target = appPath(frame.path);
      const bytes = Buffer.from(frame.data ?? "", "base64");
      if (bytes.length > 1 << 20 || bytes.toString("base64") !== (frame.data ?? ""))
        throw new Error("Native Browser App body exceeds its bound");
      const headers = new Headers();
      for (const [name, values] of Object.entries(frame.headers ?? {}))
        for (const value of values) headers.append(name, value);
      const request = new Request(target, {
        method: frame.method,
        headers,
        signal: controller.signal,
        ...(["GET", "HEAD"].includes(frame.method) ? {} : { body: bytes }),
      });
      const response = await relay.requestApp(frame.app, request, frame.path);
      controller.signal.throwIfAborted();
      const returned: Record<string, string[]> = {};
      for (const [name, value] of response.headers) {
        if (name !== "set-cookie") returned[name] = [value];
      }
      const cookies = response.headers.getSetCookie();
      if (cookies.length) returned["set-cookie"] = cookies;
      if (!headersInput.safeParse(returned).success)
        throw new Error("Native Browser App headers exceed their bound");
      send({ type: "app-head", id: frame.id, status: response.status, headers: returned });
      if (response.body) {
        const reader = response.body.getReader();
        const cancel = () => {
          void reader.cancel().catch(() => {});
        };
        controller.signal.addEventListener("abort", cancel, { once: true });
        let total = 0;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            controller.signal.throwIfAborted();
            total += value.byteLength;
            if (total > 16 << 20) throw new Error("Native Browser App response exceeds its bound");
            for (let offset = 0; offset < value.length; offset += 32 << 10)
              send({
                type: "app-data",
                id: frame.id,
                data: Buffer.from(value.subarray(offset, offset + (32 << 10))).toString("base64"),
              });
          }
        } finally {
          controller.signal.removeEventListener("abort", cancel);
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
      controller.signal.throwIfAborted();
      send({ type: "app-end", id: frame.id });
    } catch {
      if (!closed && !controller.signal.aborted) send({ type: "relay-error", id: frame.id });
    } finally {
      controller.abort("Native Browser relay ended");
      active.delete(frame.id);
    }
  }
  socket.addEventListener("open", () => {
    if (socket.protocol !== protocol) end("Native Browser protocol was not confirmed");
  });
  socket.addEventListener("message", (event) => {
    try {
      if (typeof event.data !== "string" || Buffer.byteLength(event.data) > maximumFrameBytes)
        throw new Error("Native Browser frame is invalid");
      const frame = frameInput.parse(JSON.parse(event.data));
      if (!confirmed) {
        if (
          frame.type !== "browser-connected" ||
          frame.actorUID !== config.actorUID ||
          frame.sessionID !== config.scope.sessionId ||
          socket.protocol !== protocol
        )
          throw new Error("Native Browser identity changed");
        confirmed = true;
        clearTimeout(connectTimer);
        ready.resolve();
        return;
      }
      if (frame.type === "operation-response" && frame.operation) {
        const operation = pending.get(frame.operation.operationId);
        if (!operation || operation.action !== frame.operation.action) return;
        pending.delete(frame.operation.operationId);
        clearTimeout(operation.timer);
        if (frame.operation.error)
          operation.reject(
            new SubstrateBrowserOperationError(operation.action, frame.operation.error),
          );
        else
          operation.resolve(
            frame.operation.data === undefined ? {} : { data: frame.operation.data },
          );
      } else if (frame.type === "relay-cancel" && frame.id) {
        active.get(frame.id)?.abort("Original Browser request ended");
      } else if (frame.type === "app-socket-message" && frame.id) {
        const current = appSockets.get(frame.id);
        // A cancelled stream may still have frames in flight. Never revive it.
        if (!current) {
          if (!seen.has(frame.id)) throw new Error("Unknown Native Browser App WebSocket");
          return;
        }
        if (!sameScope(frame.scope)) throw new Error("Native Browser relay scope changed");
        const value = socketData(frame);
        current.queued++;
        current.bytes += value.data.length;
        if (current.queued > 16 || current.bytes > 1 << 20) {
          current.controller.abort("Native Browser App WebSocket input exceeds its bound");
          send({ type: "relay-error", id: frame.id });
          return;
        }
        current.sending = current.sending
          .then(async () => {
            current.controller.signal.throwIfAborted();
            await current.socket.send(value.messageType, value.data);
          })
          .catch(() => {
            if (!current.controller.signal.aborted && !closed) {
              current.controller.abort("Native Browser App WebSocket send was not admitted");
              try {
                send({ type: "relay-error", id: frame.id });
              } catch {
                end();
              }
            }
          })
          .finally(() => {
            current.queued--;
            current.bytes -= value.data.length;
          });
      } else if (["app-request", "inspection-request", "app-socket-open"].includes(frame.type)) {
        void forward(frame).catch(() => end("Native Browser relay scope was not confirmed"));
      } else throw new Error("Unsupported Native Browser frame");
    } catch {
      end("Native Browser response is invalid; do not replay unknown operations");
    }
  });
  socket.addEventListener("close", () => end());
  socket.addEventListener("error", () => end("Native Browser TLS connection was not confirmed"));
  if (signal?.aborted) aborted();
  await ready.promise;
  return {
    async operation(
      operation: SubstrateBrowserOperation,
      beforeSend: (send: () => void) => Promise<void>,
    ) {
      if (
        operation.runtimeAttemptId !== config.runtimeAttemptId ||
        operation.generation !== config.generation ||
        !z.uuid().safeParse(operation.operationId).success ||
        pending.has(operation.operationId)
      )
        throw new Error("Native Browser operation does not match its execution");
      const result = Promise.withResolvers<{ data?: string }>();
      const entry = {
        action: operation.action,
        ...result,
        timer: setTimeout(
          () => {
            if (pending.delete(operation.operationId))
              result.reject(new Error("Native Browser operation timed out; do not replay it"));
          },
          operation.action === "browser-call" ? 45_000 : 25_000,
        ),
      };
      pending.set(operation.operationId, entry);
      let dispatched = false;
      // Adopt the result before an asynchronous authority guard can fail it.
      void result.promise.catch(() => {});
      try {
        await beforeSend(() => {
          if (pending.get(operation.operationId) !== entry || closed || dispatched)
            throw new Error("Native Browser operation is no longer pending");
          dispatched = true;
          send({
            type: "operation-request",
            operation: { type: "operation-request", ...operation },
          });
        });
        if (!dispatched) throw new Error("Native Browser dispatch was not admitted");
      } catch (cause) {
        clearTimeout(entry.timer);
        pending.delete(operation.operationId);
        result.reject(
          cause instanceof Error ? cause : new Error("Native Browser dispatch was not confirmed"),
        );
      }
      return result.promise;
    },
    close: end,
  };
}
