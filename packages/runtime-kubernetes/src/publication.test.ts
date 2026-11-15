import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { connect } from "node:net";
import { parse } from "yaml";
import { runtimeVerificationProcess } from "./verification-process";

test("native publication Node fetch uses the admitted egress proxy without resolving the destination locally", async () => {
  const requests: string[] = [];
  const sockets = new Set<{ destroy(): unknown }>();
  const origin = createServer((request, response) => {
    response.writeHead(request.url === "/owned" ? 200 : 403);
    response.end("owned-publication-proxy");
  });
  await new Promise<void>((done) => origin.listen(0, "127.0.0.1", done));
  const originAddress = origin.address();
  if (!originAddress || typeof originAddress === "string")
    throw Error("Owned origin listener missing");
  const proxy = createServer((_request, response) => response.writeHead(403).end());
  proxy.on("connect", (request, socket, head) => {
    requests.push(request.url ?? "");
    if (request.url !== "publication.invalid:80") {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = connect(originAddress.port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    sockets.add(socket);
    sockets.add(upstream);
    socket.once("error", () => upstream.destroy());
    upstream.once("error", () => socket.destroy());
  });
  await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
  try {
    const address = proxy.address();
    if (!address || typeof address === "string") throw Error("Owned proxy listener missing");
    const process = runtimeVerificationProcess({
      forgeURL: "https://forge.example",
      runnerUUID: crypto.randomUUID(),
      runnerToken: "owned-runner-token",
      runnerLabel: "factory-publication",
      handle: "owned-exact-job",
      publication: {
        id: crypto.randomUUID(),
        version: "1.2.3",
        credentialURL: "https://factory.example/internal/releases/owned/credentials",
        credentialToken: "owned-task-attestation-token",
      },
    });
    const child = Bun.spawn(
      [
        "node",
        "--input-type=module",
        "-e",
        'const response = await fetch("http://publication.invalid/owned"); if (!response.ok) process.exit(2); console.log(await response.text());',
      ],
      {
        env: {
          PATH: Bun.env["PATH"],
          ...parse(process.env.FACTORY_RUNNER_CONFIG).runner.envs,
          HTTP_PROXY: `http://127.0.0.1:${address.port}`,
          NO_PROXY: "",
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      },
    );
    const [exit, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    await new Response(child.stderr).text();
    expect(exit).toBe(0);
    expect(stdout.trim()).toBe("owned-publication-proxy");
    expect(requests).toEqual(["publication.invalid:80"]);
  } finally {
    for (const socket of sockets) socket.destroy();
    origin.closeAllConnections();
    await new Promise<void>((done, reject) =>
      proxy.close((error) => (error ? reject(error) : done())),
    );
    await new Promise<void>((done, reject) =>
      origin.close((error) => (error ? reject(error) : done())),
    );
  }
});

test("native publication runs one bound Forgejo job with only its scoped release capabilities", () => {
  const process = runtimeVerificationProcess({
    forgeURL: "https://forge.example",
    runnerUUID: crypto.randomUUID(),
    runnerToken: "owned-runner-token",
    runnerLabel: "factory-publication",
    handle: "specific-job-attempt",
    publication: {
      id: crypto.randomUUID(),
      version: "1.2.3",
      credentialURL: "https://factory.example/internal/releases/owned/credentials",
      credentialToken: "owned-task-attestation-token",
    },
  });
  expect(process.name).toBe("verification");
  expect(process.env.FACTORY_RUNNER_HANDLE).toBe("specific-job-attempt");
  expect(process.env.FACTORY_RELEASE_REGISTRY).toBe("forge.example");
  const config = parse(process.env.FACTORY_RUNNER_CONFIG);
  expect(config.runner.capacity).toBe(1);
  expect(config.runner.envs).toMatchObject({
    NODE_USE_ENV_PROXY: "1",
    FACTORY_RELEASE_SOURCE: "/workspace/project",
    FACTORY_RELEASE_VERSION: "1.2.3",
    FACTORY_RELEASE_CREDENTIAL_TOKEN: "owned-task-attestation-token",
  });
  expect(config.runner.envs).not.toHaveProperty("FACTORY_RUNNER_CONFIG");
  expect(config.server.connections.factory.token).toBe("owned-runner-token");
  expect(process.command.join(" ")).toContain('"one-job", "--wait"');
  expect(process.command.join(" ")).toContain("--handle");
  expect(JSON.stringify(process)).not.toMatch(
    /FACTORY_AUTH_SECRET|PROJECT_ENVIRONMENT_SECRET|forgejo-runner daemon|theia/,
  );
});

test("native Verification without publication receives no release capability", () => {
  const process = runtimeVerificationProcess({
    forgeURL: "https://forge.example",
    runnerUUID: crypto.randomUUID(),
    runnerToken: "owned-runner-token",
    runnerLabel: "factory-verification",
    handle: "owned-exact-job",
  });
  expect(process.env.FACTORY_RUNNER_HANDLE).toBe("owned-exact-job");
  expect(parse(process.env.FACTORY_RUNNER_CONFIG).server.connections.factory.labels).toEqual([
    "factory-verification:host",
  ]);
  expect(JSON.stringify(process)).not.toContain("FACTORY_RELEASE_");
});
