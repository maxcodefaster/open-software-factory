// Runs inside the primary Dev Container. The upstream runner stays unmodified;
// its failure must terminate the Factory-owned managed process, not leave a healthy shell.
export const verificationSupervisor = `
const { spawn } = require("node:child_process");
const { openSync } = require("node:fs");
const directory = require("node:os").homedir() + "/.factory-runner/";
const log = openSync(directory + "runner.log", "a", 0o600);
const runner = spawn("/opt/factory/forgejo-runner", ["one-job", "--wait", ...(process.env.FACTORY_RUNNER_HANDLE ? ["--handle", process.env.FACTORY_RUNNER_HANDLE] : []), "--config", directory + "config.yml"], {
  stdio: ["ignore", log, log],
});
let healthy = false;
const server = require("node:http").createServer((request, response) => {
  response.writeHead(request.url === "/health" ? (healthy ? 200 : 503) : 404);
  response.end();
});
function fail() {
  healthy = false;
  console.error("Verification runner failed; inspect its runtime log");
  runner.kill();
  server.close(() => process.exit(1));
}
runner.once("spawn", () => { healthy = true; });
runner.once("error", fail);
runner.once("exit", code => {
  if (code !== 0) fail();
  // A completed one-job runner keeps the channel until Factory records the exact verdict and Stops.
});
server.once("error", fail);
server.listen(4500, "127.0.0.1");
`;

export interface RuntimeVerification {
  readonly forgeURL: string;
  readonly runnerUUID: string;
  readonly runnerToken: string;
  readonly runnerLabel: string;
  readonly handle?: string;
  readonly publication?: {
    id: string;
    version: string;
    credentialURL: string;
    credentialToken: string;
    registryURL?: string;
  };
}

// The same pinned one-job owner is used by both concrete runtime adapters.
export function runtimeVerificationProcess(input: RuntimeVerification) {
  const publication = input.publication;
  const publicationEnvironment = publication
    ? {
        FACTORY_RELEASE_ID: publication.id,
        FACTORY_RELEASE_VERSION: publication.version,
        FACTORY_RELEASE_SOURCE: "/workspace/project",
        FACTORY_RELEASE_CREDENTIAL_URL: publication.credentialURL,
        FACTORY_RELEASE_CREDENTIAL_TOKEN: publication.credentialToken,
        FACTORY_RELEASE_REGISTRY: new URL(publication.registryURL ?? input.forgeURL).host,
        FACTORY_RELEASE_REGISTRY_URL: new URL(publication.registryURL ?? input.forgeURL).origin,
      }
    : {};
  return {
    name: "verification",
    command: [
      "sh",
      "-c",
      `umask 077; mkdir -p "$HOME/.factory-runner"; printf %s "$FACTORY_RUNNER_CONFIG" > "$HOME/.factory-runner/config.yml"; exec node -e '${verificationSupervisor}'`,
    ],
    env: {
      ...(input.handle ? { FACTORY_RUNNER_HANDLE: input.handle } : {}),
      ...publicationEnvironment,
      FACTORY_RUNNER_CONFIG: [
        "log:",
        "  level: info",
        "  job_level: info",
        "runner:",
        "  capacity: 1",
        "  timeout: 30m",
        "  shutdown_timeout: 1m",
        ...(publication
          ? [
              "  envs:",
              ...Object.entries(publicationEnvironment).map(
                ([key, value]) => `    ${key}: ${JSON.stringify(value)}`,
              ),
            ]
          : []),
        "cache:",
        "  enabled: false",
        "host:",
        "  workdir_parent: /tmp/factory-actions",
        "server:",
        "  connections:",
        "    factory:",
        `      url: ${input.forgeURL}`,
        `      uuid: ${input.runnerUUID}`,
        `      token: ${input.runnerToken}`,
        "      fetch_interval: 1s",
        "      labels:",
        `        - ${input.runnerLabel}:host`,
        ...(publication ? [`        - factory-release-${publication.id}:host`] : []),
        "",
      ].join("\n"),
    },
  };
}
