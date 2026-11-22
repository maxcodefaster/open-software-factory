import { expect, test } from "bun:test";

test.each([
  {
    file: "egress-resources-patch.yaml",
    kind: "Deployment",
    name: "atenet-egress",
    containers: "initContainers",
    container: "sdsmint",
    requests: { cpu: "100m", memory: "128Mi" },
  },
  {
    file: "postgres-resources-patch.yaml",
    kind: "StatefulSet",
    name: "postgres",
    containers: "containers",
    container: "postgres",
    requests: { cpu: "100m" },
  },
])("shared-node $file changes only the named scheduling request", async (input) => {
  const patch = Bun.YAML.parse(await Bun.file(`deploy/substrate/${input.file}`).text());
  expect(patch).toEqual({
    apiVersion: "apps/v1",
    kind: input.kind,
    metadata: { name: input.name, namespace: "ate-system" },
    spec: {
      template: {
        spec: {
          [input.containers]: [
            {
              name: input.container,
              resources: { requests: input.requests },
            },
          ],
        },
      },
    },
  });
});

test("shared-node tracing cannot consume unbounded memory reserved for Factory and Actors", async () => {
  const patch = Bun.YAML.parse(
    await Bun.file("deploy/substrate/tracing-resources-patch.yaml").text(),
  );
  expect(patch).toEqual({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "jaeger", namespace: "otel-system" },
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: "jaeger",
              env: [{ name: "GOMEMLIMIT", value: "384MiB" }],
              resources: {
                requests: { cpu: "50m", memory: "128Mi" },
                limits: { cpu: "500m", memory: "512Mi" },
              },
            },
          ],
        },
      },
    },
  });
});
