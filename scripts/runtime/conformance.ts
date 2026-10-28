import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import { readRuntimeRegistryCA } from "../../packages/runtime-kubernetes/src/client";
import { runCommand } from "../../packages/runtime-kubernetes/src/command";
import { kubernetesCommand } from "../../packages/runtime-kubernetes/src/config";
import { configuredFactoryboxRuntimeProfile } from "../../packages/runtime-kubernetes/src/factorybox-runtime";
import { createConformanceRuntime } from "./factorybox-conformance";

const owner = crypto.randomUUID();
const workspace = "/home/coder/runtime-project";
const sourceWorkspace = "/home/coder/runtime-source-project";
const config = `${workspace}/.devcontainer/devcontainer.json`;
const composeFile = `${workspace}/.devcontainer/compose.yaml`;
const composeProject = "runtime-project_devcontainer";
const fixture = resolve(import.meta.dir, "../../test/fixtures/runtime-project");
const artifacts = resolve(
  import.meta.dir,
  "../../.factory/test-results/runtime-conformance",
  owner,
);
const connectorBinary = "/usr/local/bin/factory-runtime-connector";
const connectorAttempt = "runtime-conformance";
const connectorGeneration = 1;
const connectorToken = "conformance-short-lived-token";
const childConnectorToken = "conformance-short-lived-child-token";
const expectedRuntimeHost = (
  process.env["FACTORY_RUNTIME_CONFORMANCE_IMAGE"] ??
  (await readFile(resolve(import.meta.dir, "../../.factory/runtime-host-image"), "utf8"))
).trim();
if (!/^[a-zA-Z0-9.:/_-]+@sha256:[a-f0-9]{64}$/.test(expectedRuntimeHost))
  throw new Error("Runtime conformance requires an exact registry digest");
const languageProof = process.env["FACTORY_RUNTIME_LANGUAGE_CONFORMANCE"] === "1";
const runtime = createConformanceRuntime(
  owner,
  expectedRuntimeHost,
  configuredFactoryboxRuntimeProfile(),
  await readRuntimeRegistryCA(),
  artifacts,
);
const { namespace, pod } = runtime;

type CommandOptions = {
  input?: string;
  quiet?: boolean;
};

type DevcontainerResult = {
  outcome: string;
  containerId: string;
  composeProjectName: string;
  remoteUser: string;
  remoteWorkspaceFolder: string;
};

type DockerContainer = {
  Id: string;
  Config: { Labels: Record<string, string> };
  State: { Running: boolean; Health?: { Status: string } };
};

type ConnectorMessage = {
  type: string;
  role?: string;
  runtimeAttemptId?: string;
  generation?: number;
  phase?: string;
  channels?: Array<{ name: string; kind: string; target: string; healthPath: string }>;
  streamId?: string;
  channel?: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  status?: number;
  data?: string;
  messageType?: number;
  protocol?: string;
  error?: string;
};

