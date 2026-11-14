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
