import { resolve } from "node:path";
import { runCommand } from "../../packages/runtime-kubernetes/src/command";
import upstream from "../../upstream.json";

// The host check cannot cover *_linux.go on macOS. Build/race/vet the same source
// on Linux with a digest-pinned Go image containing its native C compiler.
// AllThreadsSyscall intentionally rejects CGO binaries. Its irreversible credential
// transition is proved separately using the same CGO=0 mode as shipped Source.
const owner = crypto.randomUUID();
const name = `factory-connector-check-${owner}`;
const label = "factory.connector-check";
let child: ReturnType<typeof Bun.spawn> | undefined;
let interrupted: number | undefined;
let cleanupPromise: Promise<void> | undefined;
const cleanupOnce = () => (cleanupPromise ??= cleanup());
const interrupt = (code: number) => {
  interrupted ??= code;
  // Terminating `docker run` alone can leave its daemon-owned container alive.
  // Remove only this invocation's label-verified resources, then reap the CLI.
  if (child) {
    void cleanupOnce()
      .catch((cause: unknown) => console.error(cause))
      .finally(() => {
        if (child?.exitCode === null) child.kill("SIGKILL");
      });
  }
};
const onInterrupt = () => interrupt(130);
const onTerminate = () => interrupt(143);
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onTerminate);
console.info(`Owned Connector Linux fixture: ${name}`);
let networkCreated = false;
async function cleanup() {
  const container = await runCommand([
    "docker",
    "inspect",
    "--format",
    `{{index .Config.Labels "${label}"}}`,
    name,
  ]);
  if (container.exitCode === 0) {
    if (container.stdout.trim() !== owner)
      throw new Error("Connector test container ownership changed");
    const removed = await runCommand(["docker", "rm", "--force", name]);
    if (removed.exitCode !== 0)
      throw new Error("Owned Connector test container cleanup is unconfirmed");
  }
  if (!networkCreated) return;
  const network = await runCommand([
    "docker",
    "network",
    "inspect",
    "--format",
    `{{index .Labels "${label}"}}`,
    name,
  ]);
  if (network.exitCode !== 0 || network.stdout.trim() !== owner)
    throw new Error("Connector test network ownership is unconfirmed");
  const removed = await runCommand(["docker", "network", "rm", name]);
  if (removed.exitCode !== 0)
    throw new Error("Owned Connector test network cleanup is unconfirmed");
}
try {
  const created = await runCommand([
    "docker",
    "network",
    "create",
    "--label",
    `${label}=${owner}`,
    name,
  ]);
  if (created.exitCode !== 0)
    throw new Error("Owned Connector test network creation is unconfirmed");
  networkCreated = true;
  if (interrupted === undefined)
    child = Bun.spawn(
      [
        "docker",
        "run",
        "--rm",
        "--name",
        name,
        "--label",
        `${label}=${owner}`,
        "--network",
        name,
        "--cpus",
        "3",
        "--memory",
        "3g",
        "--read-only",
        "--tmpfs",
        "/tmp:exec,size=2g",
        "--tmpfs",
        "/go:size=2g",
        "--mount",
        `type=bind,src=${resolve("services/runtime-connector")},dst=/source,readonly`,
        "--mount",
        `type=bind,src=${resolve("templates/starter-app")},dst=/templates/starter-app,readonly`,
        "--workdir",
        "/source",
        "--env",
        "GOCACHE=/tmp/go-build",
        "--env",
        "CGO_ENABLED=1",
        "--env",
        "FACTORY_STARTER_TEMPLATE_DIRECTORY=/templates/starter-app",
        upstream.go.testImage,
        "sh",
        "-ec",
        "go test -p 2 -race -skip '^TestSourceServingPermanentlyDropsInitializerPrivileges$' ./... && CGO_ENABLED=0 go test -p 2 ./workspacefiles -run '^TestSourceServingPermanentlyDropsInitializerPrivileges$' -count=1 && go vet -p 2 ./...",
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
  const exitCode = child ? await child.exited : 0;
  process.exitCode = interrupted ?? exitCode;
} finally {
  await cleanupOnce().catch((cause: unknown) => {
    console.error(cause);
    process.exitCode = 1;
  });
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onTerminate);
}
