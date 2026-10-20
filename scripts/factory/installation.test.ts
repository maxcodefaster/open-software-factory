import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  createInstallation,
  loadInstallation,
  installationDirectory,
  installationName,
  parseInstallation,
  composeEnvironment,
} from "./installation";
import {
  requireModelConfiguration,
  requirePinnedImage,
  requireComposePins,
  inspectCurrentContainers,
} from "./preflight";

test("ownership inspection reconciles vanished containers, but never ignores inspection failure", async () => {
  let calls = 0;
  const inspected: string[][] = [];
  expect(
    await inspectCurrentContainers(
      async () => (calls++ ? ["owned"] : ["owned", "gone"]),
      async (ids) => {
        inspected.push(ids);
        if (ids.includes("gone")) throw new Error("Container vanished");
        return ids;
      },
    ),
  ).toEqual(["owned"]);
  expect(inspected).toEqual([["owned", "gone"], ["owned"]]);
  await expect(
    inspectCurrentContainers(
      async () => ["owned"],
      async () => {
        throw new Error("Inspection unavailable");
      },
    ),
  ).rejects.toThrow("Inspection unavailable");
  calls = 0;
  await expect(
    inspectCurrentContainers(
      async () => (calls++ ? ["owned"] : ["owned", "gone"]),
      async () => {
        throw new Error("Still unavailable");
      },
    ),
  ).rejects.toThrow("Still unavailable");
});

test("ownership inspection handles successive removals without chasing unrelated new containers", async () => {
  const lists = [
    ["owned", "gone-a", "gone-b"],
    ["owned", "gone-b", "new-a"],
    ["owned", "new-b"],
  ];
  let read = 0;
  const inspected: string[][] = [];
  expect(
    await inspectCurrentContainers(
      async () => lists[read++] ?? ["owned", "new-c"],
      async (ids) => {
        inspected.push(ids);
        if (ids.some((id) => id.startsWith("gone-"))) throw new Error("Container vanished");
        return ids;
      },
    ),
  ).toEqual(["owned"]);
  expect(inspected).toEqual([["owned", "gone-a", "gone-b"], ["owned", "gone-b"], ["owned"]]);
  expect(read).toBe(3);
});

const pins = {
  runtimeImage: `registry.invalid/host@sha256:${"a".repeat(64)}`,
  browserImage: `registry.invalid/browser@sha256:${"b".repeat(64)}`,
};

test("persists unique disposable ports/owner before creates, and reuses identity", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "factory-installation-test-"));
  try {
    const created = await createInstallation(root, "release-proof", pins);
    expect(created.disposable).toBe(true);
    expect(new Set(Object.values(created.ports)).size).toBe(4);
    expect(await loadInstallation(root, "release-proof")).toEqual(created);
    expect(await createInstallation(root, "release-proof", pins)).toEqual(created);
    expect(
      (await stat(resolve(installationDirectory(root, "release-proof"), "installation.json")))
        .mode & 0o777,
    ).toBe(0o600);
    expect(composeEnvironment(created)["FACTORY_INSTALLATION_OWNER"]).toBe(created.owner);
    expect(() =>
      parseInstallation(
        { ...created, ports: { ...created.ports, zero: created.ports.factory } },
        created.name,
      ),
    ).toThrow("identity");
    expect(() => parseInstallation({ ...created, disposable: false }, created.name)).toThrow(
      "identity",
    );
    expect(() => parseInstallation(created, "different-name")).toThrow("identity");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses traversal, reserved identities and redirected state", async () => {
  for (const name of ["../local", "local", "default", "a/b", "Release", "-bad", "ab"])
    expect(() => installationName(name)).toThrow("name");
  const root = await mkdtemp(resolve(tmpdir(), "factory-installation-test-"));
  const other = await mkdtemp(resolve(tmpdir(), "factory-installation-target-"));
  try {
    await symlink(other, resolve(root, ".factory"));
    await expect(createInstallation(root, "release-proof", pins)).rejects.toThrow(
      "redirected state",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

test("pin and configuration failures never disclose credentials", () => {
  const environment = {
    FACTORY_MODEL_BASE_URL: "https://provider.invalid/v1",
    FACTORY_MODEL_API_KEY: "secret-sentinel",
    FACTORY_AGENT_MODEL_ID: "approved",
    FACTORY_PROJECT_AGENT_MODEL: "approved",
    FACTORY_KNOWLEDGE_MODEL: "approved",
  };
  expect(() => requireModelConfiguration(environment)).not.toThrow();
  for (const key of Object.keys(environment))
    expect(() => requireModelConfiguration({ ...environment, [key]: "" })).toThrow(key);
  for (const base of [
    "https://secret-sentinel@provider.invalid/v1",
    "https://provider.invalid/v1?key=secret-sentinel",
    "http://provider.invalid/v1",
    "bad-secret-sentinel",
  ]) {
    let rejected = false;
    try {
      requireModelConfiguration({ ...environment, FACTORY_MODEL_BASE_URL: base });
    } catch (cause) {
      rejected = true;
      expect(String(cause)).not.toContain("secret-sentinel");
    }
    expect(rejected).toBe(true);
  }
  expect(() => requirePinnedImage(pins.runtimeImage)).not.toThrow();
  expect(() => requirePinnedImage("image:latest")).toThrow("digest");
  expect(() =>
    requireComposePins({
      services: {
        postgres: { image: pins.runtimeImage },
        forgejo: { image: pins.runtimeImage },
        "zero-cache": { image: "image:latest" },
      },
    }),
  ).toThrow("digest");
});