async function command(args: string[], options: CommandOptions = {}) {
  const { stdout, stderr, exitCode } = await runCommand(args, options.input, {
    timeoutMS: 360_000,
    outputBytes: 4 * 1024 * 1024,
  });
  if (exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed (${exitCode})\n${stderr || stdout}`);
  }
  if (!options.quiet && stderr) process.stderr.write(stderr);
  return stdout.trim();
}

function kubectl(args: string[]) {
  return command(kubernetesCommand(args));
}

function inner(args: string[], options: CommandOptions = {}) {
  return command(runtime.execArgs(args, options.input !== undefined), options);
}

function innerDocker(args: string[]) {
  return inner(["docker", ...args]);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function prepareSmokeRuntime() {
  await mkdir(artifacts, { recursive: true });
  await runtime.prepare();
  const deadline = Date.now() + 30_000;
  let lastObservation = "";
  while (Date.now() < deadline) {
    try {
      const probe = await runCommand(runtime.execArgs(["docker", "info"]), undefined);
      if (probe.exitCode === 0) {
        await writeFile(
          resolve(artifacts, "ready.json"),
          JSON.stringify({ owner, pod, image: expectedRuntimeHost }, null, 2),
        );
        return;
      }
      lastObservation = probe.stderr.slice(-2000);
    } catch (cause) {
      // A timed-out read does not prove that the owned Pod/daemon stopped.
      // Observe the same intent; never replace it to make the fixture pass.
      lastObservation =
        cause instanceof Error ? cause.message : "Docker readiness observation failed";
    }
    await Bun.sleep(1_000);
  }
  throw new Error(
    `The same Factorybox private Docker daemon did not become ready: ${lastObservation}`,
  );
}

async function removeSmokeRuntime() {
  await runtime.cleanup();
}

async function removeIds(resource: "container" | "network" | "volume", ids: string) {
  for (const id of ids.split(/\s+/).filter(Boolean)) {
    await innerDocker(resource === "container" ? ["rm", "-f", id] : [resource, "rm", "-f", id]);
  }
}

async function cleanupInnerStack() {
  await inner([
    "sh",
    "-c",
    'if [ -f "$1" ]; then docker compose --project-name "$2" --file "$1" down --volumes --remove-orphans; fi',
    "factory-cleanup",
    composeFile,
    composeProject,
  ]);
  const label = `com.docker.compose.project=${composeProject}`;
  await removeIds("container", await innerDocker(["ps", "-aq", "--filter", `label=${label}`]));
  await removeIds(
    "network",
    await innerDocker(["network", "ls", "-q", "--filter", `label=${label}`]),
  );
  await removeIds(
    "volume",
    await innerDocker(["volume", "ls", "-q", "--filter", `label=${label}`]),
  );
}

async function assertNoInnerStack() {
  const label = `com.docker.compose.project=${composeProject}`;
  const [containers, networks, volumes] = await Promise.all([
    innerDocker(["ps", "-aq", "--filter", `label=${label}`]),
    innerDocker(["network", "ls", "-q", "--filter", `label=${label}`]),
    innerDocker(["volume", "ls", "-q", "--filter", `label=${label}`]),
  ]);
  assert(!containers && !networks && !volumes, "Dev Container resources remain after cleanup");
}

async function stageFixture(target = workspace) {
  await inner(["rm", "-rf", target]);
  await inner(["mkdir", "-p", target]);
  await inner(["chown", "1000:1000", target]);
  const archive = Bun.spawn(["tar", "-C", fixture, "-cf", "-", "."], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const extraction = Bun.spawn(
    runtime.execArgs(["tar", "-C", target, "-xf", "-"], true, "1000:1000"),
    { stdin: archive.stdout, stdout: "pipe", stderr: "pipe" },
  );
  const [archiveExit, extractionExit, archiveError, extractionError] = await Promise.all([
    archive.exited,
    extraction.exited,
    new Response(archive.stderr).text(),
    new Response(extraction.stderr).text(),
  ]);
  assert(archiveExit === 0, `Fixture archive failed: ${archiveError}`);
  assert(extractionExit === 0, `Fixture extraction failed: ${extractionError}`);
}

async function devcontainerUp() {
  const output = await command(
    runtime.execArgs([
      "devcontainer",
      "up",
      "--workspace-folder",
      workspace,
      "--config",
      config,
      "--log-format",
      "json",
    ]),
    { quiet: true },
  );
  const result = output
    .split("\n")
    .reverse()
    .map((line) => {
      try {
        return JSON.parse(line) as Partial<DevcontainerResult>;
      } catch {
        return undefined;
      }
    })
    .find((line) => line?.outcome) as DevcontainerResult | undefined;
  assert(result?.outcome === "success", "Dev Containers CLI did not report success");
  assert(result.containerId?.length === 64, "Dev Containers CLI returned no primary container");
  assert(result.composeProjectName === composeProject, "Unexpected Compose project identity");
  assert(result.remoteUser === "node", "Unexpected Dev Container remote user");
  assert(result.remoteWorkspaceFolder === "/workspace/project", "Unexpected workspace folder");
  return result;
}

async function inspectContainer(id: string) {
  const inspected = JSON.parse(await innerDocker(["inspect", id])) as DockerContainer[];
  const container = inspected[0];
  assert(container, `Container ${id} was not found`);
  return container;
}

async function verifyRuntimeBoundary() {
  await runtime.boundary();
  assert(
    (await kubectl([
      "exec",
      "-n",
      namespace,
      pod,
      "--",
      "sh",
      "-c",
      "test ! -e /var/run/secrets/kubernetes.io/serviceaccount/token",
    ])) === "",
    "A Kubernetes service-account token entered the runtime Pod",
  );
  const versions = await inner([
    "sh",
    "-c",
    'printf \'%s\\n\' "$(docker version --format \'{{.Server.Version}}\')" "$(docker compose version --short)" "$(node --version)" "$(devcontainer --version)" "$(uname -m)"',
  ]);
  assert(
    versions ===
      `29.9.0\n5.6.0\nv24.21.0\n0.89.0\n${runtime.architecture === "arm64" ? "aarch64" : "x86_64"}`,
    `Unexpected runtime toolchain:\n${versions}`,
  );
  const coderBoundary = await inner([
    "sh",
    "-c",
    'url=absent; test -n "$' +
      '{CODER_AGENT_URL:-}" && url=present; ' +
      "binary=absent; command -v coder >/dev/null 2>&1 && binary=present; " +
      "process=absent; ps -eo comm | grep -E '^(coder|coder-agent)$' >/dev/null && process=present; " +
      'printf "%s %s %s" "$url" "$binary" "$process"',
  ]);
  assert(
    coderBoundary === "absent absent absent",
    `Coder boundary failed (agent URL, binary, process): ${coderBoundary}`,
  );
}

async function verifyStack(result: DevcontainerResult) {
  const primary = await inspectContainer(result.containerId);
  const labels = primary.Config.Labels;
  assert(labels["com.docker.compose.project"] === composeProject, "Primary Compose label is wrong");
  assert(labels["com.docker.compose.service"] === "app", "Primary service label is wrong");
  assert(labels["devcontainer.local_folder"] === workspace, "Primary Dev Container label is wrong");
  assert(labels["devcontainer.config_file"] === config, "Primary config label is wrong");
  assert(primary.State.Running, "Primary container is not running");

  const ids = (
    await innerDocker([
      "ps",
      "-aq",
      "--filter",
      `label=com.docker.compose.project=${composeProject}`,
    ])
  ).split("\n");
  assert(ids.filter(Boolean).length === 2, "Dev Containers CLI started an undeclared service");
  const supportId = await innerDocker([
    "ps",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${composeProject}`,
    "--filter",
    "label=com.docker.compose.service=support",
  ]);
  const support = await inspectContainer(supportId);
  assert(support.State.Health?.Status === "healthy", "Support service is not healthy");

  const identity = await inner([
    "devcontainer",
    "exec",
    "--workspace-folder",
    workspace,
    "sh",
    "-c",
    'printf \'%s %s %s\' "$(id -u)" "$(id -g)" "$(stat -c %u:%g /workspace/project/src/version.txt)"',
  ]);
  assert(identity === "1000 1000 1000:1000", `Unexpected Dev Container identity: ${identity}`);
  const credentials = await innerDocker([
    "exec",
    result.containerId,
    "sh",
    "-c",
    "test ! -e /factory/assignment/token && test ! -e /tmp/factory-runtime-token-1 && ! env | grep -q '^FACTORY_CONNECTOR_TOKEN='",
  ]);
  assert(credentials === "", "A Factory Connector credential entered the Project container");
  const service = await inner([
    "devcontainer",
    "exec",
    "--workspace-folder",
    workspace,
    "node",
    "-e",
    "fetch('http://support:4100/health').then(async r=>{if(!r.ok)process.exit(1);console.log(await r.text())})",
  ]);
  assert(service === '{"status":"ok"}', "Primary container cannot reach support by service DNS");
}

