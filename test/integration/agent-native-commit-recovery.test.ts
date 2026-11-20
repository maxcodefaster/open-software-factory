import { disableStarterSkillsIn } from "../fixtures/change-agent-turns";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import { RuntimeHub, type RuntimeSocketData } from "../../apps/factory/src/runtime/hub";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";
import { nativeGitHTTP } from "../fixtures/native-git-http";
import { observe } from "../fixtures/pinned-opencode";

async function command(args: string[], cwd: string) {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [output, error, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0) throw new Error(`Owned native commit command failed: ${args[0]}: ${error}`);
  return output.trim();
}

async function removeScratch(scratch: string, owner: string) {
  if ((await readFile(resolve(scratch, "owner"), "utf8")) !== owner)
    throw new Error("Native scratch cleanup refused");
  await rm(scratch, { recursive: true });
}

// Preserve the admitted Project HTTPS origin, SNI and certificate verification.
// Only this fixture's exact CONNECT authority reaches its owned loopback server;
// Git and the product transport never receive a file:// execution destination.
async function gitTLSRemote(directory: string) {
  const hostname = "owned-build.factory.invalid";
  const certificate = resolve(directory, "git-cert.pem");
  const key = resolve(directory, "git-key.pem");
  await command(
    ["mise", "exec", "--", "mkcert", "-cert-file", certificate, "-key-file", key, hostname],
    resolve("."),
  );
  const caRoot = await command(["mise", "exec", "--", "mkcert", "-CAROOT"], resolve("."));
  const remote = nativeGitHTTP(directory);
  const pending = new Set<Promise<Response | null>>();
  const tls = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: Bun.file(certificate), key: Bun.file(key) },
    fetch(request) {
      const url = new URL(request.url);
      const prefix = "/owned/owned-build.git";
      if (!url.pathname.startsWith(`${prefix}/`)) return new Response(null, { status: 404 });
      url.pathname = `${remote.prefix}/remote.git${url.pathname.slice(prefix.length)}`;
      const response = remote.fetch(new Request(url, request));
      pending.add(response);
      void response.finally(() => pending.delete(response)).catch(() => {});
      return response.then((value) => value ?? new Response(null, { status: 404 }));
    },
  });
  const tlsPort = tls.port;
  if (!tlsPort) {
    await tls.stop(true);
    throw new Error("Owned Git TLS listener missing");
  }
  const sockets = new Set<Socket>();
  const proxy = createServer((client) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    client.setTimeout(30_000, () => client.destroy());
    let header = Buffer.alloc(0);
    const connect = (chunk: Buffer) => {
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf("\r\n\r\n");
      if (header.length > 8192) return client.destroy();
      if (end < 0) return;
      client.off("data", connect);
      if (
        header.subarray(0, header.indexOf("\r\n")).toString() !== `CONNECT ${hostname}:443 HTTP/1.1`
      )
        return client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      const upstream = createConnection({ host: "127.0.0.1", port: tlsPort });
      sockets.add(upstream);
      upstream.once("close", () => {
        sockets.delete(upstream);
        client.destroy();
      });
      client.once("close", () => upstream.destroy());
      upstream.on("error", () => {
        upstream.destroy();
        client.destroy();
      });
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const remaining = header.subarray(end + 4);
        if (remaining.length) upstream.write(remaining);
        client.pipe(upstream).pipe(client);
      });
    };
    client.on("data", connect);
  });
  try {
    await new Promise<void>((accept, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", accept);
    });
  } catch (cause) {
    await tls.stop(true);
    throw cause;
  }
  const address = proxy.address();
  if (!address || typeof address === "string") {
    proxy.close();
    await tls.stop(true);
    throw new Error("Owned Git proxy missing");
  }
  return {
    ...remote,
    proxyURL: `http://127.0.0.1:${address.port}`,
    caFile: resolve(caRoot, "rootCA.pem"),
    async dispose() {
      for (const socket of sockets) socket.destroy();
      const stopped = await Promise.allSettled([
        new Promise<void>((accept, reject) =>
          proxy.close((cause) => (cause ? reject(cause) : accept())),
        ),
        tls.stop(true),
      ]);
      await Promise.allSettled([...pending]);
      const failure = stopped.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
  };
}

