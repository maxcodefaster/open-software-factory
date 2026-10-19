import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kubernetesCommand } from "../../packages/runtime-kubernetes/src/config";
import { runtimeArtifactsSchema } from "./artifacts";
import { requirePinnedImage } from "./preflight";
import { waitForRegistry } from "./registry-readiness";

const namespace = "open-factory-envbox-smoke";
const localRegistry = `registry.${namespace}.svc.cluster.local:5000`;
const acceptedManifests = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

async function observe(args: string[], timeoutMS = 15_000) {
  const child = Bun.spawn(args, {
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMS);
  try {
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { text, code };
  } finally {
    clearTimeout(timeout);
  }
}

function requireImageManifest(name: string, body: string) {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error(`${name} artifact returned an invalid image manifest`);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 2 ||
    !(
      ("manifests" in value && Array.isArray(value.manifests)) ||
      ("config" in value &&
        typeof value.config === "object" &&
        value.config !== null &&
        "layers" in value &&
        Array.isArray(value.layers))
    )
  )
    throw new Error(`${name} artifact returned an invalid image manifest`);
}

// Read a manifest, never pull an image or alter the daemon's cache. A successful
// /v2/ probe and a syntactically valid digest file do not establish availability.
export async function inspectRegistryArtifact(input: {
  name: string;
  reference: string;
  origin: string;
  caFile?: string;
  timeoutMS?: number;
}) {
  requirePinnedImage(input.reference);
  const origin = new URL(input.origin);
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    (origin.protocol !== "https:" &&
      !(origin.protocol === "http:" && origin.hostname === "127.0.0.1"))
  )
    throw new Error("Registry observation requires HTTPS or a loopback test endpoint");
  const separator = input.reference.indexOf("@");
  const repository = input.reference
    .slice(input.reference.indexOf("/") + 1, separator)
    .replace(/:[^/]+$/, "");
  const digest = input.reference.slice(separator + 1);
  const directory = await mkdtemp(join(tmpdir(), "factory-manifest-"));
  const manifestFile = join(directory, "manifest.json");
  try {
    const timeoutMS = input.timeoutMS ?? 10_000;
    const { text, code } = await observe(
      [
        "curl",
        "--silent",
        "--connect-timeout",
        String(Math.min(timeoutMS, 3_000) / 1_000),
        "--max-time",
        String(timeoutMS / 1_000),
        ...(input.caFile ? ["--cacert", input.caFile] : []),
        "--header",
        `Accept: ${acceptedManifests}`,
        "--output",
        manifestFile,
        "--write-out",
        "%{http_code}",
        `${origin.origin}/v2/${repository}/manifests/${digest}`,
      ],
      timeoutMS + 1_000,
    );
    if (code !== 0)
      throw new Error(
        `${input.name} artifact Registry request failed${code === 60 ? "; check approved CA trust" : ""}. Saved pins are unchanged.`,
      );
    if (text !== "200")
      throw new Error(
        `${input.name} artifact is unavailable (Registry HTTP ${text}). Publish or restore this exact artifact before startup. Saved pins are unchanged.`,
      );
    const manifest = await readFile(manifestFile);
    if (`sha256:${createHash("sha256").update(manifest).digest("hex")}` !== digest)
      throw new Error(`${input.name} artifact manifest digest differs from its approved pin`);
    requireImageManifest(input.name, manifest.toString("utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function requireAvailableRuntimeArtifacts(bundle: unknown, execute = observe) {
  const references = runtimeArtifactsSchema.parse(bundle);
  const local = Object.values(references).some((reference) =>
    reference.startsWith(`${localRegistry}/`),
  );
  let directory: string | undefined;
  let forward: ReturnType<typeof Bun.spawn> | undefined;
  let localObservation: { origin: string; caFile: string } | undefined;
  try {
    if (local) {
      directory = await mkdtemp(join(tmpdir(), "factory-registry-check-"));
      const caFile = join(directory, "ca.pem");
      const ca = await execute(
        kubernetesCommand([
          "--request-timeout=10s",
          "get",
          "secret/registry-tls",
          "-n",
          namespace,
          "-o",
          "jsonpath={.data.ca\\.crt}",
        ]),
      );
      if (ca.code || !ca.text)
        throw new Error("Runtime Registry CA could not be observed. Saved pins are unchanged.");
      await writeFile(caFile, Buffer.from(ca.text, "base64"), { mode: 0o600 });
      const reservation = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response(null, { status: 503 }),
      });
      const host = `registry.localhost:${reservation.port}`;
      await reservation.stop(true);
      forward = Bun.spawn(
        kubernetesCommand([
          "port-forward",
          "-n",
          namespace,
          "service/registry",
          `${host.split(":")[1]}:5000`,
        ]),
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
      );
      await waitForRegistry({ forward, host, caFile });
      localObservation = { origin: `https://${host}`, caFile };
    }
    for (const [name, reference] of Object.entries(references)) {
      if (reference.startsWith(`${localRegistry}/`)) {
        if (!localObservation) throw new Error("Local Registry observation was not prepared");
        await inspectRegistryArtifact({ name, reference, ...localObservation });
      } else {
        const result = await execute([
          "docker",
          "buildx",
          "imagetools",
          "inspect",
          "--raw",
          reference,
        ]);
        if (result.code !== 0 || !result.text)
          throw new Error(
            `${name} artifact manifest could not be read from its Registry. Check publication, access and approved CA trust. Saved pins are unchanged.`,
          );
        requireImageManifest(name, result.text);
      }
    }
  } finally {
    if (forward) {
      if (forward.exitCode === null) forward.kill();
      await forward.exited;
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