async function verifyAppAndHotUpdate(containerId: string) {
  await innerDocker([
    "exec",
    "--detach",
    "--user",
    "1000:1000",
    containerId,
    "node",
    "/workspace/project/src/server.mjs",
  ]);
  await innerDocker([
    "exec",
    "--user",
    "1000:1000",
    containerId,
    "node",
    "-e",
    "let passed=false;for(let i=0;i<50;i++){try{const r=await fetch('http://127.0.0.1:4300/health');const body=await r.json();if(r.ok&&body.status==='ok'&&body.support==='support-ready'){passed=true;break}}catch{}await new Promise(r=>setTimeout(r,100))}if(!passed)process.exitCode=1",
  ]);
  const browserProtocol = `
    import { writeFile } from "node:fs/promises";
    const timeout = setTimeout(() => process.exit(2), 10000);
    let changed = false;
    let finished = false;
    const socket = new WebSocket("ws://127.0.0.1:4300/ws");
    socket.addEventListener("open", () => socket.send("factory-ping"));
    socket.addEventListener("message", async (event) => {
      if (finished) return;
      const message = JSON.parse(event.data);
      if (!changed && message.type === "echo" && message.value === "factory-ping") {
        changed = true;
        await writeFile("/workspace/project/src/version.txt", "two\\n");
      }
      if (changed && message.type === "hot-update" && message.version === "two") {
        finished = true;
        const source = await fetch("http://127.0.0.1:4300/source").then((response) => response.json());
        if (source.version !== "two") process.exit(3);
        await writeFile("/workspace/project/src/version.txt", "one\\n");
        clearTimeout(timeout);
        socket.close();
      }
    });
  `;
  await innerDocker([
    "exec",
    "--user",
    "1000:1000",
    containerId,
    "node",
    "--input-type=module",
    "--eval",
    browserProtocol,
  ]);
  const restored = await innerDocker([
    "exec",
    "--user",
    "1000:1000",
    containerId,
    "cat",
    "/workspace/project/src/version.txt",
  ]);
  assert(restored === "one", "App WebSocket probe did not restore the source fixture");
}

async function verifyVolumeSurvivesRestart() {
  await inner([
    "devcontainer",
    "exec",
    "--workspace-folder",
    workspace,
    "sh",
    "-c",
    "printf conformance >/workspace/data/marker",
  ]);
  await innerDocker([
    "compose",
    "--project-name",
    composeProject,
    "--file",
    composeFile,
    "down",
    "--remove-orphans",
  ]);
  const result = await devcontainerUp();
  const marker = await inner([
    "devcontainer",
    "exec",
    "--workspace-folder",
    workspace,
    "cat",
    "/workspace/data/marker",
  ]);
  assert(marker === "conformance", "Named volume did not survive a stack restart");
  return result;
}

function writeConnectorMessage(
  socket: ServerWebSocket<{ role: string }>,
  message: ConnectorMessage,
) {
  socket.send(JSON.stringify(message));
}

