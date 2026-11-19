// Test-only, cookie-authenticated Zero read. No product mutations or persistent client store.
import { X509Certificate } from "node:crypto";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { checkServerIdentity } from "node:tls";
import { type FactoryZeroContext, zeroQueries, zeroSchema } from "../../packages/zero-schema/src";

export type RestoredProject = {
  id: string;
  name: string;
  slug: string;
  repositoryUrl: string;
  defaultBranch: string;
  devcontainerPath: string;
};
export type ZeroProjectRead = {
  owner: string;
  factoryOrigin: string;
  address: string;
  ca: string;
  cookie: string;
  accountID: string;
  systemManager: boolean;
  cacheScope: string;
  seconds: number;
  responseBytes: number;
};
export type ProjectReader = (
  input: ZeroProjectRead,
  signal: AbortSignal,
) => Promise<RestoredProject[]>;
const fields = [
  "id",
  "name",
  "slug",
  "repositoryUrl",
  "defaultBranch",
  "devcontainerPath",
] as const;
const failure = () => Error("Restored Zero Project read refused; owned child must be closed");
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
function requireThat(value: unknown): asserts value {
  if (!value) throw failure();
}
export function projectRows(value: unknown): RestoredProject[] {
  requireThat(Array.isArray(value));
  const ids = new Set<string>();
  return value.map((row) => {
    requireThat(row && typeof row === "object" && !Array.isArray(row));
    requireThat(fields.every((key) => typeof row[key] === "string"));
    requireThat(uuid.test(row.id) && !ids.has(row.id));
    ids.add(row.id);
    return Object.fromEntries(fields.map((key) => [key, row[key]])) as RestoredProject;
  });
}
export function validateZeroRead(value: unknown): ZeroProjectRead {
  requireThat(value && typeof value === "object" && !Array.isArray(value));
  const input = value as ZeroProjectRead;
  requireThat(
    Object.keys(input).sort().join(" ") ===
      "accountID address ca cacheScope cookie factoryOrigin owner responseBytes seconds systemManager",
  );
  const origin = new URL(input.factoryOrigin);
  requireThat(
    origin.protocol === "https:" &&
      origin.origin === input.factoryOrigin &&
      !origin.username &&
      !origin.password &&
      !isIP(origin.hostname) &&
      /^[a-z0-9.-]+$/.test(origin.hostname) &&
      typeof input.address === "string" &&
      isIP(input.address) !== 0 &&
      typeof input.ca === "string" &&
      !input.ca.includes("PRIVATE KEY") &&
      new X509Certificate(input.ca).ca &&
      /^[a-f0-9]{32}$/.test(input.owner) &&
      uuid.test(input.accountID) &&
      typeof input.systemManager === "boolean" &&
      /^[a-f0-9]{64}$/.test(input.cacheScope) &&
      typeof input.cookie === "string" &&
      input.cookie.length > 0 &&
      input.cookie.length <= 64 * 1024 &&
      !/[\r\n]/.test(input.cookie) &&
      Number.isSafeInteger(input.seconds) &&
      input.seconds > 0 &&
      input.seconds <= 3600 &&
      Number.isSafeInteger(input.responseBytes) &&
      input.responseBytes >= 1024 &&
      input.responseBytes <= 16 * 1024 * 1024,
  );
  return input;
}

// The parent never substitutes its global WebSocket or imports credentials from disk.
export const readRestoredProjects: ProjectReader = async (input, signal) => {
  validateZeroRead(input);
  signal.throwIfAborted();
  const child = Bun.spawn([process.execPath, "--no-env-file", import.meta.filename, "--child"], {
    env: { PATH: process.env["PATH"] ?? "", TZ: "UTC", DO_NOT_TRACK: "1", NO_COLOR: "1" },
    stdin: new Blob([JSON.stringify(input)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stop = () => child.kill("SIGKILL");
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(input.seconds * 1000)]);
  bounded.addEventListener("abort", stop, { once: true });
  if (bounded.aborted) stop();
  async function collect(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader(),
      chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(chunks).toString("utf8");
      bytes += next.value.byteLength;
      if (bytes > input.responseBytes) {
        stop();
        await reader.cancel();
        throw failure();
      }
      chunks.push(next.value);
    }
  }
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      collect(child.stdout),
      collect(child.stderr),
    ]);
    bounded.throwIfAborted();
    requireThat(code === 0 && stderr === "");
    const result = JSON.parse(stdout);
    requireThat(
      Object.keys(result).sort().join(" ") === "clientClosed projects status" &&
        result.status === "complete" &&
        result.clientClosed === true,
    );
    return projectRows(result.projects);
  } catch {
    throw failure();
  } finally {
    bounded.removeEventListener("abort", stop);
    if (child.exitCode === null && child.signalCode === null) stop();
    await child.exited;
  }
};

