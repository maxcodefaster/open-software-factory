import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { needsNativeController } from "./native-lock";

const controller = (action: string) => [
  "exec",
  "worker-pod",
  "-n",
  "factory",
  "-c",
  "worker",
  "--",
  "/opt/factorybox/factorybox",
  "--worker-run-root",
  "/run/factorybox",
  "--worker-store-id",
  "store",
  "--worker-epoch",
  "epoch",
  action,
];
const python = ["exec", "-i", "worker-pod", "-n", "factory", "-c", "worker", "--", "python3", "-c"];

test("only native controller commands need the cross-process lock", () => {
  const consumer = readFileSync(
    new URL("../../../../packages/runtime-kubernetes/src/factorybox/consumer.py", import.meta.url),
    "utf8",
  );
  expect(needsNativeController(["get", "pod", "worker"])).toBe(false);
  expect(needsNativeController(["create", "-f", "-"])).toBe(false);
  expect(
    needsNativeController([
      "exec",
      "p",
      "-c",
      "worker",
      "--",
      "/opt/factorybox/factorybox",
      "worker-status",
    ]),
  ).toBe(false);
  expect(needsNativeController([...python, consumer])).toBe(false);
  expect(needsNativeController([...python, "print('prepare')"])).toBe(true);
  for (const action of ["start", "pause", "resume", "delete", "fork", "state", "capacity"])
    expect(needsNativeController(controller(action))).toBe(true);
});