async function runConnectorControl() {
  let parent: ServerWebSocket<{ role: string }> | undefined;
  let child: ServerWebSocket<{ role: string }> | undefined;
  let httpBody = "";
  let hotUpdate = false;
  let stopSent = false;
  let runtimeFailure = "";
  let semanticDiagnostic = false;
  let dependencyCompletion = false;
  let languageClosed = false;
  const completed = Promise.withResolvers<void>();
  const server = Bun.serve<{ role: string }>({
    hostname: "0.0.0.0",
    port: 0,
    fetch(request, server) {
      const role = request.headers.get("x-factory-connector-role");
      const valid =
        [connectorToken, childConnectorToken].includes(
          request.headers.get("authorization")?.replace("Bearer ", "") ?? "",
        ) &&
        request.headers.get("x-factory-runtime-attempt") === connectorAttempt &&
        request.headers.get("x-factory-runtime-generation") === String(connectorGeneration) &&
        (role === "parent" || role === "child");
      if (!valid) return new Response("unauthorized", { status: 401 });
      if (
        !server.upgrade(request, {
          data: { role },
          headers: { "sec-websocket-protocol": "factory-runtime-connector-v1" },
        })
      ) {
        return new Response("upgrade failed", { status: 500 });
      }
      return undefined;
    },
    websocket: {
      open(socket) {
        if (socket.data.role === "parent") parent = socket;
        else child = socket;
      },
      message(socket, raw) {
        const message = JSON.parse(String(raw)) as ConnectorMessage;
        if (message.type === "hello" && message.role === "child") {
          if (
            message.runtimeAttemptId !== connectorAttempt ||
            message.generation !== connectorGeneration
          ) {
            completed.reject(new Error("Child hello has the wrong runtime identity"));
            return;
          }
          if (message.channels?.[0]?.name !== "app") {
            completed.reject(new Error("Child did not declare the assigned App channel"));
            return;
          }
          if (languageProof) {
            writeConnectorMessage(socket, {
              type: "websocket-open",
              streamId: "language-conformance",
              channel: "language",
              path: `/typescript/${owner}`,
            });
            return;
          }
          writeConnectorMessage(socket, {
            type: "http-request",
            streamId: "connector-http",
            channel: "app",
            method: "GET",
            path: "/source",
          });
          return;
        }
        if (message.streamId === "language-conformance") {
          const send = (value: unknown) =>
            writeConnectorMessage(socket, {
              type: "websocket-message",
              streamId: "language-conformance",
              messageType: 1,
              data: Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...(value as object) })).toString(
                "base64",
              ),
            });
          const uri = `factory-workspace://${owner}/src/language.ts`;
          if (message.type === "websocket-ready") {
            send({
              id: 1,
              method: "initialize",
              params: {
                rootUri: `factory-workspace://${owner}/`,
                capabilities: {
                  textDocument: {
                    publishDiagnostics: {},
                    completion: { completionItem: { snippetSupport: false } },
                  },
                },
              },
            });
          } else if (message.type === "websocket-message" && message.data) {
            const response = JSON.parse(Buffer.from(message.data, "base64").toString()) as {
              id?: number;
              error?: unknown;
              result?: { items?: Array<{ label: string }> } | Array<{ label: string }>;
              method?: string;
              params?: { diagnostics?: Array<{ code: number }> };
            };
            if (response.error) {
              completed.reject(
                new Error(`Native language operation failed: ${JSON.stringify(response.error)}`),
              );
              return;
            }
            if (response.id === 1) {
              send({ method: "initialized", params: {} });
              send({
                method: "textDocument/didOpen",
                params: {
                  textDocument: {
                    uri,
                    languageId: "typescript",
                    version: 1,
                    text: "const total: string = 42;\nMath.\n",
                  },
                },
              });
              send({
                id: 2,
                method: "textDocument/completion",
                params: { textDocument: { uri }, position: { line: 1, character: 5 } },
              });
            } else if (response.id === 2) {
              const result = response.result;
              dependencyCompletion =
                (Array.isArray(result) ? result : result?.items)?.some(
                  (item) => item.label === "abs",
                ) ?? false;
              if (!dependencyCompletion)
                completed.reject(new Error("Native project TypeScript completion is missing"));
            } else if (response.method === "textDocument/publishDiagnostics") {
              semanticDiagnostic ||=
                response.params?.diagnostics?.some((item) => item.code === 2322) ?? false;
            }
            if (semanticDiagnostic && dependencyCompletion && !languageClosed) {
              languageClosed = true;
              writeConnectorMessage(socket, {
                type: "stream-close",
                streamId: "language-conformance",
              });
              writeConnectorMessage(socket, {
                type: "http-request",
                streamId: "connector-http",
                channel: "app",
                method: "GET",
                path: "/source",
              });
            }
          } else if (
            message.type === "stream-error" ||
            (message.type === "stream-close" && !languageClosed)
          ) {
            completed.reject(
              new Error(
                message.error ?? "Native language server closed before completion/diagnostics",
              ),
            );
          }
          return;
        }
        if (message.streamId === "connector-http") {
          if (message.type === "http-response" && message.status !== 200) {
            completed.reject(new Error(`Connector HTTP returned ${message.status}`));
          } else if (message.type === "stream-data" && message.data) {
            httpBody += Buffer.from(message.data, "base64").toString();
          } else if (message.type === "stream-end") {
            const source = JSON.parse(httpBody) as { version: string };
            if (source.version !== "one") {
              completed.reject(new Error("Connector HTTP returned the wrong source version"));
              return;
            }
            writeConnectorMessage(socket, {
              type: "websocket-open",
              streamId: "connector-websocket",
              channel: "app",
              path: "/ws",
            });
          }
          return;
        }
        if (message.streamId === "connector-websocket") {
          if (message.type === "websocket-ready") {
            writeConnectorMessage(socket, {
              type: "websocket-message",
              streamId: "connector-websocket",
              messageType: 1,
              data: Buffer.from("connector-ping").toString("base64"),
            });
          } else if (message.type === "websocket-message" && message.data) {
            const payload = JSON.parse(Buffer.from(message.data, "base64").toString()) as {
              type: string;
              value?: string;
              version?: string;
            };
            if (payload.type === "echo" && payload.value === "connector-ping") {
              void inner(["sh", "-c", `printf 'two\\n' >${workspace}/src/version.txt`]);
            } else if (payload.type === "hot-update" && payload.version === "two") {
              hotUpdate = true;
              writeConnectorMessage(socket, {
                type: "stream-close",
                streamId: "connector-websocket",
              });
              void inner(["sh", "-c", `printf 'one\\n' >${workspace}/src/version.txt`]);
              if (parent && !stopSent) {
                stopSent = true;
                writeConnectorMessage(parent, { type: "stop" });
              }
            }
          }
          return;
        }
        if (message.type === "status" && message.phase === "stopped") {
          if (!hotUpdate)
            completed.reject(
              new Error(runtimeFailure || "Connector stopped before the hot update"),
            );
          else completed.resolve();
        } else if (message.type === "status" && message.phase === "cleanup-failed") {
          completed.reject(new Error(message.error ?? "Connector cleanup failed"));
        } else if (message.type === "status" && message.phase === "failed") {
          runtimeFailure = message.error ?? "Runtime Connector failed";
        } else if (message.type === "stream-error") {
          completed.reject(new Error(message.error ?? "Connector stream failed"));
        }
      },
      close(socket) {
        if (socket === parent) parent = undefined;
        if (socket === child) child = undefined;
      },
    },
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return {
    port: server.port,
    begin() {
      if (timeout) return;
      timeout = setTimeout(
        () => completed.reject(new Error("Timed out waiting for the Runtime Connector")),
        120_000,
      );
    },
    dispose() {
      if (timeout) clearTimeout(timeout);
      server.stop(true);
    },
    completed: completed.promise.finally(() => {
      if (timeout) clearTimeout(timeout);
      server.stop(true);
    }),
  };
}

