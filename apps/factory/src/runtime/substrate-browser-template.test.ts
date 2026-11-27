import { expect, test } from "bun:test";
import { renderSubstrateBrowserTemplate } from "./substrate-browser-template";

const input = () => ({
  atespace: `fa-${"a".repeat(32)}`,
  image: `registry.test/browser@sha256:${"b".repeat(64)}`,
  workerSelector: { "factory.dev/deployment": "owned" },
  runtimeAttemptId: crypto.randomUUID(),
  generation: 1,
  sessionId: crypto.randomUUID(),
  turnId: crypto.randomUUID(),
  agentSessionId: "ses_owned",
  ownerId: "c".repeat(64),
  token: "d".repeat(64),
  apps: [{ name: "app", kind: "app" as const, target: "http://127.0.0.1:3000" }],
});

test("native Browser template has its own Actor, immutable image and no Project/credential mounts", () => {
  const admitted = input();
  const before = structuredClone(admitted);
  const template = renderSubstrateBrowserTemplate(admitted);
  expect(template.metadata).toEqual({
    atespace: admitted.atespace,
    name: `browser-${admitted.sessionId.replaceAll("-", "")}`,
  });
  expect(admitted).toEqual(before);
  expect(template.containers).toHaveLength(1);
  expect(template.containers[0]?.command).toEqual(["/usr/local/bin/factory-native-browser"]);
  expect(template.containers[0]?.image).toBe(admitted.image);
  expect(template.volumes).toHaveLength(1);
  expect(template.volumes[0]?.name).toBe("identity");
  expect(JSON.stringify(template)).not.toMatch(
    /docker|devcontainer|workspace|"source"|podCertificate|credentialFile|modelToken|router-ca/,
  );
  expect(template.containers[0]?.securityContext.capabilities).toEqual({
    drop: ["ALL"],
    add: ["SETUID", "SETGID", "CHOWN", "KILL", "NET_BIND_SERVICE"],
  });
  expect(template.resources.limits.memoryBytes).toBe(String(1536 * 1024 ** 2));
  expect(template.snapshotConfig.goldenSnapshotConfig.mode).toBe("GOLDEN_SNAPSHOT_MODE_DISABLED");
  expect(template.containers[0]?.wakeupProbe.httpGet.port).toBe(80);
});

test.each([
  "https://127.0.0.1:3000",
  "http://foreign.test:3000",
  "http://127.0.0.1:3000/private",
  "http://user:pass@127.0.0.1:3000",
  "http://127.0.0.1:3000?authority=extra",
  "http://127.0.0.1:3000#extra",
])("native Browser refuses an unadmitted App destination: %s", (target) => {
  expect(() =>
    renderSubstrateBrowserTemplate({ ...input(), apps: [{ name: "app", kind: "app", target }] }),
  ).toThrow("unique declared local Apps");
});

test("native Browser refuses mutable images and duplicate App identities without mutating input", () => {
  expect(() =>
    renderSubstrateBrowserTemplate({ ...input(), image: "registry.test/browser:latest" }),
  ).toThrow();
  const admitted = input();
  expect(() =>
    renderSubstrateBrowserTemplate({ ...admitted, apps: [...admitted.apps, ...admitted.apps] }),
  ).toThrow("unique declared local Apps");
});
