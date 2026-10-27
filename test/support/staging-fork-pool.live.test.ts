import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { readRuntimeRegistryCA } from "../../packages/runtime-kubernetes/src/client";
import { configuredFactoryboxRuntimeProfile } from "../../packages/runtime-kubernetes/src/factorybox-runtime";
import { createConformanceRuntime } from "../../scripts/runtime/factorybox-conformance";
import upstream from "../../upstream.json";
import {
  type FactoryboxFixtureTarget,
  factoryboxFixtureCommand,
  observeFactoryboxFixture,
} from "../fixtures/factorybox-runtime";

// This qualifies the real project-process copy needed by the pool. It is not
// evidence that Factory's database controller already assigns these forks.
test.skipIf(process.env["FACTORY_RUN_STAGING_FORK_PROOF"] !== "1")(
  "two paused native forks retain a clean running Dev Container without Factory capabilities",
  async () => {
    const owner = crypto.randomUUID();
    const artifacts = resolve(".factory/test-results/staging-fork-pool", owner);
    await mkdir(artifacts, { recursive: true });
    for (const [name, path] of [
      ["fixture-source.ts", "test/support/staging-fork-pool.live.test.ts"],
      ["adapter-source.ts", "packages/runtime-kubernetes/src/factorybox-worker.ts"],
      ["lifecycle-source.ts", "scripts/runtime/factorybox-conformance.ts"],
    ] as const)
      await writeFile(resolve(artifacts, name), await readFile(path, "utf8"), {
        flag: "wx",
        mode: 0o400,
      });
    const image = (
      process.env["FACTORY_RUNTIME_CONFORMANCE_IMAGE"] ??
      process.env["FACTORY_RUNTIME_HOST_IMAGE"] ??
      (await readFile(".factory/runtime-host-image", "utf8"))
    ).trim();
    const runtime = createConformanceRuntime(
      owner,
      image,
      configuredFactoryboxRuntimeProfile(),
      await readRuntimeRegistryCA(),
      artifacts,
    );
    const actor =
      'const nonce=require("node:crypto").randomUUID();let counter=0,marker="clean";setInterval(()=>counter++,25);require("node:http").createServer((req,res)=>{if(req.url.startsWith("/mark/"))marker=req.url.slice(6);res.end(JSON.stringify({nonce,pid:process.pid,counter,marker}));}).listen(19472,"0.0.0.0");';
    const configuration = {
      image: upstream.node.image,
      workspaceFolder: "/workspace/project",
      workspaceMount: "source=/home/coder/project,target=/workspace/project,type=bind",
      remoteUser: "node",
      updateRemoteUserUID: false,
      overrideCommand: true,
      postCreateCommand: [
        "node",
        "-e",
        `const child=require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(actor)}],{detached:true,stdio:"ignore"});child.unref();`,
      ],
    };
    const sampleSchema = z.object({
      nonce: z.uuid(),
      pid: z.number().int().positive(),
      counter: z.number().int().nonnegative(),
      marker: z.string(),
    });
    const command = (target: FactoryboxFixtureTarget, args: string[], timeout = 30_000) =>
      factoryboxFixtureCommand(target, args, timeout);
    const noCapabilities = (target: FactoryboxFixtureTarget) =>
      command(target, [
        "sh",
        "-ec",
        "test ! -e /run/factory-parent-token; test ! -e /run/factory-child-token; test ! -e /home/coder/.factory-reserve/activation.json; test ! -e /factory/assignment/parent-token; test ! -e /factory/assignment/child-token; echo clean",
      ]);
    try {
      await runtime.prepare();
      const source = runtime.target();
      await command(source, [
        "sh",
        "-ec",
        'i=0; until test -f /home/coder/.factory-reserve/ready; do i=$((i+1)); test "$i" -le 60; sleep 0.5; done',
      ]);
      await command(source, [
        "node",
        "-e",
        `const fs=require("node:fs");fs.mkdirSync("/home/coder/project/.devcontainer",{recursive:true});fs.writeFileSync("/home/coder/project/.devcontainer/devcontainer.json",${JSON.stringify(JSON.stringify(configuration))});`,
      ]);
      await command(source, [
        "sh",
        "-ec",
        "git -C /home/coder/project init -b main; git -C /home/coder/project add .; git -C /home/coder/project -c user.name=Factory -c user.email=factory@example.invalid commit -m template; chown -R 1000:1000 /home/coder/project",
      ]);
      const created = z
        .object({ outcome: z.literal("success"), containerId: z.string().min(1) })
        .parse(
          JSON.parse(
            await command(
              source,
              [
                "devcontainer",
                "up",
                "--workspace-folder",
                "/home/coder/project",
                "--id-label",
                `factory.dev/runtime-attempt=${owner}`,
                "--id-label",
                "factory.dev/runtime-generation=0",
              ],
              120_000,
            ),
          ),
        );
      const containerID = created.containerId;
      const revision = (
        await command(source, [
          "git",
          "-c",
          "safe.directory=/home/coder/project",
          "-C",
          "/home/coder/project",
          "rev-parse",
          "HEAD",
        ])
      ).trim();
      expect(revision).toMatch(/^[a-f0-9]{40}$/);
      const sample = async (target: FactoryboxFixtureTarget, path = "/") =>
        sampleSchema.parse(
          JSON.parse(
            await command(target, [
              "docker",
              "exec",
              containerID,
              "node",
              "-e",
              `const req=require("node:http").get({host:"127.0.0.1",port:19472,path:${JSON.stringify(path)},agent:false,headers:{connection:"close"}},res=>res.pipe(process.stdout));req.setTimeout(5000,()=>req.destroy(new Error("actor timeout")));req.on("error",()=>process.exit(1));`,
            ]),
          ),
        );
      const initial = await sample(source);
      expect((await noCapabilities(source)).trim()).toBe("clean");
      expect(
        (
          await command(source, [
            "git",
            "-c",
            "safe.directory=/home/coder/project",
            "-C",
            "/home/coder/project",
            "status",
            "--porcelain",
          ])
        ).trim(),
      ).toBe("");
      // Image acquisition can leave dockerd's idle HTTPS keep-alive sockets
      // open. Never copy or forcibly close external connections. Wait for the
      // private daemon to release its own sockets before capturing a template.
      const acquisitionSockets = await command(
        source,
        [
          "node",
          "-e",
          `const fs=require("node:fs");
const started=Date.now(),observations=[];
function sockets(){
 const pid=fs.readFileSync("/var/run/docker.pid","utf8").trim();
 if(!/^[1-9][0-9]*$/.test(pid)||fs.readFileSync("/proc/"+pid+"/comm","utf8").trim()!=="dockerd")throw Error("Private dockerd identity unavailable");
 const held=new Set(fs.readdirSync("/proc/"+pid+"/fd").flatMap(fd=>{try{return [fs.readlinkSync("/proc/"+pid+"/fd/"+fd).match(/^socket:\\[(\\d+)\\]$/)?.[1]]}catch{return []}}));
 return ["tcp","tcp6"].flatMap(name=>fs.readFileSync("/proc/"+pid+"/net/"+name,"utf8").trim().split("\\n").slice(1).map(line=>line.trim().split(/\\s+/)).filter(fields=>fields[3]==="01"&&held.has(fields[9])).map(fields=>({family:name,local:fields[1],peer:fields[2],inode:fields[9]})));
}
(async()=>{for(;;){const open=sockets();observations.push({elapsedMS:Date.now()-started,sockets:open});if(!open.length){console.log(JSON.stringify({quiescent:true,observations}));return}if(Date.now()-started>=105000){console.log(JSON.stringify({quiescent:false,observations}));return}await new Promise(resolve=>setTimeout(resolve,1000));}})().catch(error=>{console.error(error.message);process.exitCode=1;});`,
        ],
        110_000,
      );
      await writeFile(resolve(artifacts, "acquisition-sockets.json"), acquisitionSockets, {
        flag: "wx",
        mode: 0o600,
      });
      expect(JSON.parse(acquisitionSockets).quiescent).toBe(true);
      const template = await runtime.pause();
      const slots: Array<{
        target: FactoryboxFixtureTarget;
        snapshotID: string;
        first: z.infer<typeof sampleSchema>;
        preparationMS: number;
      }> = [];
      for (let index = 0; index < 2; index++) {
        const startedAt = performance.now();
        const target = await runtime.fork(crypto.randomUUID(), template.snapshotID);
        const first = await sample(target);
        expect(first.nonce).toBe(initial.nonce);
        expect(first.pid).toBe(initial.pid);
        expect(first.counter).toBeGreaterThanOrEqual(initial.counter);
        expect(first.marker).toBe("clean");
        expect((await noCapabilities(target)).trim()).toBe("clean");
        if (index === 0) {
          expect((await sample(target, "/mark/slot-a")).marker).toBe("slot-a");
          await command(target, ["sh", "-ec", "printf slot-a >/home/coder/project/slot-only"]);
        } else {
          expect(
            (
              await command(target, [
                "sh",
                "-ec",
                "test ! -e /home/coder/project/slot-only; echo isolated",
              ])
            ).trim(),
          ).toBe("isolated");
        }
        const standby = await runtime.pause(target.input.sandboxID);
        slots.push({
          target,
          snapshotID: standby.snapshotID,
          first,
          preparationMS: performance.now() - startedAt,
        });
      }
      for (const slot of slots)
        expect((await observeFactoryboxFixture(slot.target)).record.phase).toBe("paused");
      const selected = slots[0];
      if (!selected) throw new Error("Missing first owned standby");
      const resumedAt = performance.now();
      await runtime.resume(selected.target.input.sandboxID, selected.snapshotID);
      const useful = await sample(selected.target);
      const resumeToUsefulMS = performance.now() - resumedAt;
      expect(useful.nonce).toBe(initial.nonce);
      expect(useful.pid).toBe(initial.pid);
      expect(useful.marker).toBe("slot-a");
      expect(useful.counter).toBeGreaterThan(selected.first.counter);
      await runtime.pause(selected.target.input.sandboxID);
      await writeFile(
        resolve(artifacts, "project-forks.json"),
        `${JSON.stringify(
          {
            owner,
            image,
            revision,
            projectImage: upstream.node.image,
            configuration,
            containerID,
            initial,
            templateSnapshotID: template.snapshotID,
            slots: slots.map(({ target, snapshotID, first, preparationMS }) => ({
              sandboxID: target.input.sandboxID,
              snapshotID,
              first,
              preparationMS,
            })),
            useful,
            resumeToUsefulMS,
            noFactoryCapabilitiesAtCapture: true,
            separateRAMAndFilesystems: true,
            productionPoolAssignmentProved: false,
          },
          null,
          2,
        )}\n`,
        { flag: "wx", mode: 0o600 },
      );
      await runtime.passed();
    } finally {
      await runtime.cleanup();
    }
  },
  420_000,
);