function listenerClosed(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (closed: boolean) => {
      socket.destroy();
      resolve(closed);
    };
    socket.once("connect", () => finish(false));
    socket.once("error", (cause) => finish("code" in cause && cause.code === "ECONNREFUSED"));
    socket.setTimeout(500, () => finish(false));
  });
}

const cases = ["git-prepare-commit", "git-push"].flatMap((action) =>
  ["restore", "mode revoked"].map((boundary) => [action, boundary] as const),
);

test.each(cases)(
  "native %s acknowledgement loss under %s retains exact Git identity and manual files",
  async (lostAction, boundary) => {
    const scratch = await realpath(
      await mkdtemp(resolve(tmpdir(), "factory-owned-native-commit-")),
    );
    const workspace = resolve(scratch, "checkout");
    const remote = resolve(scratch, "remote.git");
    const marker = resolve(scratch, "owner");
    const scratchOwner = crypto.randomUUID();
    let passed = false;
    let tlsRemote: Awaited<ReturnType<typeof gitTLSRemote>> | undefined;
    const previousForge = new Map<string, string | undefined>();
    try {
      await writeFile(marker, scratchOwner);
      tlsRemote = await gitTLSRemote(scratch);
      const remoteTLS = tlsRemote;
      for (const [name, value] of Object.entries({
        FACTORY_FORGEJO_USERNAME: remoteTLS.username,
        FACTORY_FORGEJO_TOKEN: remoteTLS.password,
      })) {
        previousForge.set(name, process.env[name]);
        process.env[name] = value;
      }
      await command(["git", "init", "--initial-branch=main", workspace], scratch);
      const git = (...args: string[]) => command(["git", ...args], workspace);
      await git("config", "user.name", "Owned native commit fixture");
      await git("config", "user.email", "owned@factory.local");
      await git("config", "commit.gpgsign", "false");
      await writeFile(resolve(workspace, "app.txt"), "base\n");
      await git("add", "-A");
      await git("commit", "-m", "Owned base");
      const baseSHA = await git("rev-parse", "HEAD");
      // Recovery scans all pending operations. Keep another suite's fake Hub
      // from claiming these native operations, and never recover user data.
      const databaseProcess = await factoryProcess();
      let owned: Awaited<ReturnType<typeof fixture>>;
      try {
        owned = await fixture(undefined, baseSHA, databaseProcess.connect());
        // This transport/Git fixture owns an empty instruction selection.
        // It is not the native Skill-installation proof, and must not inherit
        // first-use library defaults merely because its database is external.
        await owned.database.client.begin((sql) =>
          disableStarterSkillsIn(sql, owned.userID, owned.projectID, owned.database),
        );
      } catch (cause) {
        await databaseProcess.dispose();
        throw cause;
      }
      const nativeProcesses: ReturnType<typeof Bun.spawn>[] = [];
      const sockets = new Set<ServerWebSocket<RuntimeSocketData>>();
      const frames: Array<{ operationID: string; action: string; error: string | undefined }> = [];
      const lost = Promise.withResolvers<void>();
      let loseNext = true;
      let connections = 0;
      const token = crypto.randomUUID();
      const hash = (value: string) => createHash("sha256").update(value).digest("hex");
      owned.hub.allow(owned.attemptID, 1, hash(token), hash(token));
      owned.hub.parentOperation = RuntimeHub.prototype.parentOperation.bind(owned.hub);
      const controller = owned.controller();
      const recovery = owned.controller();
      let server: Bun.Server<RuntimeSocketData> | undefined;
      let serverPort: number | undefined;
      try {
        server = Bun.serve<RuntimeSocketData>({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request, server) {
            const data = owned.hub.authorize(request, hash);
            if (!data) return new Response(null, { status: 401 });
            if (
              server.upgrade(request, {
                data,
                headers: { "sec-websocket-protocol": RuntimeHub.protocol() },
              })
            )
              return;
            return new Response(null, { status: 400 });
          },
          websocket: {
            open(socket) {
              sockets.add(socket);
              owned.hub.open(socket);
            },
            message(socket, raw) {
              const message = JSON.parse(String(raw)) as {
                type: string;
                operationId: string;
                action: string;
                error?: string;
              };
              if (message.type === "hello") connections += 1;
              if (message.type === "operation-response") {
                frames.push({
                  operationID: message.operationId,
                  action: message.action,
                  error: message.error,
                });
                if (loseNext && message.action === lostAction) {
                  loseNext = false;
                  if (message.error) {
                    lost.reject(
                      new Error(
                        `Owned native Git operation failed before acknowledgement loss: ${message.error}`,
                      ),
                    );
                    owned.hub.message(socket, raw);
                    return;
                  }
                  // Git has executed in Go; its acknowledgement never reaches Factory.
                  socket.terminate();
                  lost.resolve();
                  return;
                }
              }
              owned.hub.message(socket, raw);
            },
            close(socket) {
              sockets.delete(socket);
              owned.hub.close(socket);
              owned.hub.suspend(owned.attemptID);
            },
          },
        });
        serverPort = server.port;
        const controlURL = `ws://127.0.0.1:${serverPort}`;
        const changes = await owned.database.client<{ branch: string }[]>`
        SELECT branch_name AS branch FROM factory.change WHERE id = ${owned.changeID}`;
        const branch = changes[0]?.branch;
        if (!branch) throw new Error("Owned native Change missing");
        await command(["git", "init", "--bare", remote], scratch);
        await git("remote", "add", "origin", remote);
        // The admitted Project and immutable native binding retain their real
        // HTTPS destination. Only fixture seeding uses the local bare path.
        await command(["git", "-C", remote, "config", "http.receivepack", "true"], scratch);
        await git("push", "origin", `HEAD:refs/heads/${branch}`);
        const pushCount = resolve(remote, "owned-push-count");
        const hook = resolve(remote, "hooks/pre-receive");
        await writeFile(
          hook,
          '#!/bin/sh\ncat >/dev/null\nprintf "push\\n" >> "$(git rev-parse --git-dir)/owned-push-count"\n',
        );
        await chmod(hook, 0o700);
        await writeFile(resolve(workspace, "app.txt"), "implementation\n");
        const binary = resolve(scratch, "native-commit-test");
        await command(
          ["mise", "exec", "--", "go", "test", "-c", "-o", binary, "./connector"],
          resolve("services/runtime-connector"),
        );
        async function connect() {
          const before = connections;
          const native = Bun.spawn(
            [binary, "-test.run=^TestCommitControlFixture$", "-test.timeout=30s"],
            {
              env: {
                PATH: process.env["PATH"] ?? "/usr/bin:/bin",
                TMPDIR: tmpdir(),
                HTTPS_PROXY: remoteTLS.proxyURL,
                HTTP_PROXY: remoteTLS.proxyURL,
                NO_PROXY: "localhost,127.0.0.1",
                GIT_SSL_CAINFO: remoteTLS.caFile,
                FACTORY_OWNED_COMMIT_TOKEN: token,
                FACTORY_OWNED_COMMIT_ASSIGNMENT: JSON.stringify({
                  runtimeAttemptId: owned.attemptID,
                  generation: 1,
                  workspaceFolder: workspace,
                  controlUrl: controlURL,
                }),
              },
              stdout: "ignore",
              stderr: "ignore",
            },
          );
          nativeProcesses.push(native);
          await observe(
            async () => connections,
            (count) => count > before,
          );
        }
        const conversationID = crypto.randomUUID();
        await owned.database
          .client`INSERT INTO factory.ticket_conversation(id, project_id, ticket_id, mode, created_by)
        VALUES (${conversationID}, ${owned.projectID}, ${owned.ticketID}, 'build', ${owned.userID})`;
        await connect();
        await controller.prompt(
          owned.changeID,
          "Owned native commit recovery",
          owned.userID,
          crypto.randomUUID(),
        );
        await Promise.race([
          owned.requested,
          Bun.sleep(15_000).then(async () => {
            throw new Error(
              `Owned native prompt was not dispatched: ${JSON.stringify(await controller.get(owned.changeID))}`,
            );
          }),
        ]);
        owned.finish();
        owned.release();
        await Promise.race([
          lost.promise,
          Bun.sleep(15_000).then(() => {
            throw new Error("Native acknowledgement was not lost");
          }),
        ]);
        await controller.shutdown();
        const operations = await owned.database.client<
          { id: string; state: string; error: string }[]
        >`
        SELECT id, state, last_error AS error FROM factory.change_commit_operation WHERE change_id = ${owned.changeID}`;
        const operation = operations[0];
        if (!operation) throw new Error("Native commit intent missing");
        expect(operation.state).toBe(
          lostAction === "git-push" ? "push-intended" : "commit-intended",
        );
        expect(operation.error).toContain("not confirmed");
        const preparedSHA = await git("rev-parse", "HEAD");
        expect(preparedSHA).not.toBe(baseSHA);
        expect(await git("rev-list", "--count", "HEAD")).toBe("2");
        expect(await git("show", "-s", "--format=%B", "HEAD")).toContain(
          `Factory-Operation: ${operation.id}`,
        );
        const remoteSHA = () => command(["git", "rev-parse", `refs/heads/${branch}`], remote);
        expect(await remoteSHA()).toBe(lostAction === "git-push" ? preparedSHA : baseSHA);
        await writeFile(resolve(workspace, "app.txt"), "later manual edit\n");
        await git("add", "app.txt");
        await writeFile(resolve(workspace, "manual.txt"), "later manual file\n");
        const status = await git("status", "--porcelain");
        const index = await git("diff", "--cached");
        if (boundary === "mode revoked")
          await owned.database
            .client`UPDATE factory.ticket_conversation SET mode = 'plan', version = version + 1 WHERE id = ${conversationID}`;
        const before = frames.length;
        await connect();
        await recovery.recover();
        await recovery.shutdown();
        const settled = await owned.database.client<{ state: string }[]>`
        SELECT state FROM factory.change_commit_operation WHERE id = ${operation.id}`;
        expect(settled[0]?.state).toBe(boundary === "restore" ? "succeeded" : operation.state);
        expect(frames.slice(before).map(({ action }) => action)).toEqual(
          boundary !== "restore"
            ? []
            : lostAction === "git-push"
              ? ["git-push"]
              : ["git-observe-commit", "git-push"],
        );
        expect(
          frames.every(({ operationID, error }) => operationID === operation.id && !error),
        ).toBe(true);
        expect(await git("rev-parse", "HEAD")).toBe(preparedSHA);
        expect(await git("rev-list", "--count", "HEAD")).toBe("2");
        expect(await git("status", "--porcelain")).toBe(status);
        expect(await git("diff", "--cached")).toBe(index);
        expect(await readFile(resolve(workspace, "manual.txt"), "utf8")).toBe(
          "later manual file\n",
        );
        expect(await remoteSHA()).toBe(
          boundary === "restore" || lostAction === "git-push" ? preparedSHA : baseSHA,
        );
        const pushes = await readFile(pushCount, "utf8").catch(() => "");
        expect(pushes).toBe(boundary === "restore" || lostAction === "git-push" ? "push\n" : "");
        expect(remoteTLS.observations.pushes).toBe(
          boundary === "restore" || lostAction === "git-push" ? 1 : 0,
        );
        expect(owned.requests()).toBe(1);
        expect((await recovery.get(owned.changeID)).state).toBe(
          boundary === "restore" ? "committed" : "waiting",
        );
        passed = true;
      } finally {
        try {
          owned.release();
          // Bun 1.3.14 can leave stop() unresolved after an upgraded peer is
          // terminated. Check the actual socket/listener teardown instead.
          if (server) void server.stop(true);
          owned.hub.revoke(owned.attemptID);
          for (const socket of sockets) socket.terminate();
          for (const native of nativeProcesses) {
            if (native.exitCode === null) native.kill("SIGKILL");
            await native.exited;
          }
          if (serverPort) {
            // Bun resolves url lazily. Reading it after stop can report port
            // zero rather than the listener this fixture actually owned.
            const port = serverPort;
            await observe(
              () => listenerClosed(port),
              (stopped) => stopped,
            );
          }
        } finally {
          await Promise.allSettled([controller.shutdown(), recovery.shutdown()]);
          await owned.dispose();
          await databaseProcess.dispose();
        }
      }
    } catch (cause) {
      passed = false;
      throw cause;
    } finally {
      let disposed = false;
      try {
        await tlsRemote?.dispose();
        disposed = true;
      } finally {
        for (const [name, value] of previousForge) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        if (passed && disposed) await removeScratch(scratch, scratchOwner);
        else console.error("Owned native commit failure checkout retained", scratch);
      }
    }
  },
  60_000,
);
