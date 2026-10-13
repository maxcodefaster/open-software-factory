import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eventually } from "./factory-process";

// TLS/authenticated Registry API backed by the existing immutable test images.
export async function privateRegistryFixture() {
  const directory = await mkdtemp(join(tmpdir(), "factory-owned-registry-"));
  const certificate = join(directory, "certificate.pem");
  const key = join(directory, "key.pem");
  const generated = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      key,
      "-out",
      certificate,
      "-subj",
      "/CN=host.orb.internal",
      "-addext",
      "subjectAltName=DNS:host.orb.internal,DNS:localhost,IP:127.0.0.1",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  if ((await generated.exited) !== 0) {
    await rm(directory, { recursive: true });
    throw new Error("Owned registry TLS setup failed");
  }
  const password = crypto.randomUUID();
  const authorization = `Basic ${Buffer.from(`owned:${password}`).toString("base64")}`;
  const featureDirectory = join(directory, "feature");
  await mkdir(featureDirectory);
  await writeFile(
    join(featureDirectory, "devcontainer-feature.json"),
    JSON.stringify({
      id: "remote-owned",
      version: "1.0.0",
      name: "Owned remote Feature",
      postCreateCommand: [
        "node",
        "-e",
        "require('fs').writeFileSync('remote-feature-hook.txt','ran')",
      ],
    }),
  );
  await writeFile(
    join(featureDirectory, "install.sh"),
    "#!/bin/sh\nset -eu\nprintf prepared > /opt/owned-remote-feature\n",
    { mode: 0o700 },
  );
  const tar = Bun.spawn(
    ["tar", "-czf", join(directory, "feature.tgz"), "-C", featureDirectory, "."],
    { stdout: "ignore", stderr: "ignore" },
  );
  if ((await tar.exited) !== 0) {
    await rm(directory, { recursive: true });
    throw new Error("Owned Feature archive failed");
  }
  const archive = await readFile(join(directory, "feature.tgz"));
  const config = Buffer.from("{}");
  const digest = (value: Uint8Array) =>
    "sha256:" + createHash("sha256").update(value).digest("hex");
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        mediaType: "application/vnd.devcontainers",
        digest: digest(config),
        size: config.length,
      },
      layers: [
        {
          mediaType: "application/vnd.devcontainers.layer.v1+tar",
          digest: digest(archive),
          size: archive.length,
        },
      ],
    }),
  );
  const featureDigest = digest(manifest);
  let authenticated = 0;
  const caRoot = Bun.spawn(["mise", "exec", "--", "mkcert", "-CAROOT"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const caDirectory = (await new Response(caRoot.stdout).text()).trim();
  if ((await caRoot.exited) !== 0) {
    await rm(directory, { recursive: true });
    throw new Error("Owned registry CA unavailable");
  }
  const ca = await readFile(join(caDirectory, "rootCA.pem"), "utf8");
  const forward = Bun.spawn(
    [
      "kubectl",
      "--context",
      "orbstack",
      "port-forward",
      "--address",
      "127.0.0.1",
      "-n",
      "open-factory-envbox-smoke",
      "service/registry",
      "0:5000",
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  let upstream = "";
  let forwarding = "";
  void (async () => {
    const reader = forward.stdout.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        forwarding = `${forwarding}${new TextDecoder().decode(chunk.value)}`.slice(-2_000);
        const port = forwarding.match(/Forwarding from 127\.0\.0\.1:(\d+)/)?.[1];
        if (port) upstream = `https://registry.localhost:${port}`;
      }
    } finally {
      reader.releaseLock();
    }
  })();
  let server: ReturnType<typeof Bun.serve> | undefined;
  async function dispose() {
    await server?.stop(true);
    if (forward.exitCode === null) forward.kill();
    await forward.exited;
    await rm(directory, { recursive: true });
  }
  try {
    await eventually(
      async () => {
        if (forward.exitCode !== null) throw new Error("Owned registry forwarding exited");
        return upstream
          ? fetch(`${upstream}/v2/`, {
              tls: { ca },
              signal: AbortSignal.timeout(1_000),
            })
              .then((r) => r.ok)
              .catch(() => false)
          : false;
      },
      (value) => value,
      "Owned registry read connection unavailable",
      15_000,
    );
    server = Bun.serve({
      hostname: "0.0.0.0",
      port: 0,
      tls: { cert: Bun.file(certificate), key: Bun.file(key) },
      async fetch(request) {
        if (request.headers.get("authorization") !== authorization)
          return new Response(null, {
            status: 401,
            headers: { "www-authenticate": 'Basic realm="Owned private registry"' },
          });
        if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 403 });
        const url = new URL(request.url);
        if (!url.pathname.startsWith("/v2/")) return new Response(null, { status: 404 });
        authenticated++;
        if (url.pathname.startsWith("/v2/owned/feature/")) {
          const ref = url.pathname.split("/").at(-1);
          const content =
            url.pathname.includes("/manifests/") && (ref === "1" || ref === featureDigest)
              ? manifest
              : ref === digest(config)
                ? config
                : ref === digest(archive)
                  ? archive
                  : undefined;
          return new Response(
            request.method === "HEAD" || !content ? null : new Uint8Array(content),
            {
              status: content ? 200 : 404,
              headers: {
                "content-type": url.pathname.includes("/manifests/")
                  ? "application/vnd.oci.image.manifest.v1+json"
                  : "application/octet-stream",
                "docker-content-digest": content ? digest(content) : featureDigest,
                "content-length": String(content?.length ?? 0),
              },
            },
          );
        }
        const response = await fetch(`${upstream}${url.pathname}${url.search}`, {
          tls: { ca },
          method: request.method,
          headers: { accept: request.headers.get("accept") ?? "*/*" },
          redirect: "manual",
        }).catch(() => null);
        if (!response) return new Response(null, { status: 503 });
        const headers = new Headers(response.headers);
        headers.delete("set-cookie");
        return new Response(response.body, { status: response.status, headers });
      },
    });
    return {
      host: `host.orb.internal:${server.port}`,
      username: "owned",
      password,
      certificate: await readFile(certificate, "utf8"),
      authenticated: () => authenticated,
      dispose,
    };
  } catch (cause) {
    await dispose();
    throw cause;
  }
}
