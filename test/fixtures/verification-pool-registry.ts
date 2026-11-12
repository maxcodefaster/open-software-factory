import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runCommand } from "../../packages/runtime-kubernetes/src/command";
import { eventually } from "./factory-process";

export function verificationRegistryResponse(response: Response, method: string) {
  const headers = new Headers(response.headers);
  if (response.headers.has("content-encoding")) {
    headers.delete("content-encoding");
    if (method !== "HEAD") headers.delete("content-length");
  }
  return new Response(response.body, { status: response.status, headers });
}

/** Read-only access to already published images; no retained registry writes. */
export async function verificationPoolRegistry(gateway: string, directory: string) {
  const certificate = resolve(directory, "registry.pem");
  const key = resolve(directory, "registry.key");
  const generated = await runCommand([
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
    "/CN=owned-verification-registry",
    "-addext",
    `subjectAltName=IP:${gateway}`,
    "-addext",
    "basicConstraints=critical,CA:TRUE",
  ]);
  if (generated.exitCode) throw new Error("Owned registry certificate generation failed");
  const originalKubeconfig = process.env["KUBECONFIG"];
  const publicCertificate = await runCommand([
    "kubectl",
    "-n",
    "open-factory-envbox-smoke",
    "get",
    "secret",
    "registry-tls",
    "-o",
    "jsonpath={.data.ca\\.crt}",
  ]);
  if (publicCertificate.exitCode)
    throw new Error("Published registry public certificate unavailable");
  const ca = Buffer.from(publicCertificate.stdout, "base64").toString();
  const forward = Bun.spawn(
    ["kubectl", "-n", "open-factory-envbox-smoke", "port-forward", "service/registry", "0:5000"],
    {
      env: { ...process.env, KUBECONFIG: originalKubeconfig },
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  let port = "";
  void (async () => {
    let text = "";
    for await (const chunk of forward.stdout) {
      text += new TextDecoder().decode(chunk);
      port = text.match(/127\.0\.0\.1:(\d+)/)?.[1] ?? "";
    }
  })();
  await eventually(async () => port, Boolean, "Published image read forward unavailable", 30_000);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: Bun.file(certificate), key: Bun.file(key) },
    async fetch(request) {
      const url = new URL(request.url);
      if (!["GET", "HEAD"].includes(request.method) || !url.pathname.startsWith("/v2/"))
        return new Response(null, { status: 403 });
      const response = await fetch(
        `https://registry.localhost:${port}${url.pathname}${url.search}`,
        {
          method: request.method,
          headers: { accept: request.headers.get("accept") ?? "*/*" },
          // This forwards only the explicitly read public certificate of the retained registry.
          tls: { ca },
          redirect: "error",
        },
      );
      return verificationRegistryResponse(response, request.method);
    },
  });
  await writeFile(resolve(directory, "registry-owner"), gateway, { flag: "wx" });
  return {
    base: `https://127.0.0.1:${server.port}`,
    host: `${gateway}:${server.port}`,
    certificate: await readFile(certificate, "utf8"),
    async dispose() {
      await server.stop(true);
      forward.kill();
      await forward.exited;
    },
  };
}
