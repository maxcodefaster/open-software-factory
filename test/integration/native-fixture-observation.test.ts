import { expect, test } from "bun:test";
import { z } from "zod";
import { nativeActor } from "../../packages/runtime-kubernetes/src/substrate-control";
import { nativeRuntimeFixture } from "../fixtures/native-runtime";
import { readNativeWorkspaceObservation } from "../fixtures/native-workspace-observation";
import {
  readReleaseNativeBinding,
  readReleaseNativeTemplate,
} from "../fixtures/release-installation";

test("native fixture evidence reads the saved original Actor binding without worker exec, liveness claims or capabilities", async () => {
  const f = await nativeRuntimeFixture();
  try {
    const runtime = f.controller();
    const started = await runtime.start(f.projectID, f.userID);
    if (!started) throw Error("Owned native fixture was not admitted");
    const selected = {
      attemptID: started.id,
      projectID: f.projectID,
      workspaceID: f.workspaceID,
      actorUID: z.uuid().parse(started.native?.actorUID),
    };
    await f.database
      .client`UPDATE factory.runtime_attempt SET state='ready' WHERE id=${started.id}`;
    const calls = f.calls.length;
    const result = await readNativeWorkspaceObservation(f.database, selected);
    expect(result).toMatchObject({
      ...selected,
      generation: "1",
      scope: "recorded-native-binding",
      coldRestart: true,
      currentLivenessProven: false,
    });
    expect(result.atespace).toBe(`fa-${started.id.replaceAll("-", "")}`);
    expect(JSON.stringify(result)).not.toMatch(
      /token|credential|connection|assignment|bootstrap|kubernetes/i,
    );
    expect(f.calls).toHaveLength(calls);
    const binding = await readReleaseNativeBinding(f.database, f.projectID, started.id);
    expect(binding).toMatchObject({
      id: started.id,
      projectID: f.projectID,
      workspaceID: f.workspaceID,
      generation: 1,
      actorUID: selected.actorUID,
      intent: { connection: f.configuration.connection },
    });
    const resources = f.resources.get(binding.atespace);
    if (!resources) throw Error("Owned native resource scope missing");
    const originalTemplate = resources.get("ActorTemplate");
    if (!originalTemplate) throw Error("Owned frozen native template missing");
    let template = originalTemplate;
    const native = {
      async call(method: string) {
        if (method === "GetAtespace") return resources.get("Atespace");
        if (method === "GetActorTemplate") return template;
        throw Error("Unexpected release native observation");
      },
      async credential() {
        throw Error("Binding proof must not read credentials");
      },
    };
    expect(await readReleaseNativeTemplate(native, binding)).toBe(originalTemplate);
    template = {
      ...originalTemplate,
      metadata: { ...(originalTemplate["metadata"] as object), version: "999" },
    };
    await expect(readReleaseNativeTemplate(native, binding)).rejects.toThrow(
      "frozen original binding",
    );
    await expect(
      readReleaseNativeBinding(f.database, crypto.randomUUID(), started.id),
    ).rejects.toThrow("no confirmed");
    expect(f.calls).toHaveLength(calls);
    for (const field of ["projectID", "workspaceID", "actorUID"] as const)
      await expect(
        readNativeWorkspaceObservation(f.database, { ...selected, [field]: crypto.randomUUID() }),
      ).rejects.toThrow("original saved binding");
    const [saved] = await f.database
      .client`SELECT observation FROM factory.substrate_binding WHERE runtime_attempt_id=${started.id}`;
    if (!saved) throw Error("Saved native observation missing");
    for (const mutate of [
      (row: ReturnType<typeof nativeActor.parse>) => {
        row.metadata.uid = crypto.randomUUID();
      },
      (row: ReturnType<typeof nativeActor.parse>) => {
        row.actorTemplate.name = "foreign";
      },
      (row: ReturnType<typeof nativeActor.parse>) => {
        row.workerSelector = { matchLabels: {} };
      },
      (row: ReturnType<typeof nativeActor.parse>) => {
        row.status.state = "ACTOR_STATE_SUSPENDED";
      },
      (row: ReturnType<typeof nativeActor.parse>) => {
        row.status.workerAssignment = {
          sandboxRuntime: {
            ...f.configuration.runtime,
            version: {
              schemaVersion: "v1",
              attributes: [{ key: "architecture", value: "foreign" }],
            },
          },
        };
      },
    ]) {
      const observation = nativeActor.parse(structuredClone(saved["observation"]));
      mutate(observation);
      await f.database
        .client`UPDATE factory.substrate_binding SET observation=${JSON.stringify(observation)}::jsonb WHERE runtime_attempt_id=${started.id}`;
      await expect(readNativeWorkspaceObservation(f.database, selected)).rejects.toThrow(
        "original saved binding",
      );
    }
    await f.database
      .client`UPDATE factory.substrate_binding SET observation=${JSON.stringify(saved["observation"])}::jsonb WHERE runtime_attempt_id=${started.id}`;
    await f.database
      .client`UPDATE factory.runtime_attempt SET stop_intended_at=now() WHERE id=${started.id}`;
    await expect(readNativeWorkspaceObservation(f.database, selected)).rejects.toThrow();
    expect(f.calls).toHaveLength(calls);
  } finally {
    await f.dispose();
  }
}, 60_000);