async function verifyConnector() {
  await cleanupInnerStack();
  await inner(["rm", "-rf", workspace, sourceWorkspace]);
  await stageFixture(sourceWorkspace);
  if (languageProof) {
    for (const path of ["package.json", "package-lock.json"])
      await inner([
        "sh",
        "-c",
        'printf "%s" "$1" > "$2"',
        "language-project-input",
        await readFile(
          resolve(import.meta.dir, `../../test/fixtures/language-project/${path}`),
          "utf8",
        ),
        `${sourceWorkspace}/${path}`,
      ]);
    await inner([
      "node",
      "-e",
      `const fs=require("fs"); const path=process.argv[1];const config=JSON.parse(fs.readFileSync(path));config.postCreateCommand="npm ci --ignore-scripts --no-audit --no-fund";fs.writeFileSync(path,JSON.stringify(config));fs.writeFileSync(process.argv[2],"const total: string = 42;\\nMath.\\n");`,
      `${sourceWorkspace}/.devcontainer/devcontainer.json`,
      `${sourceWorkspace}/src/language.ts`,
    ]);
  }
  await inner(["chown", "-R", "0:0", sourceWorkspace]);
  await inner([
    "sh",
    "-c",
    'git init --initial-branch=main "$1" && git -C "$1" add . && git -C "$1" -c user.name=Factory -c user.email=factory@example.invalid commit -m fixture',
    "factory-git",
    sourceWorkspace,
  ]);
  const control = await runConnectorControl();
  try {
    const assignment = {
      version: 1,
      runtimeAttemptId: connectorAttempt,
      generation: connectorGeneration,
      workspaceFolder: workspace,
      remoteWorkspaceFolder: "/workspace/project",
      repositoryUrl: `file://${sourceWorkspace}`,
      repositoryIdentity: "runtime-conformance",
      preserveWorkspace: false,
      revision: "main",
      devcontainerPath: ".devcontainer/devcontainer.json",
      composeProjectName: composeProject,
      controlUrl: `ws://${process.env["FACTORY_RUNTIME_HOST"] || "host.orb.internal"}:${control.port}/runtime/connect`,
      channels: [
        {
          name: "app",
          kind: "app",
          target: "http://127.0.0.1:4300",
          healthPath: "/health",
        },
        ...(languageProof ? [{ name: "ide", kind: "ide", target: "", healthPath: "" }] : []),
      ],
      processes: [
        {
          name: "app",
          command: ["node", "/workspace/project/src/server.mjs"],
        },
      ],
      connectorStateDir: "/home/coder/connector-state",
    };
    await inner([
      "sh",
      "-c",
      "rm -rf /home/coder/connector-state && mkdir -m 700 /home/coder/connector-state",
    ]);
    await inner([
      "sh",
      "-c",
      "printf '%s' \"$1\" > /home/coder/runtime-assignment.json",
      "factory-assignment",
      JSON.stringify(assignment),
    ]);
    await inner([
      "sh",
      "-c",
      "printf '%s' \"$1\" > /home/coder/parent-token && printf '%s' \"$2\" > /home/coder/child-token && chmod 0400 /home/coder/parent-token /home/coder/child-token",
      "factory-tokens",
      connectorToken,
      childConnectorToken,
    ]);
    // Do not spend the native execution deadline writing the fixture's assignment
    // and credentials through kubectl. It starts with the actual parent command.
    control.begin();
    const parent = inner([
      connectorBinary,
      "parent",
      "--assignment",
      "/home/coder/runtime-assignment.json",
      "--token-file",
      "/home/coder/parent-token",
      "--child-token-file",
      "/home/coder/child-token",
    ]);
    await Promise.all([parent, control.completed]);
  } finally {
    control.dispose();
    await cleanupInnerStack();
  }
  const state = JSON.parse(
    await inner([
      "cat",
      `/home/coder/connector-state/${connectorAttempt}-${connectorGeneration}.json`,
    ]),
  ) as { runtimeAttemptId: string; generation: number; composeProjectName: string };
  assert(
    state.runtimeAttemptId === connectorAttempt,
    "Connector persisted the wrong attempt identity",
  );
  assert(state.generation === connectorGeneration, "Connector persisted the wrong generation");
  assert(
    state.composeProjectName === composeProject,
    "Connector persisted the wrong Compose identity",
  );
  await assertNoInnerStack();
}

