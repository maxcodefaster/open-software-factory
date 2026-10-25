import { expect } from "bun:test";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Compatibility proof only. Neither image becomes a Factory runtime dependency.
const argoImage =
  "quay.io/argoproj/argocd:v3.1.9@sha256:9c33285c0b86a66e9cf9fcafc448e48e0ab7c4678b20b3723556bb6cce8ea0b9";
const grpcImage =
  "fullstorydev/grpcurl:v1.9.3@sha256:085e183ca334eb4e81ca81ee12cbb2b2737505d1d77f5e33dabc5d066593d998";

export async function releaseArgoProof(input: {
  origin: string;
  owner: string;
  digest: string;
  writer: { username: string; token: string };
  reader: { username: string; token: string };
}) {
  const id = crypto.randomUUID();
  const container = `factory-release-argo-${id}`;
  const directory = resolve(".factory/test-results/releases", `argo-${id}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let created = false;
  let proxy: ReturnType<typeof Bun.serve> | undefined;
  async function command(args: string[], body?: string, allowedFailure = false) {
    const child = Bun.spawn(args, {
      stdin: body === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HELM_REGISTRY_CONFIG: resolve(directory, "registry.json") },
    });
    if (body !== undefined && child.stdin) {
      child.stdin.write(body);
      child.stdin.end();
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    const [out, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).finally(() => clearTimeout(timer));
    if (code && !allowedFailure) {
      const safe = error
        .replaceAll(input.writer.token, "[redacted]")
        .replaceAll(input.reader.token, "[redacted]");
      await writeFile(resolve(directory, "failure.txt"), safe, { mode: 0o600 });
      throw new Error(
        `Owned Argo compatibility proof failed (${args[0]}). See ${directory}/failure.txt`,
      );
    }
    return { code, out };
  }
  try {
    const registry = new URL(input.origin).host;
    await command(
      [
        "helm",
        "registry",
        "login",
        registry,
        "--plain-http",
        "--username",
        input.writer.username,
        "--password-stdin",
      ],
      input.writer.token,
    );
    const chart = resolve(directory, "app");
    await cp("templates/release/chart", chart, { recursive: true });
    const values = JSON.parse(await readFile(resolve(chart, "values.yaml"), "utf8"));
    const digest = input.digest;
    values.image = { repository: `${registry}/${input.owner}/web`, digest };
    await writeFile(resolve(chart, "values.yaml"), JSON.stringify(values));
    for (const version of ["1.4.2", "1.4.3", "1.5.0"]) {
      await command(["helm", "package", chart, "--version", version, "--destination", directory]);
      await command([
        "helm",
        "push",
        resolve(directory, `app-${version}.tgz`),
        `oci://${registry}/${input.owner}`,
        "--plain-http",
      ]);
    }
    await command([
      "mkcert",
      "-cert-file",
      resolve(directory, "tls.crt"),
      "-key-file",
      resolve(directory, "tls.key"),
      "host.orb.internal",
    ]);
    proxy = Bun.serve({
      hostname: "0.0.0.0",
      port: 0,
      tls: {
        cert: await readFile(resolve(directory, "tls.crt")),
        key: await readFile(resolve(directory, "tls.key")),
      },
      async fetch(request) {
        const incoming = new URL(request.url);
        const upstream = await fetch(new URL(incoming.pathname + incoming.search, input.origin), {
          method: request.method,
          headers: request.headers,
          redirect: "manual",
          ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body }),
        });
        const headers = new Headers(upstream.headers);
        const challenge = headers.get("www-authenticate");
        if (challenge)
          headers.set(
            "www-authenticate",
            challenge.replaceAll(input.origin, `https://host.orb.internal:${proxy!.port}`),
          );
        return new Response(upstream.body, { status: upstream.status, headers });
      },
    });
    await command([
      "docker",
      "run",
      "-d",
      "--name",
      container,
      "--label",
      `factory.release-argo=${id}`,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--entrypoint",
      "/usr/local/bin/argocd-repo-server",
      argoImage,
      "--disable-tls",
      "--loglevel",
      "error",
    ]);
    created = true;
    const remote = `host.orb.internal:${proxy.port}/${input.owner}`;
    const repo = {
      repo: remote,
      type: "helm",
      enableOCI: true,
      // The owned TLS proxy has a local test certificate, never a production setting.
      insecure: true,
      username: input.reader.username,
      password: input.reader.token,
    };
    async function rpc(method: string, body: unknown, allowedFailure = false) {
      return command(
        [
          "docker",
          "run",
          "--rm",
          "-i",
          "--network",
          `container:${container}`,
          "--volume",
          `${directory}:/proof:ro`,
          grpcImage,
          "-plaintext",
          "-import-path",
          "/proof",
          "-proto",
          "argo.proto",
          "-max-time",
          "60",
          "-d",
          "@",
          "127.0.0.1:8081",
          `repository.RepoServerService/${method}`,
        ],
        JSON.stringify(body),
        allowedFailure,
      );
    }
    await cp("test/fixtures/release-argo.proto", resolve(directory, "argo.proto"));
    const source = { repoURL: remote, chart: "app", targetRevision: "1.4.*" };
    const resolved = await rpc("ResolveRevision", {
      repo,
      app: { spec: { source } },
      ambiguousRevision: "1.4.*",
      sourceIndex: 0,
    });
    expect(JSON.parse(resolved.out).revision).toBe("1.4.3");
    const rendered = await rpc("GenerateManifest", {
      repo,
      revision: "1.4.3",
      applicationSource: source,
      appName: "external-consumer-proof",
      namespace: "external-consumer-proof",
      noCache: true,
      noRevisionCache: true,
      kubeVersion: "1.34.0",
    });
    const output = JSON.parse(rendered.out) as { manifests: string[] };
    expect(output.manifests).toHaveLength(2);
    expect(output.manifests.join("\n")).toContain(`@${digest}`);
    expect(output.manifests.join("\n")).not.toContain(":1.4.3");
    const denied = await rpc(
      "ResolveRevision",
      {
        repo: { ...repo, password: "invalid-owned-proof-token" },
        app: { spec: { source } },
        ambiguousRevision: "1.4.*",
        sourceIndex: 0,
      },
      true,
    );
    expect(denied.code).not.toBe(0);
    await writeFile(
      resolve(directory, "result.json"),
      JSON.stringify({
        argoImage,
        grpcImage,
        selected: "1.4.3",
        constraint: "1.4.*",
        manifests: output.manifests,
        unauthenticatedDenied: true,
        deployed: false,
      }),
    );
  } finally {
    if (created) {
      const identity = await command([
        "docker",
        "inspect",
        "--format",
        '{{index .Config.Labels "factory.release-argo"}}',
        container,
      ]);
      expect(identity.out.trim()).toBe(id);
      await command(["docker", "rm", "-f", container]);
    }
    await rm(resolve(directory, "registry.json"), { force: true });
    await proxy?.stop(true);
    await rm(resolve(directory, "tls.key"), { force: true });
  }
}
