import { expect, test } from "bun:test";
import { renderEnvboxPod } from "./envbox-pod";

const input = {
  namespace: "factory-portability",
  podName: "runtime",
  hostname: "workspace",
  labels: {},
  mode: "development" as const,
};

test("registry trust follows the actual immutable image registry, including private ports", () => {
  for (const authority of ["ghcr.io", "registry.portable.svc:5000"]) {
    const pod = renderEnvboxPod({
      ...input,
      runtimeHostImage: `${authority}/factory/runtime@sha256:${"a".repeat(64)}`,
    });
    const container = pod.spec.containers[0]!;
    const bootstrap = container.env.find((entry) => entry.name === "CODER_BOOTSTRAP_SCRIPT");
    const certificate = `/etc/docker/certs.d/${authority}/ca.crt`;
    expect(container.volumeMounts).toContainEqual({
      name: "registry-ca",
      mountPath: certificate,
      subPath: "ca.crt",
      readOnly: true,
    });
    expect(bootstrap?.value).toContain(`cp /factory/registry-ca/ca.crt ${certificate}`);
    expect(JSON.stringify(pod)).not.toContain("open-factory-envbox-smoke");
  }
});

test("registry names cannot inject commands or traverse certificate directories", () => {
  for (const image of [
    "registry;id/factory",
    "registry$(id)/factory",
    "../factory",
    "/factory",
    "unqualified-image",
  ])
    expect(() => renderEnvboxPod({ ...input, runtimeHostImage: image })).toThrow();
});