async function verifyUnsafeMountRejected() {
  await cleanupInnerStack();
  await inner(["rm", "-rf", workspace, sourceWorkspace]);
  await stageFixture(sourceWorkspace);
  await inner(["chown", "-R", "0:0", sourceWorkspace]);
  await inner([
    "sh",
    "-c",
    'git init --initial-branch=main "$1" && git -C "$1" add . && git -C "$1" -c user.name=Factory -c user.email=factory@example.invalid commit -m fixture',
    "factory-git",
    sourceWorkspace,
  ]);
  let failed = "";
  const result = Promise.withResolvers<void>();
  const server = Bun.serve<{ role: string }>({
    hostname: "0.0.0.0",
    port: 0,
    fetch(request, server) {
      const role = request.headers.get("x-factory-connector-role");
      if (
        !server.upgrade(request, {
          data: { role: role ?? "" },
          headers: { "sec-websocket-protocol": "factory-runtime-connector-v1" },
        })
      ) {
        return new Response("upgrade failed", { status: 500 });
      }
      return undefined;
    },
    websocket: {
      message(_, raw) {
        const message = JSON.parse(String(raw)) as ConnectorMessage;
        if (message.type === "status" && message.phase === "failed") {
          failed = message.error ?? "";
          result.resolve();
        }
      },
    },
  });
  const assignment = {
    version: 1,
    runtimeAttemptId: "unsafe-conformance",
    generation: 1,
    workspaceFolder: workspace,
    remoteWorkspaceFolder: "/workspace/project",
    repositoryUrl: `file://${sourceWorkspace}`,
    repositoryIdentity: "unsafe-conformance",
    preserveWorkspace: false,
    revision: "main",
    devcontainerPath: "unsafe.devcontainer.json",
    composeProjectName: composeProject,
    controlUrl: `ws://${process.env["FACTORY_RUNTIME_HOST"] || "host.orb.internal"}:${server.port}/runtime/connect`,
    channels: [
      { name: "app", kind: "app", target: "http://127.0.0.1:4300", healthPath: "/health" },
    ],
    processes: [],
  };
  await inner([
    "sh",
    "-c",
    "printf '%s' \"$1\" > /home/coder/unsafe-assignment.json",
    "factory-assignment",
    JSON.stringify(assignment),
  ]);
  await inner([
    "sh",
    "-c",
    "printf '%s' \"$1\" > /home/coder/unsafe-parent-token && printf '%s' \"$2\" > /home/coder/unsafe-child-token && chmod 0400 /home/coder/unsafe-parent-token /home/coder/unsafe-child-token",
    "factory-tokens",
    connectorToken,
    childConnectorToken,
  ]);
  const parent = inner([
    connectorBinary,
    "parent",
    "--assignment",
    "/home/coder/unsafe-assignment.json",
    "--token-file",
    "/home/coder/unsafe-parent-token",
    "--child-token-file",
    "/home/coder/unsafe-child-token",
  ]).catch(() => undefined);
  await Promise.race([
    result.promise,
    Bun.sleep(30_000).then(() => {
      throw new Error("Unsafe Dev Container preflight did not fail");
    }),
  ]);
  await parent;
  server.stop(true);
  assert(
    failed.includes("forbidden infrastructure path") ||
      failed.includes("bind mount leaves the assigned checkout"),
    `Unexpected preflight error: ${failed}`,
  );
  const resources = await innerDocker([
    "ps",
    "-aq",
    "--filter",
    "label=factory.dev/runtime-attempt=unsafe-conformance",
  ]);
  assert(resources === "", "Unsafe Dev Container created inner resources before rejection");
}