async function childRead(input: ZeroProjectRead) {
  const requireZero = createRequire(import.meta.resolve("@rocicorp/zero"));
  // Bun aliases bare "ws" to its native compatibility layer. Load the already
  // installed JS dependency explicitly for Node TLS/lookup and redirect semantics.
  const wsPackage = requireZero.resolve("ws/package.json");
  requireThat(requireZero(wsPackage).version === "8.22.0");
  type NativeSocket = WebSocket & { terminate(): void };
  const Native = requireZero(join(dirname(wsPackage), "index.js")) as {
    new (url: string | URL, protocols?: string | string[], options?: object): NativeSocket;
    prototype: NativeSocket;
    readonly CONNECTING: 0;
    readonly OPEN: 1;
    readonly CLOSING: 2;
    readonly CLOSED: 3;
  };
  const sockets = new Set<InstanceType<typeof Native>>();
  let stopping = false,
    attempts = 0,
    bytes = 0;
  let rejectRead: (error: Error) => void = () => {};
  const fail = () => {
    stopping = true;
    rejectRead(failure());
    for (const socket of sockets) socket.terminate();
  };
  const expected = new URL(input.factoryOrigin);
  class PinnedSocket extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      const logical = new URL(url);
      requireThat(
        !stopping &&
          attempts++ === 0 &&
          logical.protocol === "wss:" &&
          logical.host === expected.host &&
          logical.pathname === "/zero/sync/v52/connect" &&
          !logical.username &&
          !logical.password &&
          !logical.hash &&
          logical.searchParams.get("userID") === input.accountID,
      );
      super(url, protocols, {
        ca: input.ca,
        rejectUnauthorized: true,
        servername: expected.hostname,
        checkServerIdentity: (
          _hostname: string,
          certificate: Parameters<typeof checkServerIdentity>[1],
        ) => checkServerIdentity(expected.hostname, certificate),
        lookup: (
          _hostname: string,
          options: { all?: boolean },
          callback: (...args: unknown[]) => void,
        ) =>
          options.all
            ? callback(null, [{ address: input.address, family: isIP(input.address) }])
            : callback(null, input.address, isIP(input.address)),
        headers: { cookie: input.cookie, origin: input.factoryOrigin },
        agent: false,
        followRedirects: false,
        perMessageDeflate: false,
        maxPayload: input.responseBytes,
        handshakeTimeout: input.seconds * 1000,
      });
      sockets.add(this);
      this.addEventListener("message", (event) => {
        bytes +=
          typeof event.data === "string"
            ? Buffer.byteLength(event.data)
            : (event.data as ArrayBuffer).byteLength;
        if (bytes > input.responseBytes) fail();
      });
      this.addEventListener("error", fail);
      this.addEventListener("close", () => {
        sockets.delete(this);
        if (!stopping) fail();
      });
    }
    override send(data: Parameters<WebSocket["send"]>[0]) {
      // SDK-generated metadata only. Never send a planning or CRUD mutation.
      requireThat(typeof data === "string");
      const message = JSON.parse(data);
      requireThat(
        Array.isArray(message) &&
          [
            "initConnection",
            "changeDesiredQueries",
            "ping",
            "pull",
            "deleteClients",
            "closeConnection",
            "ackMutationResponses",
          ].includes(message[0]),
      );
      return super.send(data);
    }
  }
  globalThis.WebSocket = PinnedSocket;
  // This child needs only its pinned socket. In particular, no metrics HTTP or
  // future SDK fallback may acquire an unpinned route.
  globalThis.fetch = Object.assign(
    async () => {
      throw failure();
    },
    {
      preconnect: () => {
        throw failure();
      },
    },
  );
  const { Zero } = await import("@rocicorp/zero");
  const client = new Zero<typeof zeroSchema, undefined, FactoryZeroContext>({
    cacheURL: `${input.factoryOrigin}/zero`,
    userID: input.accountID,
    context: { userId: input.accountID, systemManager: input.systemManager },
    schema: zeroSchema,
    kvStore: "mem",
    storageKey: JSON.stringify([input.cacheScope, "factory-read-projections-v1", input.owner]),
    logLevel: "error",
    logSink: { log() {} },
  });
  let destroy = () => {},
    unsubscribe = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<RestoredProject[]>((accept, reject) => {
      rejectRead = reject;
      timer = setTimeout(fail, input.seconds * 1000);
      const view = client.materialize(zeroQueries.projects.list(), { ttl: "none" });
      let complete: RestoredProject[] | undefined;
      const finish = () => {
        if (!stopping && complete && client.connection.state.current.name === "connected")
          accept(complete);
      };
      unsubscribe = client.connection.state.subscribe((state) => {
        if (["error", "needs-auth", "closed", "disconnected"].includes(state.name)) fail();
        else finish();
      });
      const off = view.addListener((data, completeness, error) => {
        if (error) return fail();
        if (completeness === "complete") {
          try {
            complete = projectRows(data);
            finish();
          } catch {
            fail();
          }
        }
      });
      destroy = () => {
        off();
        view.destroy();
      };
    });
  } finally {
    stopping = true;
    clearTimeout(timer);
    destroy();
    unsubscribe();
    const closed = [...sockets].map(
      (socket) =>
        new Promise<void>((done) => {
          if (socket.readyState === WebSocket.CLOSED) return done();
          socket.addEventListener("close", () => done(), { once: true });
        }),
    );
    const clientClosed = client.close();
    for (const socket of sockets) socket.terminate();
    await Promise.all([clientClosed, ...closed]);
    requireThat(sockets.size === 0);
  }
}

if (import.meta.main) {
  try {
    requireThat(process.argv.length === 3 && process.argv[2] === "--child");
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of Bun.stdin.stream()) {
      length += chunk.byteLength;
      requireThat(length <= 256 * 1024);
      chunks.push(chunk);
    }
    const input = validateZeroRead(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const projects = await childRead(input);
    await Bun.write(
      Bun.stdout,
      `${JSON.stringify({ status: "complete", projects, clientClosed: true })}\n`,
    );
    process.exit(0);
  } catch {
    await Bun.write(Bun.stdout, '{"status":"failed"}\n');
    process.exit(1);
  }
}
