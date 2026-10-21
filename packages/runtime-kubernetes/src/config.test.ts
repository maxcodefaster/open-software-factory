import { expect, test } from "bun:test";
import { kubernetesCommand, kubernetesConnectionEnvironment } from "./config";

test("every platform uses the selected kubeconfig or in-cluster context without a vendor default", () => {
  expect(kubernetesCommand(["get", "nodes"], {})).toEqual(["kubectl", "get", "nodes"]);
  expect(kubernetesCommand(["port-forward"], { FACTORY_KUBERNETES_CONTEXT: "factory" })).toEqual([
    "kubectl",
    "--context",
    "factory",
    "port-forward",
  ]);
  expect(kubernetesCommand(["get"], { FACTORY_KUBERNETES_CONTEXT: "" })).toEqual([
    "kubectl",
    "get",
  ]);
  expect(() => kubernetesCommand([], { FACTORY_KUBERNETES_CONTEXT: " unsafe " })).toThrow();
});

test("connection workers retain in-cluster authentication without inheriting product credentials", () => {
  const environment = kubernetesConnectionEnvironment({
    PATH: "/usr/bin",
    HOME: "/home/factory",
    KUBERNETES_SERVICE_HOST: "10.43.0.1",
    KUBERNETES_SERVICE_PORT: "443",
    FACTORY_AUTH_SECRET: "not-for-connection-workers",
    FACTORY_MODEL_API_KEY: "not-for-connection-workers",
  });
  expect(environment.KUBERNETES_SERVICE_HOST).toBe("10.43.0.1");
  expect(environment.KUBERNETES_SERVICE_PORT).toBe("443");
  expect(environment.KUBECONFIG).toBeUndefined();
  expect(JSON.stringify(environment)).not.toContain("not-for-connection-workers");
});
