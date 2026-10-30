import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  retainedStopInput,
  retainedStopResult,
} from "../../apps/factory/src/agent/retained-stop-contract";
import { factoryBuildDirectory } from "../../apps/factory/src/build-directory";
import { factoryboxLocation } from "../../packages/runtime-kubernetes/src/factorybox-location";
import { renderRetainedStopPod } from "../../packages/runtime-kubernetes/src/retained-stop";
import upstream from "../../upstream.json";
import { buildModelID } from "../fixtures/change-agent-turns";
import { docker, observe, pinnedOpenCode } from "../fixtures/pinned-opencode";

test.each(["empty", "queued", "other-queued", "wrong-model"] as const)(
  "retained native Stop settles only its exact input without inference or Project hooks: %s",
  async (state) => {
    const process = await pinnedOpenCode();
    const sessionID = `ses_owned_${crypto.randomUUID().replaceAll("-", "")}`;
    const promptID = `msg_owned_${crypto.randomUUID().replaceAll("-", "")}`;
    const otherID = `${promptID}_other`;
    const marker = resolve(process.scratch, "project", "manual-draft.txt");
    const maintenanceID = crypto.randomUUID();
    const maintenanceName = `factory-owned-retained-stop-${maintenanceID}`;
    let maintenanceIntended = false;
    async function cleanupMaintenance() {
      if (!maintenanceIntended) return;
      const owner = await docker(
        "inspect",
        "--format",
        '{{index .Config.Labels "factory.owned-retained-stop"}}',
        maintenanceName,
      ).catch((cause: unknown) => {
        if (cause instanceof Error && /no such (?:object|container)/i.test(cause.message))
          return null;
        throw cause;
      });
      if (owner === null) return;
      if (owner !== maintenanceID) throw new Error("Owned retained Stop cleanup refused");
      await docker("rm", "--force", "--volumes", maintenanceName);
    }
    try {
      await docker(
        "exec",
        process.container,
        "git",
        "-C",
        "/workspace/project",
        "init",
        "-b",
        "main",
      );
      await process.client.session.create({
        id: sessionID,
        title: "Retained native Stop proof",
        location: { directory: "/workspace/project" },
        model: { providerID: "factory", id: buildModelID },
      });
      await process.client.session.switchAgent({ sessionID, agent: "build" });
      const history = await process.client.message.list({ sessionID, limit: 100 });
      if (state !== "empty")
        await process.client.session.prompt({
          sessionID,
          id: promptID,
          text: "This retained input must never run.",
          delivery: "queue",
          resume: false,
        });
      if (state === "other-queued")
        await process.client.session.prompt({
          sessionID,
          id: otherID,
          text: "Another retained input must not be discarded.",
          delivery: "queue",
          resume: false,
        });
      await Bun.write(marker, "The developer's unsaved-to-Git work stays intact.\n");
      expect((await process.control()).providerRequests).toBe(0);
      await process.control("/kill", "POST");
      const hook = resolve(process.scratch, "project", ".git", "hooks", "unsafe-monitor");
      await Bun.write(hook, "#!/bin/sh\nprintf forbidden > /native-session/hook-executed\n");
      await docker(
        "exec",
        process.container,
        "chmod",
        "755",
        "/workspace/project/.git/hooks/unsafe-monitor",
      );
      await docker(
        "exec",
        process.container,
        "git",
        "-C",
        "/workspace/project",
        "config",
        "core.fsmonitor",
        "/native-session/hooks/unsafe-monitor",
      );
      const input = retainedStopInput.parse({
        stopID: crypto.randomUUID(),
        attemptID: crypto.randomUUID(),
        sessionID,
        promptID,
        modelID: state === "wrong-model" ? "another-model" : buildModelID,
        version: upstream.openCode.version,
      });
      const runner = await Bun.file(
        resolve(factoryBuildDirectory(), "retained-stop-runner.mjs"),
      ).text();
      const workspaceID = crypto.randomUUID();
      const workerID = crypto.randomUUID();
      const declaration = renderRetainedStopPod(
        {
          ...input,
          workspaceID,
          projectID: crypto.randomUUID(),
          workerID,
          namespace: factoryboxLocation(workerID).namespace,
          namespaceUID: crypto.randomUUID(),
          claimUID: crypto.randomUUID(),
          sourcePodName: "owned-source",
          sourcePodUID: crypto.randomUUID(),
          storageNode: "owned-node",
          sourceDirectory: `workspaces/${workspaceID.replaceAll("-", "")}/home`,
          image: `owned/consumer@sha256:${"a".repeat(64)}`,
          runnerSHA256: createHash("sha256").update(runner).digest("hex"),
          input,
        },
        runner,
      );
      const nativeCommand = declaration.spec.containers[0]?.command;
      if (!nativeCommand) throw new Error("Owned native Stop command is absent");
      const started = performance.now();
      const evidence = resolve(".factory/test-results/opencode-process", maintenanceID);
      await mkdir(evidence, { recursive: true });
      await Bun.write(
        resolve(evidence, "intent.json"),
        JSON.stringify({
          container: maintenanceName,
          owner: maintenanceID,
          image: process.artifactImage,
          source: resolve(process.scratch, "project", ".git"),
          purpose: "Owned native Stop with no Project mount or provider capabilities",
        }),
      );
      maintenanceIntended = true;
      const operation = Bun.spawn(
        [
          "docker",
          "run",
          "--name",
          maintenanceName,
          "--label",
          `factory.owned-retained-stop=${maintenanceID}`,
          "--cpus=1",
          "--memory=1g",
          "--network=none",
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,size=256m",
          "--tmpfs",
          "/workspace/project:ro,nosuid,nodev,size=1m",
          "--mount",
          `type=bind,src=${resolve(process.scratch, "project", ".git")},dst=/native-session`,
          "--env",
          `FACTORY_RETAINED_STOP=${JSON.stringify(input)}`,
          "--entrypoint",
          nativeCommand[0] ?? "",
          process.artifactImage,
          ...nativeCommand.slice(1),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [code, output, error] = await Promise.all([
        operation.exited,
        new Response(operation.stdout).text(),
        new Response(operation.stderr).text(),
      ]);
      console.log("Retained native Stop observation", {
        state,
        elapsedMS: Math.round(performance.now() - started),
        code,
      });
      if (state === "empty" || state === "queued") {
        expect({ code, error }, output).toEqual({ code: 0, error: "" });
        expect(retainedStopResult.parse(JSON.parse(output))).toEqual({
          ...input,
          confirmed: true,
          nativeProcessExited: true,
        });
      } else {
        expect(code).toBe(1);
        expect(output).toBe("");
        expect(error).toContain("Retained native Stop could not be confirmed");
      }
      expect((await process.control()).providerRequests).toBe(0);
      expect(
        await Bun.file(resolve(process.scratch, "project", ".git", "hook-executed")).exists(),
      ).toBe(false);
      expect(await Bun.file(marker).text()).toBe(
        "The developer's unsaved-to-Git work stays intact.\n",
      );
      await docker(
        "exec",
        process.container,
        "git",
        "-C",
        "/workspace/project",
        "config",
        "--unset",
        "core.fsmonitor",
      );
      await process.control("/restart", "POST");
      await observe(
        () => process.client.server.info().catch(() => null),
        Boolean,
        "Original native observation did not become available",
        45_000,
      );
      expect(await process.client.message.list({ sessionID, limit: 100 })).toEqual(history);
      const queue = await process.client.session.inbox.list({ sessionID });
      expect(queue.map((item) => item.id)).toEqual(
        state === "other-queued" ? [otherID] : state === "wrong-model" ? [promptID] : [],
      );
      expect((await process.control()).providerRequests).toBe(0);
    } finally {
      await cleanupMaintenance().finally(() => process.dispose());
    }
  },
  120_000,
);
