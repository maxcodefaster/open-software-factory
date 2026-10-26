import { resolve } from "node:path";
import upstream from "../../upstream.json";
import { runCommand } from "../../packages/runtime-kubernetes/src/command";

// The host check cannot cover *_linux.go on macOS. Build/race/vet the same source
// on Linux with a digest-pinned Go image containing its native C compiler.
// AllThreadsSyscall intentionally rejects CGO binaries. Its irreversible credential
// transition is proved separately using the same CGO=0 mode as shipped Source.
const owner = crypto.randomUUID();
const name = `factory-connector-check-${owner}`;
const label = "factory.connector-check";
console.info(`Owned Connector Linux fixture: ${name}`);
const created = await runCommand([
  "docker",
  "network",
  "create",
  "--label",
  `${label}=${owner}`,
  name,
]);
if (created.exitCode !== 0) throw new Error("Owned Connector test network creation is unconfirmed");
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
  const child = Bun.spawn(
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
      "--workdir",
      "/source",
      "--env",
      "GOCACHE=/tmp/go-build",
      "--env",
      "CGO_ENABLED=1",
      upstream.go.testImage,
      "sh",
      "-ec",
      "go test -race -skip '^TestSourceServingPermanentlyDropsInitializerPrivileges$' ./... && CGO_ENABLED=0 go test ./workspacefiles -run '^TestSourceServingPermanentlyDropsInitializerPrivileges$' -count=1 && go vet ./...",
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  process.exitCode = await child.exited;
} finally {
  await cleanup().catch((cause: unknown) => {
    console.error(cause);
    process.exitCode = 1;
  });
}
