import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { RuntimeHub, type RuntimeSocketData } from "../../apps/factory/src/runtime/hub";
import { hashConnectorToken } from "../../packages/runtime-domain/src/identity";
import { readRuntimeRegistryCA } from "../../packages/runtime-kubernetes/src/client";
import { configuredFactoryboxRuntimeProfile } from "../../packages/runtime-kubernetes/src/factorybox-runtime";
import { runFactoryboxKubernetes } from "../../packages/runtime-kubernetes/src/factorybox-worker";
import { createConformanceRuntime } from "../../scripts/runtime/factorybox-conformance";
import upstream from "../../upstream.json";
import { eventually } from "../fixtures/factory-process";
import {
  type FactoryboxFixtureTarget,
  factoryboxFixtureCommand,
  observeFactoryboxFixture,
} from "../fixtures/factorybox-runtime";
import { archiveFixtureProject } from "../fixtures/project-archive";

test.skipIf(process.env["FACTORY_RUN_PREPARED_PROJECT_FORK_PROOF"] !== "1")(
  "clean Project forks activate fresh Connector authority without restarting their Apps",
  async () => {
    const owner = crypto.randomUUID();
    const projectID = crypto.randomUUID();
    const artifacts = resolve(".factory/test-results/prepared-project-fork", owner);
    const source = resolve(artifacts, "project");
    await mkdir(resolve(source, ".devcontainer"), { recursive: true });
    for (const [name, path] of [
      ["fixture-source.ts", "test/support/prepared-project-fork.live.test.ts"],
      ["project-archive-source.ts", "test/fixtures/project-archive.ts"],
      ["conformance-source.ts", "scripts/runtime/factorybox-conformance.ts"],
    ] as const)
      await writeFile(resolve(artifacts, name), await readFile(path), {
        flag: "wx",
        mode: 0o400,
      });
    const actor =
      'const nonce=require("node:crypto").randomUUID();let counter=0,marker="clean";setInterval(()=>counter++,25);require("node:http").createServer((req,res)=>{if(req.url.startsWith("/mark/"))marker=req.url.slice(6);res.end(JSON.stringify({nonce,pid:process.pid,counter,marker}));}).listen(19472,"0.0.0.0");';
    await writeFile(resolve(source, "server.js"), actor);
    await writeFile(
      resolve(source, ".devcontainer/devcontainer.json"),
      JSON.stringify({
        image: upstream.node.image,
        workspaceFolder: "/workspace/project",
        workspaceMount: "source=/home/coder/project,target=/workspace/project,type=bind",
        remoteUser: "node",
        updateRemoteUserUID: false,
        overrideCommand: true,
        runArgs: ["--cap-drop=NET_RAW", "--cap-drop=SYS_PTRACE", "--cpus=1", "--memory=768m"],
      }),
    );
    async function git(args: string[]) {
      const child = Bun.spawn(["git", "-C", source, ...args], { stdout: "pipe", stderr: "pipe" });
      const output = await new Response(child.stdout).text();
      if ((await child.exited) !== 0)
        throw new Error("Owned clean Project source preparation failed");
      return output.trim();
    }
    await git(["init", "-b", "main"]);
    await git(["remote", "add", "origin", "https://fixture.invalid/clean/project.git"]);
    await git(["config", "factory.repositoryIdentity", projectID]);
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=Factory",
      "-c",
      "user.email=factory@example.invalid",
      "commit",
      "-m",
      "clean template",
    ]);
    const revision = await git(["rev-parse", "HEAD"]);
    const tree = (await archiveFixtureProject(source)).toString("base64");
    const recipe = {
      version: 1,
      runtimeAttemptId: owner,
      generation: 1,
      workspaceFolder: "/home/coder/project",
      remoteWorkspaceFolder: "/workspace/project",
      repositoryUrl: "https://fixture.invalid/clean/project.git",
      repositoryIdentity: projectID,
      preserveWorkspace: false,
      revision,
      devcontainerPath: ".devcontainer/devcontainer.json",
      composeProjectName: `template_${owner.replaceAll("-", "")}`,
      controlUrl: "ws://unassigned.invalid/",
      connectorStateDir: "/home/coder/connector-state",
      channels: [{ name: "app", kind: "app", target: "http://127.0.0.1:19472", healthPath: "/" }],
      processes: [{ name: "app", command: ["node", "server.js"] }],
    };
    const hub = new RuntimeHub(async () => {});
    const connections: Array<{ attemptID: string; role: string }> = [];
    const server = Bun.serve<RuntimeSocketData>({
      hostname: "0.0.0.0",
      port: 0,
      fetch(request, server) {
        const data = hub.authorize(request, hashConnectorToken);
        if (!data) return new Response(null, { status: 401 });
        if (
          server.upgrade(request, {
            data,
            headers: { "sec-websocket-protocol": "factory-runtime-connector-v1" },
          })
        )
          return;
        return new Response(null, { status: 400 });
      },
      websocket: {
        open(socket) {
          if (socket.data.kind !== "connector")
            throw new Error("Owned proof accepted a browser grant");
          connections.push({ attemptID: socket.data.attemptID, role: socket.data.role });
          hub.open(socket);
        },
        message: (socket, message) => hub.message(socket, message),
        close: (socket) => hub.close(socket),
      },
    });
    const runtime = createConformanceRuntime(
      owner,
      process.env["FACTORY_RUNTIME_HOST_IMAGE"] ??
        (await readFile(".factory/runtime-host-image", "utf8")).trim(),
      configuredFactoryboxRuntimeProfile(),
      await readRuntimeRegistryCA(),
      artifacts,
      recipe,
    );
    const sampleSchema = z.object({
      nonce: z.uuid(),
      pid: z.number(),
      counter: z.number(),
      marker: z.string(),
    });
    let targetAttempt = "";
    try {
      await runtime.prepare(async (target, bundle) => {
        const imported = await runFactoryboxKubernetes(
          [
            "exec",
            "-i",
            target.input.podName,
            "-n",
            target.input.namespace,
            "-c",
            "worker",
            "--",
            "python3",
            "-c",
            `import base64,io,json,os,pathlib,tarfile,sys
r=json.load(sys.stdin)
expected='/var/lib/sysbox/fixed-store/data/store/input/'+r['sandboxID']+'/bundle'
if r['bundle']!=expected:raise ValueError('Private prepared input changed')
root=pathlib.Path(expected)/'rootfs/home/coder/project'
if root.exists() or root.is_symlink():raise ValueError('Project import already exists')
root.mkdir()
with tarfile.open(fileobj=io.BytesIO(base64.b64decode(r['tree']))) as archive:
 for member in archive.getmembers():
  p=pathlib.PurePosixPath(member.name)
  if p.is_absolute() or '..' in p.parts or member.issym() or member.islnk() or not (member.isdir() or member.isfile()):raise ValueError('Unsafe source import')
 archive.extractall(root,filter='data')
for base,dirs,files in os.walk(root):
 os.chown(base,1000,1000)
 for name in files:os.chown(pathlib.Path(base)/name,1000,1000)
print('imported')`,
          ],
          JSON.stringify({ sandboxID: target.input.sandboxID, bundle, tree }),
          { timeoutMS: 30_000, outputBytes: 4096 },
        );
        if (imported.exitCode !== 0)
          throw new Error(`Clean source import failed: ${imported.stderr.slice(-1000)}`);
      });
      const sourceTarget = runtime.target();
      await eventually(
        () =>
          factoryboxFixtureCommand(sourceTarget, [
            "sh",
            "-ec",
            "if test -f /home/coder/.factory-reserve/ready; then cat /home/coder/.factory-reserve/ready; fi",
          ]),
        (value) => value === owner,
        "Credential-free Project did not become ready",
        150_000,
      );
      const containerID = (
        await factoryboxFixtureCommand(sourceTarget, [
          "docker",
          "ps",
          "-q",
          "--no-trunc",
          "--filter",
          `label=factory.dev/runtime-attempt=${owner}`,
        ])
      ).trim();
      expect(containerID).toMatch(/^[a-f0-9]{64}$/);
      const sample = async (target: FactoryboxFixtureTarget, path = "/") =>
        sampleSchema.parse(
          JSON.parse(
            await factoryboxFixtureCommand(target, [
              "docker",
              "exec",
              containerID,
              "node",
              "-e",
              `const req=require("node:http").get({host:"127.0.0.1",port:19472,path:${JSON.stringify(path)},agent:false,headers:{connection:"close"}},res=>res.pipe(process.stdout));req.setTimeout(5000,()=>req.destroy(new Error("actor timeout")));req.on("error",()=>process.exit(1));`,
            ]),
          ),
        );
      const initial = await sample(sourceTarget);
      expect(
        (
          await factoryboxFixtureCommand(sourceTarget, [
            "sh",
            "-ec",
            "test ! -e /factory/assignment/parent-token; test ! -e /factory/assignment/child-token; test ! -e /run/factory-parent-token; test ! -e /run/factory-child-token; test ! -e /home/coder/.factory-reserve/activation.json; test ! -e /home/coder/connector-state; echo clean",
          ])
        ).trim(),
      ).toBe("clean");
      expect(connections).toEqual([]);
      const template = await runtime.pause();
      const forks = [];
      for (let index = 0; index < 2; index++) {
        const target = await runtime.fork(crypto.randomUUID(), template.snapshotID);
        expect(await sample(target)).toMatchObject({
          nonce: initial.nonce,
          pid: initial.pid,
          marker: "clean",
        });
        const paused = await runtime.pause(target.input.sandboxID);
        const observed = await observeFactoryboxFixture(target);
        expect(observed.record["pause"]).toMatchObject({
          after: { anon: 0 },
          snapshot: { resident_bytes_after: 0 },
        });
        forks.push({ target, paused });
      }
      expect(connections).toEqual([]);
      const selected = forks[0];
      if (!selected) throw new Error("Prepared fork missing");
      targetAttempt = crypto.randomUUID();
      const parentToken = crypto.randomUUID();
      const childToken = crypto.randomUUID();
      hub.allow(targetAttempt, 7, hashConnectorToken(parentToken), hashConnectorToken(childToken));
      const started = performance.now();
      await runtime.resume(selected.target.input.sandboxID, selected.paused.snapshotID);
      await factoryboxFixtureCommand(
        selected.target,
        [
          "sh",
          "-ec",
          "umask 077; test ! -e /home/coder/.factory-reserve/activation.json; cat > /home/coder/.factory-reserve/activation.json",
        ],
        30_000,
        undefined,
        JSON.stringify({
          slotId: selected.target.input.attemptID,
          templateId: owner,
          podUID: selected.target.identity.podUID,
          parentToken,
          childToken,
          assignment: {
            ...recipe,
            runtimeAttemptId: targetAttempt,
            generation: 7,
            composeProjectName: `assigned_${targetAttempt.replaceAll("-", "")}`,
            controlUrl: `ws://host.orb.internal:${server.port}/internal/runtime-connect`,
          },
        }),
      );
      await eventually(
        async () => hub.connected(targetAttempt),
        (value) => value,
        "Prepared fork did not acquire its fresh Connector authority",
        30_000,
      );
      const useful = await sample(selected.target, "/mark/slot-a");
      const readyMS = Math.round(performance.now() - started);
      expect(useful).toMatchObject({ nonce: initial.nonce, pid: initial.pid, marker: "slot-a" });
      expect(useful.counter).toBeGreaterThan(initial.counter);
      expect(connections.map((value) => value.attemptID)).toEqual([targetAttempt, targetAttempt]);
      const proxied = await hub.request(
        targetAttempt,
        "app",
        new Request("http://fixture.invalid/"),
        "/",
      );
      expect(sampleSchema.parse(await proxied.json())).toMatchObject({
        nonce: initial.nonce,
        marker: "slot-a",
      });
      const other = forks[1];
      if (!other) throw new Error("Second prepared fork missing");
      expect((await observeFactoryboxFixture(other.target)).record.phase).toBe("paused");
      await writeFile(
        resolve(artifacts, "warm-activation.json"),
        JSON.stringify({
          passed: true,
          recipe,
          containerID,
          initial,
          useful,
          readyMS,
          freshConnectorAuthorityOnlyAfterAssignment: true,
          preparedAppNotRestarted: true,
          initialUnusedPausedForks: 2,
          remainingUnusedPausedForks: 1,
          connectorWarmActivationProved: true,
          productionPoolAssignmentProved: false,
        }),
        { flag: "wx", mode: 0o600 },
      );
      await runtime.passed();
    } finally {
      if (targetAttempt) hub.revoke(targetAttempt);
      await server.stop(true);
      await runtime.cleanup();
    }
  },
  420_000,
);
