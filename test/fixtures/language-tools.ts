import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import { RuntimeHub, type RuntimeSocketData } from "../../apps/factory/src/runtime/hub";

type Source = { workspaceID: string; volume: string };
type Attempt = {
  id: string;
  parent: WebSocket;
  container: string;
  started: boolean;
  starting?: boolean;
  source: Source;
  initializer: string;
  assignmentFile: string;
  childToken: string;
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const FixtureWebSocket = WebSocket as typeof WebSocket & {
  new (url: string, options: Bun.WebSocketOptions): WebSocket;
};

// Native child + unchanged pinned language servers in actual Python/TypeScript
// container environments. This deliberately does not claim Envbox conformance;
// the normal runtime and final application acceptance cover that topology.
export async function languageToolsFixture(options: {
  image: string;
  proofID: string;
  artifacts: string;
  sources: Source[];
  containers: string[];
  docker(...args: string[]): Promise<string>;
}) {
  const attempts = new Map<string, Attempt>();
  const browserSockets = new Set<ServerWebSocket<RuntimeSocketData>>();
  const hub = new RuntimeHub(async () => {});
  let starts = 0;
  let languageConnections = 0;
  let disposing = false;
  const pendingStarts = new Set<Promise<void>>();
  const observations: unknown[] = [];
  const control = Bun.serve<RuntimeSocketData>({
    hostname: "0.0.0.0",
    port: 0,
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path === "/control") {
        const data = hub.authorize(request, hash);
        if (!data) return new Response(null, { status: 403 });
        if (
          server.upgrade(request, {
            data,
            headers: { "sec-websocket-protocol": RuntimeHub.protocol() },
          })
        )
          return;
      }
      const match = path.match(/^\/language\/([0-9a-f-]{36})\/(typescript|python)$/);
      const attempt = match?.[1] && attempts.get(match[1]);
      if (attempt && hub.connected(attempt.id)) {
        languageConnections++;
        if (
          server.upgrade(request, {
            data: {
              kind: "browser",
              attemptID: attempt.id,
              channel: "language",
              path: `/${match![2]}/${match![1]}`,
            },
          })
        )
          return;
      }
      return new Response(null, { status: 404 });
    },
    websocket: {
      open(socket) {
        if (socket.data.kind === "browser") browserSockets.add(socket);
        hub.open(socket);
      },
      message(socket, message) {
        if (socket.data.kind === "browser") {
          const request = JSON.parse(String(message)) as {
            method?: string;
            id?: number;
            params?: { textDocument?: { uri?: string; version?: number; text?: string } };
          };
          observations.push({
            direction: "request",
            path: socket.data.path,
            method: request.method,
            id: request.id,
            uri: request.params?.textDocument?.uri,
            version: request.params?.textDocument?.version,
            bytes: request.params?.textDocument?.text?.length,
          });
        }
        const envelope = JSON.parse(String(message)) as {
          type: string;
          data?: string;
          error?: string;
        };
        if (envelope.type === "websocket-message" && envelope.data) {
          const value = JSON.parse(Buffer.from(envelope.data, "base64").toString()) as {
            method?: string;
            id?: number;
            params?: unknown;
            error?: unknown;
          };
          if (
            value.method === "textDocument/publishDiagnostics" ||
            value.id !== undefined ||
            value.error
          )
            observations.push(value);
        }
        if (envelope.type === "stream-error") observations.push(envelope);
        hub.message(socket, message);
      },
      close(socket) {
        browserSockets.delete(socket);
        hub.close(socket);
      },
    },
  });
  const label = `factory.dev.independent-editor-proof=${options.proofID}`;
  try {
    for (const source of options.sources) {
      const id = crypto.randomUUID();
      const parentToken = crypto.randomUUID();
      const childToken = crypto.randomUUID();
      const container = `factory-language-child-${options.proofID}-${attempts.size}`;
      const initializer = `factory-language-init-${options.proofID}-${attempts.size}`;
      const assignmentFile = resolve(options.artifacts, `language-${id}.json`);
      await writeFile(
        assignmentFile,
        JSON.stringify({
          version: 1,
          runtimeAttemptId: id,
          generation: 1,
          workspaceFolder: "/source",
          remoteWorkspaceFolder: "/source",
          repositoryUrl: "file:///owned-language-proof.git",
          repositoryIdentity: source.workspaceID,
          revision: "main",
          devcontainerPath: ".devcontainer/devcontainer.json",
          composeProjectName: `language-${id}`,
          controlUrl: `ws://host.orb.internal:${control.port}/control`,
          channels: [{ name: "ide", kind: "ide", target: "", healthPath: "" }],
          processes: [],
        }),
        { mode: 0o444 },
      );
      hub.allow(id, 1, hash(parentToken), hash(childToken));
      const parent = new FixtureWebSocket(`ws://127.0.0.1:${control.port}/control`, {
        headers: {
          authorization: `Bearer ${parentToken}`,
          "x-factory-connector-role": "parent",
          "x-factory-runtime-attempt": id,
          "x-factory-runtime-generation": "1",
          "sec-websocket-protocol": RuntimeHub.protocol(),
        },
      });
      await new Promise<void>((resolve, reject) => {
        parent.onopen = () => resolve();
        parent.onerror = reject;
      });
      const attempt: Attempt = {
        id,
        parent,
        container,
        started: false,
        source,
        initializer,
        assignmentFile,
        childToken,
      };
      attempts.set(source.workspaceID, attempt);
    }
  } catch (cause) {
    for (const attempt of attempts.values()) attempt.parent.close();
    await control.stop(true);
    throw cause;
  }
  return {
    image: options.image,
    get starts() {
      return starts;
    },
    get observations() {
      return observations;
    },
    processes(workspaceID: string) {
      const attempt = attempts.get(workspaceID);
      if (!attempt) throw new Error("Unknown native Workspace");
      return { processes: hub.processes(attempt.id) };
    },
    processEvents(workspaceID: string, signal: AbortSignal) {
      const attempt = attempts.get(workspaceID);
      if (!attempt) throw new Error("Unknown native Workspace");
      return hub.processEvents.subscribe(attempt.id, "owned-native-language-proof", signal);
    },
    async processMetrics(workspaceID: string) {
      const attempt = attempts.get(workspaceID);
      if (!attempt?.started) throw new Error("Native Workspace has not started");
      const result = await options.docker(
        "exec",
        "--user",
        "101000:101000",
        attempt.container,
        "python",
        "-c",
        `import glob,json,os,pathlib
count=0
for path in glob.glob("/proc/[0-9]*/exe"):
    try:
        if os.readlink(path).endswith("/node"): count+=1
    except OSError: pass
print(json.dumps({"languageProcesses":count,"memoryBytes":int(pathlib.Path("/sys/fs/cgroup/memory.current").read_text())}))`,
      );
      return JSON.parse(result) as { languageProcesses: number; memoryBytes: number };
    },
    get languageConnections() {
      return languageConnections;
    },
    context(workspaceID: string) {
      const attempt = attempts.get(workspaceID);
      return {
        workspaceID,
        attemptID: attempt?.started || attempt?.starting ? attempt.id : null,
        state:
          attempt?.starting && !attempt.started
            ? "starting"
            : attempt?.started && hub.connected(attempt.id)
              ? "ready"
              : attempt?.started
                ? "reconnecting"
                : "stopped",
        failure: null,
      };
    },
    async start(workspaceID: string) {
      const attempt = attempts.get(workspaceID);
      if (disposing || !attempt || attempt.started || attempt.starting)
        throw new Error("Unexpected duplicate language fixture start");
      attempt.starting = true;
      const finished = Promise.withResolvers<void>();
      pendingStarts.add(finished.promise);
      try {
        starts++;
        options.containers.push(attempt.initializer);
        await options.docker(
          "run",
          "--rm",
          "--name",
          attempt.initializer,
          "--label",
          label,
          "--network",
          "none",
          "--mount",
          `type=volume,source=${attempt.source.volume},target=/source,volume-subpath=source`,
          "--entrypoint",
          "sh",
          options.image,
          "-ec",
          `ln -s /opt/project-seed/node_modules /source/node_modules
printf '%s' '{"compilerOptions":{"strict":true,"module":"nodenext","moduleResolution":"nodenext","noEmit":true}}' > /source/tsconfig.json
chown 101000:101000 /source/tsconfig.json`,
        );
        options.containers.push(attempt.container);
        await options.docker(
          "run",
          "--detach",
          "--name",
          attempt.container,
          "--label",
          label,
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--user",
          "101000:101000",
          "--tmpfs",
          "/tmp:exec,size=64m,mode=1777",
          "--mount",
          `type=volume,source=${attempt.source.volume},target=/source,volume-subpath=source`,
          "--mount",
          `type=bind,source=${attempt.assignmentFile},target=/assignment.json,readonly`,
          "--env",
          `FACTORY_CONNECTOR_TOKEN=${attempt.childToken}`,
          options.image,
          "child",
          "--assignment",
          "/assignment.json",
        );
        attempt.started = true;
        const deadline = Date.now() + 15000;
        while (!hub.connected(attempt.id)) {
          if (Date.now() > deadline) throw new Error("Native language child did not connect");
          await Bun.sleep(50);
        }
      } finally {
        attempt.starting = false;
        finished.resolve();
        pendingStarts.delete(finished.promise);
      }
    },
    target(workspaceID: string, language: string) {
      if (!attempts.has(workspaceID) || !["typescript", "python"].includes(language))
        throw new Error("Invalid language target");
      return `ws://127.0.0.1:${control.port}/language/${workspaceID}/${language}`;
    },
    disconnect(workspaceID: string) {
      const attempt = attempts.get(workspaceID);
      if (!attempt) throw new Error("Unknown language fixture");
      for (const socket of browserSockets)
        if (socket.data.attemptID === attempt.id) socket.close(1012, "Owned reconnect proof");
    },
    async dispose() {
      // A browser assertion may finish while Docker is still creating the
      // admitted child. Settle that owned start before enumerating cleanup.
      disposing = true;
      await Promise.all(pendingStarts);
      for (const attempt of attempts.values()) {
        hub.revoke(attempt.id);
        attempt.parent.close();
      }
      await control.stop(true);
    },
  };
}
