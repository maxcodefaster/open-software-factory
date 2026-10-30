import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRuntimeController } from "../../apps/factory/src/runtime/controller";
import { createFactoryboxExecution } from "../../apps/factory/src/runtime/factorybox";
import { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import { createKubernetesClient } from "../../packages/runtime-kubernetes/src/client";
import { factoryboxRuntimeDeclaration } from "../../packages/runtime-kubernetes/src/factorybox-runtime";
import { fixture } from "../fixtures/change-agent-turns";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import {
  installOwnedRuntimeConfiguration,
  ownedFactoryboxProfile,
  ownedRuntimeConfiguration,
} from "../fixtures/runtime-configuration";

let restoreConfiguration: () => void;
beforeAll(() => {
  restoreConfiguration = installOwnedRuntimeConfiguration();
});
afterAll(() => restoreConfiguration());

test.each(["Failed", "Succeeded"])(
  "recovery settles a %s original worker without leaving implementation preparing or replacing shared resources",
  async (phase) => {
    const host = await factoryProcess();
    const database = host.connect();
    const owned = await fixture(undefined, undefined, database);
    const hub = new RuntimeHub(async () => {});
    let privateCleanup = 0;
    let nativeCleanup = 0;
    let controller: ReturnType<typeof createRuntimeController> | undefined;
    try {
      const [attempt] = await database.client<
        { namespace: string; podName: string; workerID: string }[]
      >`SELECT kubernetes_namespace AS namespace,kubernetes_pod_name AS "podName",
        factorybox_worker_id AS "workerID" FROM factory.runtime_attempt WHERE id=${owned.attemptID}`;
      if (!attempt) throw new Error("Owned original worker missing");
      const declaration = factoryboxRuntimeDeclaration({
        ...attempt,
        attemptID: owned.attemptID,
        sandboxID: `runtime-${owned.attemptID.replaceAll("-", "")}`,
        runtimeOwnerID: owned.workspaceID,
        labels: { "factory.dev/runtime-owner": owned.workspaceID },
        runtimeHostImage: ownedRuntimeConfiguration.FACTORY_RUNTIME_HOST_IMAGE,
        profile: ownedFactoryboxProfile,
        sharedSource: true,
      });
      await database.client`UPDATE factory.runtime_attempt SET state='starting',
        kubernetes_uid='original-worker',kubernetes_namespace_uid='original-namespace',
        failure='Factorybox startup deadline expired; original execution was retained'
        WHERE id=${owned.attemptID}`;
      controller = createRuntimeController(
        database,
        hub,
        "owned-terminal-worker",
        {
          async prepareExecution() {
            throw new Error("Recovery must not prepare source");
          },
        },
        {
          ...createKubernetesClient(),
          async getPod() {
            return {
              uid: "original-worker",
              phase,
              ready: false,
              labels: {},
              factoryboxImage: ownedFactoryboxProfile.image,
              runtimeHostImage: ownedRuntimeConfiguration.FACTORY_RUNTIME_HOST_IMAGE,
            };
          },
          async deleteSecret(input) {
            expect(input.namespaceUID).toBe("original-namespace");
            expect(input.attemptID).toBe(owned.attemptID);
            privateCleanup++;
          },
          async apply() {
            throw new Error("Recovery must not create another resource");
          },
          async deletePod() {
            throw new Error("Recovery must retain the original worker");
          },
          async deleteNamespace() {
            throw new Error("Recovery must retain canonical Source and shared storage");
          },
        },
        async () => "",
        undefined,
        {
          ...createFactoryboxExecution(database, hub),
          async startupResources() {
            return [declaration.pod];
          },
          async ensureStarted() {
            throw new Error("A terminal worker must never dispatch native Start");
          },
          async deleteSandbox(attemptID) {
            expect(attemptID).toBe(owned.attemptID);
            nativeCleanup++;
          },
        },
      );
      const currentController = controller;
      const observe = await currentController.recover();
      observe();
      await eventually(
        () => currentController.get(owned.attemptID),
        (current) => current?.state === "failed",
        "A known terminal worker left implementation preparing indefinitely",
        3_000,
      );
      const retained = await controller.get(owned.attemptID);
      expect(retained?.failure).toContain("Original Factorybox worker terminated");
      expect(retained?.failure).not.toContain("deadline expired");
      expect(privateCleanup).toBe(1);
      expect(nativeCleanup).toBe(1);
      expect(
        (
          await database.client`SELECT kubernetes_uid,kubernetes_namespace_uid
          FROM factory.runtime_attempt WHERE id=${owned.attemptID}`
        )[0],
      ).toEqual({
        kubernetes_uid: "original-worker",
        kubernetes_namespace_uid: "original-namespace",
      });
      expect(
        (
          await database.client`SELECT state,requirement_approval_id FROM factory.change
          WHERE id=${owned.changeID}`
        )[0],
      ).toMatchObject({ state: "failed" });
      expect(
        await database.client`SELECT id FROM factory.development_workspace WHERE id=${owned.workspaceID}`,
      ).toHaveLength(1);
    } finally {
      await controller?.stop(owned.attemptID);
      const currentController = controller;
      if (currentController)
        await eventually(
          () => currentController.get(owned.attemptID),
          (current) => current?.state === "stopped",
          "Owned terminal-worker fixture did not settle",
        );
      hub.revoke(owned.attemptID);
      await database.client.end({ timeout: 2 });
      await host.dispose();
    }
  },
  30_000,
);