async function verifyPythonLanguageConnector() {
  const attempt = "python-language-conformance";
  const source = `${sourceWorkspace}-python`;
  const target = `${workspace}-python`;
  const text = "from fixture_amount import amount\nwrong: str = amount()\namount().\n";
  await stageFixture(source);
  await inner([
    "node",
    "-e",
    `const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({name:"Python language proof",build:{dockerfile:"python.Dockerfile"},remoteUser:"node",updateRemoteUserUID:false,workspaceFolder:"/workspace/project",workspaceMount:"source=\${localWorkspaceFolder},target=/workspace/project,type=bind",runArgs:["--cap-drop=ALL"]}));fs.writeFileSync(process.argv[2],process.argv[3]);`,
    `${source}/.devcontainer/devcontainer.json`,
    `${source}/src/language.py`,
    text,
  ]);
  await inner(["chown", "-R", "0:0", source]);
  await inner([
    "sh",
    "-ec",
    'git init --initial-branch=main "$1";git -C "$1" add .;git -C "$1" -c user.name=Factory -c user.email=factory@example.invalid commit -m python-fixture',
    "python-fixture",
    source,
  ]);
  let parent: ServerWebSocket<{ role: string }> | undefined;
  let semantic = false,
    completion = false,
    definitionRequested = false,
    inspected = false;
  const complete = Promise.withResolvers<void>();
  const uri = `factory-workspace://${owner}/src/language.py`;
  const server = Bun.serve<{ role: string }>({
    hostname: "0.0.0.0",
    port: 0,
    fetch(request, server) {
      const role = request.headers.get("x-factory-connector-role");
      const token = request.headers.get("authorization");
      if (
        request.headers.get("x-factory-runtime-attempt") !== attempt ||
        request.headers.get("x-factory-runtime-generation") !== "1" ||
        (role !== "parent" && role !== "child") ||
        token !== `Bearer ${role === "parent" ? connectorToken : childConnectorToken}`
      )
        return new Response(null, { status: 403 });
      if (
        server.upgrade(request, {
          data: { role },
          headers: { "sec-websocket-protocol": "factory-runtime-connector-v1" },
        })
      )
        return;
      return new Response(null, { status: 500 });
    },
    websocket: {
      open(socket) {
        if (socket.data.role === "parent") parent = socket;
      },
      message(socket, raw) {
        const message = JSON.parse(String(raw)) as ConnectorMessage;
        const send = (value: object) =>
          writeConnectorMessage(socket, {
            type: "websocket-message",
            streamId: "python-language",
            messageType: 1,
            data: Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...value })).toString("base64"),
          });
        if (message.type === "hello" && message.role === "child") {
          writeConnectorMessage(socket, {
            type: "websocket-open",
            streamId: "python-language",
            channel: "language",
            path: `/python/${owner}`,
          });
        } else if (message.type === "websocket-ready" && message.streamId === "python-language") {
          send({
            id: 1,
            method: "initialize",
            params: {
              rootUri: `factory-workspace://${owner}/`,
              capabilities: {
                textDocument: {
                  publishDiagnostics: {},
                  completion: { completionItem: { snippetSupport: false } },
                  definition: { linkSupport: true },
                },
                workspace: { configuration: true },
              },
            },
          });
        } else if (
          message.type === "websocket-message" &&
          message.streamId === "python-language" &&
          message.data
        ) {
          const result = JSON.parse(Buffer.from(message.data, "base64").toString()) as {
            id?: number;
            error?: unknown;
            method?: string;
            result?:
              | {
                  items?: Array<{ label: string }>;
                  text?: string;
                  targetUri?: string;
                  uri?: string;
                }
              | Array<{ targetUri?: string; uri?: string }>;
            params?: { diagnostics?: Array<{ code?: string }> };
          };
          if (result.error) {
            complete.reject(
              new Error(`Native Python response failed: ${JSON.stringify(result.error)}`),
            );
            return;
          }
          if (result.id === 1) {
            send({ method: "initialized", params: {} });
            send({
              method: "textDocument/didOpen",
              params: { textDocument: { uri, languageId: "python", version: 1, text } },
            });
            send({
              id: 2,
              method: "textDocument/completion",
              params: { textDocument: { uri }, position: { line: 2, character: 9 } },
            });
          } else if (result.id === 2 && !Array.isArray(result.result)) {
            completion = result.result?.items?.some((item) => item.label === "bit_length") ?? false;
            if (!completion)
              complete.reject(new Error("Native Python dependency completion is missing"));
          } else if (result.method === "textDocument/publishDiagnostics") {
            semantic ||=
              result.params?.diagnostics?.some((item) => item.code === "reportAssignmentType") ??
              false;
          } else if (result.id === 3) {
            const location = Array.isArray(result.result) ? result.result[0] : result.result;
            const dependency = location?.targetUri ?? location?.uri;
            if (
              !dependency?.startsWith(
                `factory-language://${owner}/${attempt}/python/opt/project-venv/`,
              )
            ) {
              complete.reject(
                new Error("Native Python definition did not use its exact runtime environment"),
              );
              return;
            }
            send({ id: 4, method: "factory/readDocument", params: { uri: dependency } });
          } else if (result.id === 4 && !Array.isArray(result.result)) {
            inspected = result.result?.text?.includes("return 17") ?? false;
            if (!inspected) {
              complete.reject(new Error("Native Python dependency document is missing"));
              return;
            }
            if (!parent) {
              complete.reject(new Error("Native Python parent is not connected"));
              return;
            }
            writeConnectorMessage(parent, { type: "stop" });
          }
          if (semantic && completion && !definitionRequested) {
            definitionRequested = true;
            send({
              id: 3,
              method: "textDocument/definition",
              params: { textDocument: { uri }, position: { line: 0, character: 30 } },
            });
          }
        } else if (message.type === "status" && message.phase === "stopped") {
          if (semantic && completion && inspected) complete.resolve();
          else complete.reject(new Error("Native Python stopped before its language proof"));
        } else if (
          message.type === "stream-error" ||
          (message.type === "status" && ["failed", "cleanup-failed"].includes(message.phase ?? ""))
        ) {
          complete.reject(new Error(message.error ?? "Native Python runtime failed"));
        }
      },
    },
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const assignment = {
      version: 1,
      runtimeAttemptId: attempt,
      generation: 1,
      workspaceFolder: target,
      remoteWorkspaceFolder: "/workspace/project",
      repositoryUrl: `file://${source}`,
      repositoryIdentity: attempt,
      preserveWorkspace: false,
      revision: "main",
      devcontainerPath: ".devcontainer/devcontainer.json",
      composeProjectName: attempt,
      controlUrl: `ws://${process.env["FACTORY_RUNTIME_HOST"] || "host.orb.internal"}:${server.port}/runtime/connect`,
      channels: [{ name: "ide", kind: "ide", target: "", healthPath: "" }],
      processes: [],
      connectorStateDir: "/home/coder/python-connector-state",
    };
    await inner([
      "sh",
      "-ec",
      'mkdir -p /home/coder/python-connector-state;printf "%s" "$1" > /home/coder/python-assignment.json;printf "%s" "$2" > /home/coder/python-parent-token;printf "%s" "$3" > /home/coder/python-child-token;chmod 0400 /home/coder/python-parent-token /home/coder/python-child-token',
      "python-assignment",
      JSON.stringify(assignment),
      connectorToken,
      childConnectorToken,
    ]);
    // Python adds a cold project image build. Use the same preparation bound as
    // the editor's explicit compute command, not a work/spending budget.
    timeout = setTimeout(
      () => complete.reject(new Error("Native Python preparation or language proof timed out")),
      300_000,
    );
    await Promise.all([
      inner([
        connectorBinary,
        "parent",
        "--assignment",
        "/home/coder/python-assignment.json",
        "--token-file",
        "/home/coder/python-parent-token",
        "--child-token-file",
        "/home/coder/python-child-token",
      ]),
      complete.promise,
    ]);
    assert(
      !(await innerDocker([
        "ps",
        "-aq",
        "--filter",
        `label=factory.dev/runtime-attempt=${attempt}`,
      ])),
      "Native Python compute was not cleaned after Stop",
    );
    console.log("Native Python Dev Container passed", { completion, semantic, inspected });
  } finally {
    if (timeout) clearTimeout(timeout);
    server.stop(true);
  }
}

