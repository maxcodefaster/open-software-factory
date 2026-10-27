import { z } from "zod";
import upstream from "../../upstream.json";
import { startupMeasurements } from "../support/runtime-startup";
import { editorFixtureKubectl } from "./editor-source-resources";
import {
  type FactoryboxFixtureTarget,
  factoryboxFixtureCommand,
  requireFixtureWorkerPod,
} from "./factorybox-runtime";

const imageSnapshot = z.object({ id: z.string(), digests: z.array(z.string()) });

export async function readProjectImageSnapshots(
  references: readonly string[],
  inspect: (reference: string) => Promise<z.infer<typeof imageSnapshot>>,
) {
  const project: Array<{ reference: string } & z.infer<typeof imageSnapshot>> = [];
  // Every read enters one shared worker's native lifecycle lock.
  for (const reference of references) project.push({ reference, ...(await inspect(reference)) });
  return project;
}

// The worker base import and each Sandbox's private Docker cache are different tiers.
export async function runtimeCacheObservation(input: {
  target: FactoryboxFixtureTarget;
  startedAt: string;
  projectImages?: readonly string[];
}) {
  const target = input.target;
  const { namespace, podName, profile, runtimeHostImage } = target.input;
  const pod = requireFixtureWorkerPod(
    JSON.parse(await editorFixtureKubectl(["get", "pod", podName, "-n", namespace, "-o", "json"])),
    target,
  );
  const node = z
    .object({
      status: z.object({
        images: z.array(z.object({ names: z.array(z.string()).nullish() })),
      }),
    })
    .parse(JSON.parse(await editorFixtureKubectl(["get", "node", profile.nodeName, "-o", "json"])));
  const inner = (args: string[]) => factoryboxFixtureCommand(target, args);
  const inspect = (image: string) => [
    "image",
    "inspect",
    "--format",
    '{"id":{{json .Id}},"digests":{{json .RepoDigests}}}',
    image,
  ];
  // The consumer filesystem comes from the exact init-container image, not
  // an ambient host Docker daemon. Preparation binds that image to this epoch.
  const host = {
    reference: runtimeHostImage,
    workerEpoch: target.identity.epoch,
    executableSHA256: target.identity.executableSHA256,
  };
  const project = await readProjectImageSnapshots(
    input.projectImages ?? [upstream.nodeDevelopment.image, upstream.node.image],
    async (reference) =>
      imageSnapshot.parse(JSON.parse(await inner(["docker", ...inspect(reference)]))),
  );
  const phases = startupMeasurements(await inner(["cat", "/tmp/factory-startup-timings.jsonl"]));
  const pulls = (
    await inner([
      "docker",
      "events",
      "--since",
      input.startedAt,
      "--until",
      new Date().toISOString(),
      "--filter",
      "type=image",
      "--filter",
      "event=pull",
      "--format",
      "{{.Actor.ID}}",
    ])
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  return {
    infrastructure: {
      admittedAt: input.startedAt,
      podCreatedAt: pod.metadata.creationTimestamp,
      podStartedAt: pod.status.startTime,
      conditions: pod.status.conditions,
      workerStartedAt: pod.status.containerStatuses.find((container) => container.name === "worker")
        ?.state.running?.startedAt,
      connectorStartedAt: phases[0]?.startedAt,
    },
    kubelet: {
      node: profile.nodeName,
      worker: profile.image,
      imageID: pod.status.containerStatuses.find((container) => container.name === "worker")
        ?.imageID,
      present: node.status.images.some((image) =>
        image.names?.some((name) =>
          name.endsWith(profile.image.slice(profile.image.indexOf("@") + 1)),
        ),
      ),
    },
    factoryboxBase: host,
    privateDocker: { project, pullsSinceAdmission: pulls },
    phases,
  };
}
