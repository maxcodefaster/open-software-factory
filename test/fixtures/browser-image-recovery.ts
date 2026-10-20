import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { verificationEnvironment } from "../../scripts/testing/test-prerequisites";

export async function proveBrowserImageRecovery() {
  const root = resolve(import.meta.dir, "../..");
  const id = crypto.randomUUID();
  const scratch = await mkdtemp(resolve(tmpdir(), "factory-owned-image-recovery-"));
  await chmod(scratch, 0o700);
  const evidence = resolve(root, ".factory/test-results/browser-image-native", id);
  await mkdir(evidence, { recursive: true });
  const realDocker = Bun.which("docker") ?? "";
  if (!realDocker) throw new Error("Native Docker is unavailable");
  async function command(args: string[]) {
    const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code) throw new Error(`${args[0]} ${args[1]} failed: ${err.slice(-500)}`);
    return out.trim();
  }
  const architecture = await command([realDocker, "info", "--format", "{{.Architecture}}"]);
  const arch = new Map([
    ["arm64", "arm64"],
    ["aarch64", "arm64"],
    ["x86_64", "amd64"],
    ["amd64", "amd64"],
  ]).get(architecture);
  if (!arch) throw new Error("Unsupported native Docker architecture");
  const label = "factory.owned-browser-image-recovery";
  const bytes = new TextEncoder();
  const digest = (value: Uint8Array) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`;
  const config = bytes.encode(
    JSON.stringify({
      created: "2026-10-20T00:00:00Z",
      architecture: arch,
      os: "linux",
      config: { Labels: { [label]: id } },
      rootfs: { type: "layers", diff_ids: [] },
      history: [],
    }),
  );
  const configDigest = digest(config);
  const manifest = bytes.encode(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: configDigest,
        size: config.length,
      },
      layers: [],
    }),
  );
  const manifestDigest = digest(manifest);
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  await reservation.stop(true);
  const repository = `factory-owned-browser-image-${id}/browser-tools`;
  const reference = `registry.localhost:${port}/${repository}@${manifestDigest}`;
  const cert = resolve(scratch, "registry.pem");
  const key = resolve(scratch, "registry-key.pem");
  await command(["mkcert", "-cert-file", cert, "-key-file", key, "registry.localhost"]);
  const marker = resolve(scratch, "first-pull-ended");
  const log = resolve(scratch, "commands");
  await writeFile(
    resolve(scratch, "docker"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FACTORY_OWNED_DOCKER_LOG"
if [ "$1" = pull ] && [ ! -f "$FACTORY_OWNED_FIRST_PULL" ]; then
  "$FACTORY_OWNED_NATIVE_DOCKER" "$@"
  result=$?
  touch "$FACTORY_OWNED_FIRST_PULL"
  exit "$result"
fi
exec "$FACTORY_OWNED_NATIVE_DOCKER" "$@"
`,
    { mode: 0o700 },
  );
  await writeFile(
    resolve(evidence, "intent.json"),
    JSON.stringify({ id, reference, configDigest, manifestDigest, scratch }),
    { mode: 0o600 },
  );
  let registry: ReturnType<typeof Bun.serve> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let attempted = false;
  let failure: unknown;
  const requests: string[] = [];
  async function dispose() {
    try {
      if (child?.exitCode === null) child.kill("SIGTERM");
      if (child) await child.exited;
      await registry?.stop(true);
      if (attempted) {
        const inspect = Bun.spawn([realDocker, "image", "inspect", reference], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const [output, error, code] = await Promise.all([
          new Response(inspect.stdout).text(),
          new Response(inspect.stderr).text(),
          inspect.exited,
        ]);
        if (code === 0) {
          const image = JSON.parse(output)[0];
          if (image.Config.Labels[label] !== id || !image.RepoDigests.includes(reference))
            throw new Error("Native cleanup refused a foreign image");
          await command([realDocker, "image", "rm", reference]);
        } else if (!/no such image/i.test(error))
          throw new Error("Owned native image cleanup is unconfirmed; intent and scratch retained");
      }
      await rm(scratch, { recursive: true, force: true });
      await writeFile(
        resolve(evidence, "cleanup.json"),
        JSON.stringify({ ownedImageRemoved: true, registryStopped: true }),
      );
    } catch (cleanup) {
      if (failure)
        throw new AggregateError(
          [failure, cleanup],
          "Native image proof failed and cleanup is unconfirmed",
        );
      throw cleanup;
    }
  }
  try {
    attempted = true;
    const running = Bun.spawn(
      [
        "go",
        "test",
        "./connector",
        "-run",
        "^TestBrowserImageRecoveryWithNativeDocker$",
        "-count=1",
        "-v",
      ],
      {
        cwd: resolve(root, "services/runtime-connector"),
        env: {
          ...verificationEnvironment(process.env),
          PATH: `${scratch}:${process.env["PATH"] ?? ""}`,
          FACTORY_OWNED_DOCKER_LOG: log,
          FACTORY_OWNED_FIRST_PULL: marker,
          FACTORY_OWNED_NATIVE_DOCKER: realDocker,
          FACTORY_BROWSER_IMAGE_RECOVERY_REFERENCE: reference,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    child = running;
    const stdout = new Response(running.stdout).text();
    const stderr = new Response(running.stderr).text();
    while (!(await Bun.file(marker).exists()) && child.exitCode === null) await Bun.sleep(20);
    if (!(await Bun.file(marker).exists()))
      throw new Error("Native proof did not attempt its first pull");
    registry = Bun.serve({
      hostname: "127.0.0.1",
      port,
      tls: { cert: await readFile(cert), key: await readFile(key) },
      fetch(request) {
        const path = new URL(request.url).pathname;
        requests.push(path);
        const headers = new Headers({ "docker-distribution-api-version": "registry/2.0" });
        if (path === "/v2/") return new Response("{}", { headers });
        const body =
          path === `/v2/${repository}/manifests/${manifestDigest}`
            ? manifest
            : path === `/v2/${repository}/blobs/${configDigest}`
              ? config
              : undefined;
        if (!body)
          return Response.json(
            { errors: [{ code: "MANIFEST_UNKNOWN", message: "Owned image only" }] },
            { status: 404 },
          );
        headers.set(
          "content-type",
          body === manifest
            ? "application/vnd.oci.image.manifest.v1+json"
            : "application/octet-stream",
        );
        headers.set("docker-content-digest", body === manifest ? manifestDigest : configDigest);
        headers.set("content-length", String(body.length));
        return new Response(request.method === "HEAD" ? null : body, { headers });
      },
    });
    const code = await child.exited;
    const output = `${await stdout}\n${await stderr}`;
    await writeFile(resolve(evidence, "go.log"), output);
    console.log(output);
    if (code) throw new Error("Native image recovery failed");
    const inspected = JSON.parse(await command([realDocker, "image", "inspect", reference]))[0];
    if (inspected.Config.Labels[label] !== id || !inspected.RepoDigests.includes(reference))
      throw new Error("Native recovered image differs from its exact owned intent");
    const commands = (await readFile(log, "utf8")).trim().split("\n");
    const pulls = commands.filter((line) => line === `pull ${reference}`).length;
    if (pulls !== 2 || !requests.includes(`/v2/${repository}/blobs/${configDigest}`))
      throw new Error("Native Registry recovery did not exercise a failed and successful pull");
    await writeFile(
      resolve(evidence, "passed.json"),
      JSON.stringify({
        id,
        reference,
        pulls,
        imageConfirmed: true,
        modelRequests: 0,
        applicationCalls: 0,
      }),
    );
    console.log(
      JSON.stringify({
        evidence,
        pulls,
        imageConfirmed: true,
        modelRequests: 0,
        applicationCalls: 0,
      }),
    );
    return { pulls, imageConfirmed: true, modelRequests: 0, applicationCalls: 0 };
  } catch (cause) {
    failure = cause;
    throw cause;
  } finally {
    await dispose();
  }
}
