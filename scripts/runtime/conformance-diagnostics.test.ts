import { expect, test } from "bun:test";
import { preparationFailureDiagnostics } from "./conformance-diagnostics";

const owner = "owned-run";
const pod = {
  metadata: {
    name: "worker",
    namespace: "owned-namespace",
    uid: "original-uid",
    labels: { "factory.dev/conformance-owner": owner },
  },
  status: { phase: "Pending", reason: "ImagePullBackOff" },
};

test("preparation diagnostics retain bounded logs and original Pod state", async () => {
  const calls: (readonly string[])[] = [];
  const report = await preparationFailureDiagnostics(
    owner,
    "owned-namespace",
    "worker",
    pod,
    async (args, limits) => {
      calls.push(args);
      expect(limits.timeoutMS).toBe(2000);
      return {
        exitCode: 0,
        stdout: args[0] === "get" ? JSON.stringify(pod) : "native cause",
        stderr: "",
      };
    },
  );
  expect(report.pod).toEqual(pod);
  expect(report.logs).toEqual({ exitCode: 0, stdout: "native cause", stderr: "" });
  expect(calls[0]).toContain("--tail=100");
});

test("unavailable logs never replace the original failure observation", async () => {
  const report = await preparationFailureDiagnostics(
    owner,
    "owned-namespace",
    "worker",
    pod,
    async () => {
      throw new Error("logs forbidden");
    },
  );
  expect(report.pod).toEqual(pod);
  expect(report.logs).toEqual({ unavailable: true });
});

test("foreign Pods are not queried and replacement logs are discarded", async () => {
  let calls = 0;
  await expect(
    preparationFailureDiagnostics("foreign", "owned-namespace", "worker", pod, async () => {
      calls++;
      throw new Error("must not run");
    }),
  ).rejects.toThrow("unowned Pod");
  expect(calls).toBe(0);
  const report = await preparationFailureDiagnostics(
    owner,
    "owned-namespace",
    "worker",
    pod,
    async (args) => ({
      exitCode: 0,
      stdout:
        args[0] === "get"
          ? JSON.stringify({ ...pod, metadata: { ...pod.metadata, uid: "replacement" } })
          : "untrusted replacement log",
      stderr: "",
    }),
  );
  expect(report.logs).toEqual({ unavailable: true });
});