async function main() {
  console.log("Checking Factorybox and private Sysbox/Docker boundary");
  await verifyRuntimeBoundary();
  await cleanupInnerStack();
  await stageFixture();
  try {
    console.log("Starting the maintained two-service Dev Container fixture");
    const first = await devcontainerUp();
    await verifyStack(first);
    await verifyAppAndHotUpdate(first.containerId);
    console.log("Restarting the stack and checking named-volume persistence");
    const restarted = await verifyVolumeSurvivesRestart();
    await verifyStack(restarted);
    const metricsBefore = await runtime.metrics();
    assert(
      metricsBefore.status === "available" && metricsBefore.memoryMiB !== null,
      "Native per-Sandbox cgroup memory observation is unavailable",
    );
    await Bun.sleep(5100);
    const metricsAfter = await runtime.metrics();
    assert(
      metricsAfter.status === "available" &&
        metricsAfter.cpuMilli !== null &&
        metricsAfter.cpuMilli > 0,
      "Native per-Sandbox CPU delta is unavailable",
    );
    await writeFile(
      resolve(artifacts, "sandbox-metrics.json"),
      JSON.stringify({ before: metricsBefore, after: metricsAfter }, null, 2),
    );
    const before = await innerDocker(["ps", "--no-trunc", "--format", "{{.ID}}"]);
    await runtime.pauseResume();
    assert(
      (await innerDocker(["ps", "--no-trunc", "--format", "{{.ID}}"])) === before,
      "Native cluster Resume replaced the running Dev Containers",
    );
    await verifyStack(restarted);
  } finally {
    await cleanupInnerStack();
  }
  await assertNoInnerStack();
  console.log("Running the Factory parent and child Runtime Connector");
  await verifyConnector();
  if (languageProof) {
    console.log(
      "Running Python language tools in their actual Dev Container and virtual environment",
    );
    await verifyPythonLanguageConnector();
  }
  console.log("Rejecting an unsafe outer-host bind mount before Docker create");
  await verifyUnsafeMountRejected();
  console.log("Runtime workload checks passed; owned worker/store cleanup is still required", {
    languageProof,
  });
}

try {
  await prepareSmokeRuntime();
  await main();
  await runtime.passed();
} catch (cause) {
  const diagnostics = await runCommand(
    kubernetesCommand(["logs", "-n", namespace, pod, "--tail=100"]),
    undefined,
    { timeoutMS: 15_000, outputBytes: 1 << 20 },
  ).catch(() => null);
  await mkdir(artifacts, { recursive: true });
  await writeFile(
    resolve(artifacts, "failure.json"),
    JSON.stringify(
      {
        owner,
        pod,
        image: expectedRuntimeHost,
        error: cause instanceof Error ? cause.message : "Conformance failed",
        logs: diagnostics ? `${diagnostics.stdout}\n${diagnostics.stderr}` : null,
      },
      null,
      2,
    ),
  );
  throw cause;
} finally {
  await removeSmokeRuntime();
}
await writeFile(
  resolve(artifacts, "result.json"),
  JSON.stringify(
    {
      owner,
      pod,
      namespace,
      image: expectedRuntimeHost,
      languageProof,
      passed: true,
      cleanup: true,
    },
    null,
    2,
  ),
);
console.log("Runtime conformance passed with confirmed owned worker/store cleanup", {
  languageProof,
});
