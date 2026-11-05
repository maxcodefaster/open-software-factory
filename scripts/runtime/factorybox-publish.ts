import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";

// Publishes one locally built Factorybox worker image. It refuses anything the
// native conformance did not pass for exactly these bytes, and only then pushes,
// signs and records the digest that Factory installations pin.

export const cosignImage =
  "ghcr.io/sigstore/cosign/cosign:v2.5.3@sha256:f1946d0f30fc8e3777b02f2201e02efdba9fe38f4918162f937052fac98e083f";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const imageReference = z.string().regex(/^[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/);
// The result.json that `bun run factorybox:build` writes.
export const workerBuild = z.object({
  passed: z.literal(true),
  architecture: z.enum(["arm64", "amd64"]),
  workerBuild: z.string(),
  image: imageReference,
  executableSHA256: digest,
});
export const conformanceReceipt = z.object({
  passed: z.literal(true),
  cleanup: z.literal(true),
  passedAt: z.string(),
  worker: z.object({
    image: z.string(),
    executableSHA256: digest,
    architecture: z.enum(["arm64", "amd64"]),
    node: z.string(),
  }),
});

/** The conformance must have run these exact bytes on this architecture. */
export function verifyPublishInputs(build: unknown, receipt: unknown) {
  const worker = workerBuild.parse(build);
  const proof = conformanceReceipt.parse(receipt);
  const architecture = worker.architecture;
  if (proof.worker.image !== worker.image)
    throw new Error("The conformance ran a different image than this build");
  if (proof.worker.executableSHA256 !== worker.executableSHA256)
    throw new Error("The conformance ran a different executable than this build");
  if (proof.worker.architecture !== architecture)
    throw new Error("The conformance ran on another architecture than this build");
  return { worker, proof, architecture };
}

async function readJSON(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function run(command: string[], options: { quiet?: boolean } = {}) {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(`${command.slice(0, 3).join(" ")} failed: ${stderr.trim().slice(-400)}`);
  if (!options.quiet) process.stdout.write(stdout);
  return stdout;
}

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
  const buildFile = option("--build");
  const conformanceFile = option("--conformance");
  const repository = option("--repository");
  const tag = option("--tag");
  const keyFile = option("--cosign-key");
  const dryRun = process.argv.includes("--dry-run");
  if (!buildFile || !conformanceFile || !repository || !tag || (!keyFile && !dryRun))
    throw new Error(
      "Usage: factorybox-publish --build result.json --conformance result.json --repository ghcr.io/OWNER/factorybox-worker --tag v0.1.0-beta.1 --cosign-key cosign.key [--dry-run]",
    );
  const { worker, proof } = verifyPublishInputs(
    await readJSON(buildFile),
    await readJSON(conformanceFile),
  );
  console.log(
    `Conformance passed ${proof.passedAt} on ${proof.worker.node} for ${worker.image}; executable ${worker.executableSHA256}`,
  );
  if (dryRun) {
    console.log("Dry run: nothing was pushed or signed.");
    process.exit(0);
  }
  await run(["docker", "tag", worker.image.split("@")[0] ?? worker.image, `${repository}:${tag}`], {
    quiet: true,
  });
  const pushed = await run(["docker", "push", `${repository}:${tag}`], { quiet: true });
  const pushedDigest = /digest: (sha256:[a-f0-9]{64})/.exec(pushed)?.[1];
  if (!pushedDigest) throw new Error("The registry did not report a digest");
  const reference = `${repository}@${pushedDigest}`;
  // The container cannot reach a host credential helper, so it gets a one-off Docker config that
  // holds only the registry login named by REGISTRY_USERNAME and REGISTRY_TOKEN. It lives under the
  // home directory because Docker on macOS shares that tree with its containers.
  const username = process.env["REGISTRY_USERNAME"];
  const token = process.env["REGISTRY_TOKEN"];
  if (!username || !token) throw new Error("Set REGISTRY_USERNAME and REGISTRY_TOKEN to sign");
  const dockerConfig = await mkdtemp(resolve(homedir(), ".factorybox-sign-"));
  try {
    await writeFile(
      resolve(dockerConfig, "config.json"),
      JSON.stringify({
        auths: {
          [repository.split("/")[0] as string]: {
            auth: Buffer.from(`${username}:${token}`).toString("base64"),
          },
        },
      }),
    );
    await run([
      "docker",
      "run",
      "--rm",
      "--network",
      "host",
      "-v",
      `${resolve(keyFile as string)}:/cosign.key:ro`,
      "-v",
      `${dockerConfig}:/dockerconfig:ro`,
      "-e",
      "DOCKER_CONFIG=/dockerconfig",
      "-e",
      "COSIGN_PASSWORD",
      cosignImage,
      "sign",
      "--yes",
      "--key",
      "/cosign.key",
      "--annotations",
      `executable-sha256=${worker.executableSHA256}`,
      reference,
    ]);
  } finally {
    await rm(dockerConfig, { recursive: true, force: true });
  }
  const release = {
    schema: 1,
    image: reference,
    executableSHA256: worker.executableSHA256,
    architecture: worker.architecture,
    tag,
    conformancePassedAt: proof.passedAt,
    conformedOn: proof.worker.node,
    signedAt: new Date().toISOString(),
  };
  const directory = resolve(import.meta.dir, "../../deploy/factorybox");
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
  console.log(`Published and signed ${reference}\nRecorded deploy/factorybox/release.json`);
}
