import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { RuntimeHub, type RuntimeSocketData } from "./hub";

function socket(role: "parent" | "child") {
  let closes = 0;
  return {
    connection: {
      data: { kind: "connector", role, attemptID: "owned-attempt", generation: 1 },
      send() {
        return 1;
      },
      close() {
        closes++;
      },
    } as unknown as ServerWebSocket<RuntimeSocketData>,
    closes: () => closes,
  };
}

test.each(["throw", "reject"])(
  "a %s from a status observer cannot terminate the Factory process",
  async (failure) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
const { RuntimeHub } = await import(${JSON.stringify(new URL("./hub.ts", import.meta.url).href)});
let closed = 0;
const hub = new RuntimeHub(${failure === "throw" ? "" : "async "}() => {
  throw new Error("private-driver-payload");
});
const socket = role => ({
  data: {kind: "connector", role, attemptID: "owned-attempt", generation: 1},
  send() { return 1; },
  close() { closed++; },
});
hub.allow("owned-attempt", 1, "parent-hash", "child-hash");
const parent = socket("parent"), source = socket("child");
hub.open(parent);
hub.open(source);
hub.message(source, JSON.stringify({type: "hello", role: "child"}));
await Bun.sleep(30);
console.log(JSON.stringify({alive: true, healthyComputeInterrupted: closed !== 0}));
hub.revoke("owned-attempt");
`,
      ],
      { env: process.env, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({ alive: true, healthyComputeInterrupted: false });
    expect(stderr).not.toContain("private-driver-payload");
  },
);

test("a failed terminal observation survives producer close and confirms the same attempt", async () => {
  const phases: string[] = [];
  const confirmed = Promise.withResolvers<void>();
  const hub = new RuntimeHub(async (_id, phase) => {
    phases.push(phase);
    if (phases.length === 1) throw new Error("Owned unavailable observation");
    confirmed.resolve();
  });
  const parent = socket("parent");
  hub.allow("owned-attempt", 1, "parent-hash", "child-hash");
  hub.open(parent.connection);
  try {
    hub.message(parent.connection, JSON.stringify({ type: "status", phase: "stopped" }));
    hub.close(parent.connection);
    await confirmed.promise;
    expect(phases).toEqual(["stopped", "stopped"]);
  } finally {
    hub.revoke("owned-attempt");
  }
});

test("a failed readiness observation retries without disconnecting healthy compute", async () => {
  let calls = 0;
  const confirmed = Promise.withResolvers<void>();
  const hub = new RuntimeHub(async (_id, phase) => {
    expect(phase).toBe("ready");
    if (++calls === 1) throw new Error("Owned unavailable observation");
    confirmed.resolve();
  });
  const parent = socket("parent");
  const child = socket("child");
  hub.allow("owned-attempt", 1, "parent-hash", "child-hash");
  hub.open(parent.connection);
  hub.open(child.connection);
  try {
    hub.message(child.connection, JSON.stringify({ type: "hello", role: "child" }));
    await confirmed.promise;
    expect(calls).toBe(2);
    expect(hub.connected("owned-attempt")).toBe(true);
    expect(parent.closes() + child.closes()).toBe(0);
  } finally {
    hub.revoke("owned-attempt");
  }
});

test("revocation cancels an unconfirmed terminal observation rather than applying it to later work", async () => {
  let calls = 0;
  const hub = new RuntimeHub(async () => {
    calls++;
    throw new Error("Owned unavailable observation");
  });
  const parent = socket("parent");
  hub.allow("owned-attempt", 1, "parent-hash", "child-hash");
  hub.open(parent.connection);
  hub.message(parent.connection, JSON.stringify({ type: "status", phase: "stopped" }));
  await Bun.sleep(0);
  hub.revoke("owned-attempt");
  await Bun.sleep(1_100);
  expect(calls).toBe(1);
});

test("an old callback failure cannot close the replacement connector", async () => {
  let ready = 0;
  const original = Promise.withResolvers<void>();
  const hub = new RuntimeHub(async (_id, phase) => {
    if (phase === "ready" && ready++ === 0) await original.promise;
  });
  const parent = socket("parent");
  const child = socket("child");
  const replacement = socket("child");
  hub.allow("owned-attempt", 1, "parent-hash", "child-hash");
  hub.open(parent.connection);
  hub.open(child.connection);
  try {
    hub.message(child.connection, JSON.stringify({ type: "hello", role: "child" }));
    hub.close(child.connection);
    hub.open(replacement.connection);
    hub.message(replacement.connection, JSON.stringify({ type: "hello", role: "child" }));
    original.reject(new Error("Old observation failed after reconnect"));
    await Bun.sleep(1_100);
    expect(ready).toBe(2);
    expect(replacement.closes()).toBe(0);
    expect(hub.connected("owned-attempt")).toBe(true);
  } finally {
    original.resolve();
    hub.revoke("owned-attempt");
  }
});
