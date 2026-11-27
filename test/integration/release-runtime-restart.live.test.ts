import { expect, test } from "bun:test";
import { runCommand } from "#runtime-kubernetes/command";
import { requireSubstrateActor } from "../../apps/factory/src/runtime/substrate";
import { eventually } from "../fixtures/factory-process";
import { readNativeWorkspaceObservation } from "../fixtures/native-workspace-observation";
import {
  readReleaseNativeBinding,
  readReleaseNativeTemplate,
  releaseInstallation,
} from "../fixtures/release-installation";
import { runtimeAccessCookie } from "../fixtures/runtime-access";

const installation = process.env["FACTORY_RELEASE_INSTALLATION"];
test.skipIf(!installation)(
  "ready native Ticket and Staging reconnect to the same attempts after restart",
  async () => {
    if (!installation) throw new Error("Explicit disposable installation required");
    const f = await releaseInstallation(installation);
    try {
      const { projectID, dependentChangeID } = f.state;
      if (!projectID || !dependentChangeID) throw new Error("Complete release journey required");
      const selected = await f.database.client<{ id: string; kind: string }[]>`
        SELECT runtime_attempt_id AS id,'ticket' AS kind FROM factory.change
          WHERE id=${dependentChangeID} AND project_id=${projectID}
        UNION ALL SELECT (payload->>'runtimeAttemptId')::uuid,'staging' FROM factory.operation
          WHERE kind='delivery.staging_preview' AND scope_type='project' AND scope_id=${projectID}
        ORDER BY kind`;
      expect(selected.map(({ kind }) => kind)).toEqual(["staging", "ticket"]);
      expect(new Set(selected.map(({ id }) => id)).size).toBe(2);
      const cookie = await f.login("developer");
      const grants = new Map<string, string>();
      const authorize = async () => {
        for (const { id } of selected)
          grants.set(id, await runtimeAccessCookie(f.base, cookie, id, "app"));
      };
      await authorize();
      const originals = new Map<string, Awaited<ReturnType<typeof readReleaseNativeBinding>>>();
      const read = async () => {
        const observations = [];
        for (const { id, kind } of selected) {
          const binding = await readReleaseNativeBinding(f.database, projectID, id);
          const original = originals.get(id);
          if (original) {
            expect(binding.intent).toEqual(original.intent);
            expect(binding.actorUID).toBe(original.actorUID);
          } else originals.set(id, binding);
          if (kind === "ticket") {
            if (!binding.workspaceID) throw new Error("Release Ticket has no original Workspace");
            await readNativeWorkspaceObservation(f.database, {
              attemptID: id,
              projectID,
              workspaceID: binding.workspaceID,
              actorUID: binding.actorUID,
            });
          } else {
            expect(binding.workspaceID).toBeNull();
            expect(binding.intent).toMatchObject({ isolatedKind: "staging" });
          }
          expect(binding.state).toBe("ready");
          expect(binding.stopIntendedAt).toBeNull();
          expect(binding.deletedAt).toBeNull();
          const native = f.native(binding.intent.connection);
          await readReleaseNativeTemplate(native, binding);
          const actor = requireSubstrateActor(
            await native.call("GetActor", {
              actor: { atespace: binding.atespace, name: binding.actorName },
            }),
            binding,
          );
          expect(actor.status.state).toBe("ACTOR_STATE_RUNNING");
          expect(actor.status.lastAssignedGeneration).toBeGreaterThan(0);
          // This route calls runtime.get and requires both current Connector
          // connections through hub.use. A saved ready row cannot satisfy it.
          const grant = grants.get(id);
          if (!grant) throw new Error("Current runtime access grant missing");
          const activity = await fetch(`${f.base}/runtime/${id}/app/__factory/activity`, {
            method: "POST",
            headers: { cookie: grant, origin: f.base },
            signal: AbortSignal.timeout(15_000),
          });
          await activity.body?.cancel();
          const after = requireSubstrateActor(
            await native.call("GetActor", {
              actor: { atespace: binding.atespace, name: binding.actorName },
            }),
            binding,
          );
          expect(after.status.state).toBe("ACTOR_STATE_RUNNING");
          expect(after.status.lastAssignedGeneration).toBe(actor.status.lastAssignedGeneration);
          observations.push({
            id,
            kind,
            workspaceID: binding.workspaceID,
            actorUID: actor.metadata.uid,
            generation: binding.generation,
            templateUID: binding.intent.templateUID,
            templateVersion: binding.intent.templateVersion,
            templateSHA256: binding.intent.templateSHA256,
            allocation: actor.status.lastAssignedGeneration,
            connected: activity.status === 204,
          });
        }
        return observations;
      };
      const before = await eventually(
        read,
        (rows) => rows.every((row) => row.connected),
        "Native Ticket and Staging not connected before restart",
        300_000,
      );
      const startup = async () => {
        const response = await fetch(`${f.base}/health/ready`, {
          signal: AbortSignal.timeout(10_000),
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("x-open-factory")).toBe("ready");
        const id = response.headers.get("x-open-factory-startup");
        await response.body?.cancel();
        if (!id) throw new Error("Factory startup identity missing");
        return id;
      };
      const previousStartup = await startup();
      const turns = await f.database
        .client`SELECT id, state FROM factory.agent_turn WHERE project_id = ${projectID} ORDER BY id`;
      const started = Date.now();
      const restarted = await runCommand(
        [process.execPath, "scripts/factory/index.ts", "restart", "--disposable", installation],
        undefined,
        { timeoutMS: 300_000, outputBytes: 4 << 20 },
      );
      f.noSecrets(restarted.stdout + restarted.stderr);
      expect(restarted.exitCode).toBe(0);
      const currentStartup = await startup();
      expect(currentStartup).not.toBe(previousStartup);
      // App grants are process-local. Reauthenticate through the normal issuer
      // after restart, rather than treating the old cookie as current authority.
      await authorize();
      const after = await eventually(
        read,
        (rows) => rows.every((row) => row.connected),
        "Current native Ticket and Staging connectors did not reconnect",
        90_000,
      );
      await f.record("native-restart", {
        before,
        after,
        previousStartup,
        currentStartup,
        elapsedMS: Date.now() - started,
      });
      expect([...after]).toEqual([...before]);
      expect([
        ...(await f.database
          .client`SELECT id, state FROM factory.agent_turn WHERE project_id = ${projectID} ORDER BY id`),
      ]).toEqual([...turns]);
    } finally {
      await f.close();
    }
  },
  420_000,
);
