import { z } from "zod";
import upstream from "../../upstream.json";
import { startupMeasurements } from "../support/runtime-startup";
import { editorFixtureKubectl } from "./editor-source-resources";

const imageSnapshot = z.object({ id: z.string(), digests: z.array(z.string()) });

// Node presence does not establish acquisition in either Docker daemon inside Envbox.
export async function runtimeCacheObservation(input: {
  namespace: string;
  podName: string;
  podUID: string;
  attemptID: string;
  node: string;
  runtimeHostImage: string;
  startedAt: string;
  projectImages?: readonly string[];
}) {
  const pod = z
    .object({
      metadata: z.object({
        uid: z.string(),
        creationTimestamp: z.string(),
        labels: z.record(z.string(), z.string()),
      }),
      spec: z.object({ nodeName: z.string() }),
      status: z.object({
        startTime: z.string(),
        conditions: z.array(
          z.object({ type: z.string(), status: z.string(), lastTransitionTime: z.string() }),
        ),
        containerStatuses: z.array(
          z.object({
            name: z.string(),
            imageID: z.string(),
            state: z.object({ running: z.object({ startedAt: z.string() }).optional() }),
          }),
        ),
      }),
    })
    .parse(
      JSON.parse(
        await editorFixtureKubectl([
          "get",
          "pod",
          input.podName,
          "-n",
          input.namespace,
          "-o",
          "json",
        ]),
      ),
    );
  if (
    pod.metadata.uid !== input.podUID ||
    pod.metadata.labels["factory.dev/runtime-attempt"] !== input.attemptID ||
    pod.spec.nodeName !== input.node
  )
    throw new Error("Cache observation does not own the exact Runtime Attempt Pod");
  const node = z
    .object({
      status: z.object({
        images: z.array(z.object({ names: z.array(z.string()).nullish() })),
      }),
    })
    .parse(JSON.parse(await editorFixtureKubectl(["get", "node", input.node, "-o", "json"])));
  const outer = (args: string[]) =>
    editorFixtureKubectl(["exec", "-n", input.namespace, input.podName, "--", "docker", ...args]);
  const inner = (args: string[]) => outer(["exec", "workspace_cvm", ...args]);
  const inspect = (image: string) => [
    "image",
    "inspect",
    "--format",
    '{"id":{{json .Id}},"digests":{{json .RepoDigests}}}',
    image,
  ];
  const host = imageSnapshot.parse(JSON.parse(await outer(inspect(input.runtimeHostImage))));
  const project = await Promise.all(
    (input.projectImages ?? [upstream.nodeDevelopment.image, upstream.node.image]).map(
      async (reference) => ({
        reference,
        ...imageSnapshot.parse(JSON.parse(await inner(["docker", ...inspect(reference)]))),
      }),
    ),
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
      envboxStartedAt: pod.status.containerStatuses.find((container) => container.name === "envbox")
        ?.state.running?.startedAt,
      connectorStartedAt: phases[0]?.startedAt,
    },
    kubelet: {
      node: input.node,
      envbox: upstream.envbox.image,
      imageID: pod.status.containerStatuses.find((container) => container.name === "envbox")
        ?.imageID,
      present: node.status.images.some((image) => image.names?.includes(upstream.envbox.image)),
    },
    envboxDocker: { reference: input.runtimeHostImage, ...host },
    privateDocker: { project, pullsSinceAdmission: pulls },
    phases,
  };
}
