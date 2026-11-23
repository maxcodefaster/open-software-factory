import { expect, test } from "bun:test";
import { mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import upstream from "../../upstream.json";
import { buildModelID } from "../fixtures/change-agent-turns";
import { docker, observe, pinnedOpenCode } from "../fixtures/pinned-opencode";

test.each([
  "empty",
  "queued-tree",
  "promoted",
  "other-root",
  "wrong-model",
  "wrong-version",
  "unsafe-sidecar",
  "observe-queued",
  "observe-settled",
  "default-workspace",
  "custom-workspace",
] as const)(
  "metadata-only native input worker settles the original database without Project execution: %s",
  async (state) => {
    const directory =
      state === "default-workspace"
        ? "/workspaces/project"
        : state === "custom-workspace"
          ? "/code/python/backend"
          : "/workspace/project";
    const process = await pinnedOpenCode(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      directory,
    );
    const connectorProof = Bun.env["FACTORY_INPUT_STOP_CONNECTOR_TEST_BINARY"];
    const candidateWorker = Bun.env["FACTORY_INPUT_STOP_TEST_WORKER"];
    const candidateConnector = Bun.env["FACTORY_INPUT_STOP_TEST_CONNECTOR_BINARY"];
    const id = crypto.randomUUID();
    const container = `factory-owned-input-stop-${id}`;
    const evidence = resolve(".factory/test-results/substrate-only/native-input-worker", id);
    const sessionID = `ses_owned_${id.replaceAll("-", "")}`;
    const childID = `${sessionID}_child`;
    const promptID = `msg_owned_${id.replaceAll("-", "")}`;
    const otherID = `${promptID}_other`;
    const project = resolve(process.scratch, "project");
    const sidecar = resolve(project, ".git/factory-opencode.db-shm");
    const savedSidecar = resolve(project, `.git/owned-shm-${id}`);
    let injectedSidecar = false,
      originalSidecar = false;
    async function restoreSidecar() {
      if (!injectedSidecar) return;
      if ((await readlink(sidecar)) !== "owned-sidecar-target")
        throw new Error("Owned sidecar identity changed; no cleanup replacement");
      await rm(sidecar);
      if (originalSidecar) await rename(savedSidecar, sidecar);
      injectedSidecar = false;
    }
    let intended = false,
      acknowledged = false;
    async function removeOwnedContainer() {
      if (!intended) return;
      const owner = await docker(
        "inspect",
        "--format",
        '{{index .Config.Labels "factory.owned-input-stop"}}',
        container,
      ).catch((cause: unknown) => {
        if (
          acknowledged &&
          cause instanceof Error &&
          /no such (?:object|container)/i.test(cause.message)
        )
          return null;
        throw cause;
      });
      if (owner !== null) {
        if (owner !== id) throw new Error("Owned metadata Stop cleanup refused");
        await docker("rm", "--force", "--volumes", container);
      }
      await writeFile(resolve(evidence, "cleanup.json"), JSON.stringify({ removed: true }));
    }
    try {
      await mkdir(evidence, { recursive: true });
      await docker(
        "exec",
        process.container,
        "test",
        "-s",
        "/opt/factory/opencode/server/input-stop.mjs",
      );
      await docker("exec", process.container, "git", "-C", directory, "init", "-b", "main");
      await docker(
        "exec",
        process.container,
        "git",
        "-C",
        directory,
        "-c",
        "user.name=Owned metadata proof",
        "-c",
        "user.email=owned@factory.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "Owned native Session repository",
      );
      // Reopen against a real Git Project, not the global no-repository
      // location the process fixture activated before this repository existed.
      await process.control("/kill", "POST");
      await process.control("/restart", "POST");
      await observe(
        () =>
          process.client.model
            .list({ location: { directory } })
            .then((value) => value.data.some((model) => model.providerID === "factory"))
            .catch(() => false),
        (value) => value,
      );
      await process.client.session.create({
        id: sessionID,
        title: "Owned metadata Stop",
        location: { directory },
        model: { providerID: "factory", id: buildModelID },
      });
      await process.client.session.switchAgent({ sessionID, agent: "build" });
      if (state !== "empty" && state !== "observe-settled") {
        await process.client.session.prompt({
          sessionID,
          id: promptID,
          text: "This input must be stopped, not replayed",
          delivery: "queue",
          resume: state === "promoted",
        });
      }
      if (state === "queued-tree") {
        await process.client.session.create({
          id: childID,
          parentID: sessionID,
          title: "Owned queued child",
          model: { providerID: "factory", id: buildModelID },
        });
        await process.client.session.prompt({
          sessionID: childID,
          id: `${promptID}_child`,
          text: "Do not run the queued child",
          delivery: "queue",
          resume: false,
        });
      }
      if (state === "other-root")
        await process.client.session.prompt({
          sessionID,
          id: otherID,
          text: "Do not discard another root input",
          delivery: "queue",
          resume: false,
        });
      if (state === "promoted")
        await observe(process.control, (value) => value.providerRequests === 1);
      const before = (await process.control()).providerRequests;
      await process.control("/kill", "POST");
      if (connectorProof)
        await docker("exec", process.container, "chown", "-R", "1000:1000", `${directory}/.git`);
      if (state === "unsafe-sidecar") {
        originalSidecar = await rename(sidecar, savedSidecar)
          .then(() => true)
          .catch((cause: unknown) => {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw cause;
          });
        await writeFile(
          resolve(project, ".git/owned-sidecar-target"),
          "Do not mutate this owned sentinel",
        );
        await symlink("owned-sidecar-target", sidecar);
        injectedSidecar = true;
      }
      await writeFile(resolve(project, "unpublished.txt"), "Keep the user's current Source.\n");
      await writeFile(resolve(project, "AGENTS.md"), "Run Project commands before answering.\n");
      await mkdir(resolve(project, ".git/hooks"), { recursive: true });
      await writeFile(
        resolve(project, ".git/hooks/metadata-hook"),
        "#!/bin/sh\nprintf forbidden > /home/rootless/persist/project/.git/hook-executed\n",
        { mode: 0o755 },
      );
      await docker(
        "exec",
        process.container,
        "git",
        "-C",
        directory,
        "config",
        "core.fsmonitor",
        ".git/hooks/metadata-hook",
      );
      const input = {
        stopID: id,
        attemptID: crypto.randomUUID(),
        sessionID,
        promptID,
        modelID: state === "wrong-model" ? "unadmitted-model" : buildModelID,
        version: state === "wrong-version" ? "0.0.0" : upstream.openCode.version,
        mode: state.startsWith("observe-") ? "observe" : "interrupt",
      };
      await writeFile(
        resolve(evidence, "intent.json"),
        JSON.stringify({
          container,
          owner: id,
          input,
          image: process.artifactImage,
          candidateWorker: candidateWorker
            ? {
                path: resolve(candidateWorker),
                sha256: new Bun.CryptoHasher("sha256")
                  .update(await Bun.file(candidateWorker).arrayBuffer())
                  .digest("hex"),
              }
            : null,
          candidateConnector: candidateConnector
            ? {
                path: resolve(candidateConnector),
                sha256: new Bun.CryptoHasher("sha256")
                  .update(await Bun.file(candidateConnector).arrayBuffer())
                  .digest("hex"),
              }
            : null,
        }),
      );
      intended = true;
      await docker(
        "create",
        "--name",
        container,
        "--label",
        `factory.owned-input-stop=${id}`,
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        ...(connectorProof
          ? [
              "--cap-add=SYS_ADMIN",
              "--cap-add=NET_ADMIN",
              "--cap-add=SETUID",
              "--cap-add=SETGID",
              "--cap-add=SYS_CHROOT",
              "--cap-add=CHOWN",
              "--security-opt=seccomp=unconfined",
              "--env=FACTORY_NATIVE_INPUT_STOP_PACKAGED_PROOF=1",
              "--mount",
              `type=bind,src=${resolve(connectorProof)},dst=/owned/input-stop-tests,readonly`,
            ]
          : []),
        "--security-opt=no-new-privileges",
        "--tmpfs",
        "/tmp",
        "--tmpfs",
        "/workspace",
        ...(!connectorProof && directory !== "/workspace/project" ? ["--tmpfs", directory] : []),
        "--interactive",
        "--mount",
        `type=bind,src=${resolve(project, ".git")},dst=/home/rootless/persist/project/.git`,
        ...(candidateWorker
          ? [
              "--mount",
              `type=bind,src=${resolve(candidateWorker)},dst=/opt/factory/opencode/server/input-stop.mjs,readonly`,
            ]
          : []),
        ...(candidateConnector
          ? [
              "--mount",
              `type=bind,src=${resolve(candidateConnector)},dst=/usr/local/bin/factory-runtime-connector,readonly`,
            ]
          : []),
        "--entrypoint",
        connectorProof ? "/owned/input-stop-tests" : "/opt/factory/opencode/musl/bun",
        process.artifactImage,
        ...(connectorProof
          ? ["-test.run=^TestNativeInputStopPackagedWorker$", "-test.v"]
          : ["/opt/factory/opencode/server/input-stop.mjs"]),
      );
      acknowledged = true;
      const running = Bun.spawn(["docker", "start", "--attach", "--interactive", container], {
        stdin: new Blob([JSON.stringify(input)]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exit, stdout, stderr] = await Promise.all([
        running.exited,
        new Response(running.stdout).text(),
        new Response(running.stderr).text(),
      ]);
      await writeFile(resolve(evidence, "result.json"), JSON.stringify({ exit, stdout, stderr }));
      const expected = [
        "other-root",
        "wrong-model",
        "wrong-version",
        "unsafe-sidecar",
        "observe-queued",
      ].includes(state)
        ? 1
        : 0;
      expect(exit).toBe(expected);
      const reported = connectorProof
        ? stdout.match(/FACTORY_INPUT_STOP_RESULT (\{[^\n]+\})/)?.[1]
        : stdout.trim();
      if (!expected)
        expect(JSON.parse(reported ?? "")).toEqual({
          ...input,
          confirmed: true,
          engineExited: true,
          ...(connectorProof ? { processTreeExited: true } : {}),
        });
      else expect(reported ?? "").toBe("");
      expect(await readFile(resolve(project, "unpublished.txt"), "utf8")).toContain(
        "current Source",
      );
      expect(await Bun.file(resolve(project, ".git/hook-executed")).exists()).toBe(false);
      expect((await process.control()).providerRequests).toBe(before);
      if (state === "unsafe-sidecar")
        expect(await readFile(resolve(project, ".git/owned-sidecar-target"), "utf8")).toBe(
          "Do not mutate this owned sentinel",
        );
      await restoreSidecar();
      await process.control("/restart", "POST");
      await observe(
        () =>
          process.client.server
            .info()
            .then(() => true)
            .catch(() => false),
        (value) => value,
      );
      const queue = await process.client.session.inbox.list({ sessionID });
      if (state === "other-root") expect(queue.map((item) => item.id)).toEqual([otherID]);
      else if (["wrong-model", "wrong-version", "unsafe-sidecar", "observe-queued"].includes(state))
        expect(queue.map((item) => item.id)).toEqual([promptID]);
      else expect(queue).toEqual([]);
      if (state === "queued-tree")
        expect(await process.client.session.inbox.list({ sessionID: childID })).toEqual([]);
      expect((await process.control()).providerRequests).toBe(before);
    } finally {
      try {
        await removeOwnedContainer();
      } finally {
        try {
          await restoreSidecar();
        } finally {
          await process.dispose();
        }
      }
    }
  },
  60_000,
);
