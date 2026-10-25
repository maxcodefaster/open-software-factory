// Copy to the Project's .factory/publish.mjs and adapt its build to the application.
// Never print credentials or use shell tracing in this script.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const version = process.env.FACTORY_RELEASE_VERSION;
const registry = process.env.FACTORY_RELEASE_REGISTRY;
const owner = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "") || !registry || !/^[a-z0-9-]+$/.test(owner ?? ""))
  throw new Error("An admitted Factory publication is required");
const directory = mkdtempSync(join(tmpdir(), "factory-publish-"));
process.env.DOCKER_CONFIG = join(directory, "docker");
process.env.HELM_REGISTRY_CONFIG = join(directory, "helm-registry.json");
function run(command, args, input) {
  const result = spawnSync(command, args, {
    stdio: input ? ["pipe", "inherit", "inherit"] : "inherit",
    input,
    env: process.env,
  });
  if (result.error || result.status !== 0) throw new Error(`${command} failed`);
}
try {
  // The server checks the native running task's run number, source SHA and job handle
  // before issuing package rights. A runner label is not sufficient.
  const response = await fetch(process.env.FACTORY_RELEASE_CREDENTIAL_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.FACTORY_RELEASE_CREDENTIAL_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("Publication authority was not confirmed");
  const credential = await response.json();
  run(
    "docker",
    ["login", registry, "--username", credential.username, "--password-stdin"],
    `${credential.token}\n`,
  );
  run(
    "helm",
    ["registry", "login", registry, "--username", credential.username, "--password-stdin"],
    `${credential.token}\n`,
  );
  const image = `${registry}/${owner}/web`;
  run("docker", ["build", "--tag", `${image}:${version}`, "."]);
  run("docker", ["push", `${image}:${version}`]);
  // Read the actual OCI content identity rather than infer it from a tag.
  const root = process.env.FACTORY_RELEASE_REGISTRY_URL;
  const authentication = await fetch(
    `${root}/v2/token?service=container_registry&scope=${encodeURIComponent(`repository:${owner}/web:pull`)}`,
    {
      headers: {
        authorization: `Basic ${Buffer.from(`${credential.username}:${credential.token}`).toString("base64")}`,
      },
    },
  );
  if (!authentication.ok) throw new Error("Registry readback authentication failed");
  const token = (await authentication.json()).token;
  const manifest = await fetch(`${root}/v2/${owner}/web/manifests/${version}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept:
        "application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json",
    },
  });
  const digest = manifest.headers.get("docker-content-digest");
  if (!manifest.ok || !/^sha256:[a-f0-9]{64}$/.test(digest ?? ""))
    throw new Error("Image digest was not confirmed");
  await manifest.body?.cancel();
  const chart = join(directory, "app");
  cpSync("deploy/chart", chart, { recursive: true });
  // This example chart has JSON-compatible values. Adapt this to the Project's chart.
  const values = JSON.parse(readFileSync(join(chart, "values.yaml"), "utf8"));
  values.image = { repository: image, digest };
  writeFileSync(join(chart, "values.yaml"), JSON.stringify(values), { mode: 0o600 });
  run("helm", ["lint", chart]);
  run("helm", ["template", "release-check", chart]);
  run("helm", [
    "package",
    chart,
    "--version",
    version,
    "--app-version",
    version,
    "--destination",
    directory,
  ]);
  // The consumable chart version is published last. Images already exist by digest.
  run("helm", ["push", join(directory, `app-${version}.tgz`), `oci://${registry}/${owner}`]);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
