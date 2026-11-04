import { expect, test } from "bun:test";
import { createInspectionReuse } from "./inspection-reuse";

const ok = { stdout: "{}", stderr: "", exitCode: 0 };
const worker = ["exec", "worker", "-n", "ns", "-c", "worker", "--", "/opt/factorybox/factorybox"];
const identity = [
  ["get", "namespace", "ns", "-o", "json"],
  ["get", "pvc", "claim", "-n", "ns", "-o", "json"],
  ["get", "pod", "worker", "-n", "ns", "-o", "json"],
  ["get", "node", "node-1", "-o", "json"],
  [...worker, "worker-status"],
];
const native = (action: string) => [
  ...worker,
  "--worker-run-root",
  "/run/factorybox",
  "--worker-store-id",
  "store",
  "--worker-epoch",
  "epoch",
  action,
  "sandbox",
];

function harness() {
  let now = 0;
  const reuse = createInspectionReuse(2_000, () => now);
  const sent: string[][] = [];
  let failNext = false;
  const call = (args: string[], input?: string) =>
    reuse.run(args, input, async () => {
      sent.push(args);
      if (failNext) {
        failNext = false;
        return { stdout: "", stderr: "unavailable", exitCode: 1 };
      }
      return ok;
    });
  return {
    reuse,
    sent,
    call,
    advance: (ms: number) => {
      now += ms;
    },
    failNext: () => {
      failNext = true;
    },
  };
}

test("repeats no identity read while one locked operation inspects the worker again", async () => {
  const h = harness();
  await h.reuse.scope(async () => {
    await Promise.all(identity.map((args) => h.call(args)));
    await h.call(native("capacity"));
    await Promise.all(identity.map((args) => h.call(args)));
    await h.call(native("state"));
    await Promise.all(identity.map((args) => h.call(args)));
  });
  expect(h.sent.filter((args) => identity.some((read) => read === args))).toHaveLength(5);
  expect(h.sent).toHaveLength(7);
});

test("never reuses an inspection outside a locked scope or beyond its short life", async () => {
  const h = harness();
  await h.call(identity[2] ?? []);
  await h.call(identity[2] ?? []);
  expect(h.sent).toHaveLength(2);
  await h.reuse.scope(async () => {
    await h.call(identity[2] ?? []);
    h.advance(1_999);
    await h.call(identity[2] ?? []);
    h.advance(1);
    await h.call(identity[2] ?? []);
  });
  expect(h.sent).toHaveLength(4);
  await h.reuse.scope(async () => {
    await h.call(identity[2] ?? []);
  });
  expect(h.sent).toHaveLength(5);
});

test("a mutating or unknown command ends reuse", async () => {
  for (const command of [
    native("start"),
    native("pause"),
    ["create", "-f", "-"],
    ["delete", "--raw", "/api/v1/namespaces/ns/pods/exporter", "-f", "-"],
    [...worker, "python3", "-c", "program"],
  ]) {
    const h = harness();
    await h.reuse.scope(async () => {
      await h.call(identity[2] ?? []);
      await h.call(command);
      await h.call(identity[2] ?? []);
    });
    expect(h.sent.filter((args) => args[0] === "get" && args[1] === "pod")).toHaveLength(2);
  }
});

test("another Kubernetes read does not end reuse", async () => {
  const h = harness();
  await h.reuse.scope(async () => {
    await h.call(identity[2] ?? []);
    await h.call(["get", "secret", "assignment", "-n", "ns", "-o", "json"]);
    await h.call(identity[2] ?? []);
  });
  expect(h.sent.filter((args) => args[1] === "pod")).toHaveLength(1);
});

test("a failed read or command is never reused and clears earlier reads", async () => {
  const h = harness();
  await h.reuse.scope(async () => {
    h.failNext();
    expect((await h.call(identity[2] ?? [])).exitCode).toBe(1);
    expect((await h.call(identity[2] ?? [])).exitCode).toBe(0);
    await h.call(identity[2] ?? []);
    h.failNext();
    expect((await h.call(native("state"))).exitCode).toBe(1);
    await h.call(identity[2] ?? []);
  });
  expect(h.sent.filter((args) => args[1] === "pod")).toHaveLength(3);
});

test("a read with input is a command, not an inspection", async () => {
  const h = harness();
  await h.reuse.scope(async () => {
    await h.call(identity[2] ?? [], "{}");
    await h.call(identity[2] ?? [], "{}");
  });
  expect(h.sent).toHaveLength(2);
});
