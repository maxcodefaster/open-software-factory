import { expect, test } from "bun:test";
import { kubernetesCommand } from "./config";

test("Mac keeps its maintained default; Linux uses the supplied kubeconfig context", () => {
  expect(kubernetesCommand(["get", "nodes"], {}, "darwin")).toEqual([
    "kubectl",
    "--context",
    "orbstack",
    "get",
    "nodes",
  ]);
  expect(kubernetesCommand(["get", "nodes"], {}, "linux")).toEqual(["kubectl", "get", "nodes"]);
  expect(
    kubernetesCommand(["port-forward"], { FACTORY_KUBERNETES_CONTEXT: "factory" }, "linux"),
  ).toEqual(["kubectl", "--context", "factory", "port-forward"]);
  expect(kubernetesCommand(["get"], { FACTORY_KUBERNETES_CONTEXT: "" }, "darwin")).toEqual([
    "kubectl",
    "get",
  ]);
  expect(() => kubernetesCommand([], { FACTORY_KUBERNETES_CONTEXT: " unsafe " })).toThrow();
});
