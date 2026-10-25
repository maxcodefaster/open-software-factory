// Runs inside the primary Dev Container. The upstream runner stays unmodified;
// its failure must terminate the Factory-owned managed process, not leave a healthy shell.
export const verificationSupervisor = String.raw`
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
