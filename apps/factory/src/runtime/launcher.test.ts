import { describe, expect, test } from "bun:test";
import { launchRuntimeResources } from "./launcher";
import { ownedFactoryboxProfile } from "../../../../test/fixtures/runtime-configuration";

const runtimeHostImage = `registry.invalid/host@sha256:${"a".repeat(64)}`;
const observedPod = {
  uid: "pod-uid",
  phase: "Pending",
  labels: {},
  factoryboxImage: ownedFactoryboxProfile.image,
  runtimeHostImage,
};

describe("launchRuntimeResources", () => {
  test.each([true, false])(
    "new consumer selection checks the original worker bootstrap, matching=%s",
    async (matches) => {
      let recorded = false;
      const launch = launchRuntimeResources(
        {
          resources: [],
          namespace: "namespace",
          podName: "pod",
          missingPodMessage: "missing",
          runtimeHostImage: `registry.invalid/new-consumer@sha256:${"b".repeat(64)}`,
          factoryboxProfile: ownedFactoryboxProfile,
        },
        {
          kubernetes: {
            apply: async () => ({
              namespaceUID: "namespace-uid",
              workerRuntimeHostImage: runtimeHostImage,
            }),
            getPod: async () => ({
              ...observedPod,
              runtimeHostImage: matches
                ? runtimeHostImage
                : `registry.invalid/wrong@sha256:${"c".repeat(64)}`,
            }),
          },
          transitionObserved: async () => {
            recorded = true;
            return true;
          },
          observe: async () => {},
          fail: async () => {},
        },
      );
      if (matches) await launch;
      else await expect(launch).rejects.toThrow("immutable create intent");
      expect(recorded).toBe(matches);
    },
  );
  test("does not start an observer when Stop supersedes the observed create", async () => {
    let observed = false;
    await launchRuntimeResources(
      {
        resources: [],
        namespace: "namespace",
        podName: "pod",
        missingPodMessage: "missing",
        runtimeHostImage,
        factoryboxProfile: ownedFactoryboxProfile,
      },
      {
        kubernetes: {
          apply: async () => ({ namespaceUID: "namespace-uid" }),
          getPod: async () => observedPod,
        },
        transitionObserved: async () => false,
        observe: async () => {
          observed = true;
        },
        fail: async () => {
          throw new Error("Unexpected create failure");
        },
      },
    );
    expect(observed).toBe(false);
  });
  test("persists observed identities before starting the observer", async () => {
    const events: string[] = [];
    await launchRuntimeResources(
      {
        resources: [],
        namespace: "namespace",
        podName: "pod",
        missingPodMessage: "missing",
        runtimeHostImage,
        factoryboxProfile: ownedFactoryboxProfile,
      },
      {
        kubernetes: {
          apply: async () => {
            events.push("apply");
            return { namespaceUID: "namespace-uid" };
          },
          getPod: async () => observedPod,
        },
        transitionObserved: async (podUID, namespaceUID) => {
          events.push(`persist:${podUID}:${namespaceUID}`);
          return true;
        },
        observe: async () => {
          events.push("observe");
        },
        fail: async () => {
          events.push("fail");
        },
      },
    );

    await Promise.resolve();
    expect(events).toEqual(["apply", "persist:pod-uid:namespace-uid", "observe"]);
  });

  test("records create failure and rethrows when the Pod is not observed", async () => {
    const failures: string[] = [];
    const launch = launchRuntimeResources(
      {
        resources: [],
        namespace: "namespace",
        podName: "pod",
        missingPodMessage: "Pod missing",
        runtimeHostImage,
        factoryboxProfile: ownedFactoryboxProfile,
      },
      {
        kubernetes: {
          apply: async () => ({ namespaceUID: "namespace-uid" }),
          getPod: async () => null,
        },
        transitionObserved: async () => true,
        observe: async () => undefined,
        fail: async (phase, cause) => {
          failures.push(`${phase}:${cause instanceof Error ? cause.message : "unknown"}`);
        },
      },
    );

    await expect(launch).rejects.toThrow("Pod missing");
    expect(failures).toEqual(["create:Pod missing"]);
  });

  test.each(["runtimeHostImage", "factoryboxImage"] as const)(
    "rejects a mismatched %s before recording create success",
    async (field) => {
      let recorded = false;
      let observed = false;
      const failures: string[] = [];
      await expect(
        launchRuntimeResources(
          {
            resources: [],
            namespace: "namespace",
            podName: "pod",
            missingPodMessage: "missing",
            runtimeHostImage,
            factoryboxProfile: ownedFactoryboxProfile,
          },
          {
            kubernetes: {
              apply: async () => ({ namespaceUID: "namespace-uid" }),
              getPod: async () => ({
                ...observedPod,
                [field]: `registry.invalid/wrong@sha256:${"b".repeat(64)}`,
              }),
            },
            transitionObserved: async () => {
              recorded = true;
              return true;
            },
            observe: async () => {
              observed = true;
            },
            fail: async (phase) => {
              failures.push(phase);
            },
          },
        ),
      ).rejects.toThrow("artifacts differ");
      expect(recorded).toBe(false);
      expect(observed).toBe(false);
      expect(failures).toEqual(["create"]);
    },
  );
});
