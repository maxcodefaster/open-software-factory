import { expect, test } from "bun:test";
import { resetDisposable, requireRuntimeNamespacesAbsent } from "./reset";
import { parseInstallation, requireOwnedResource, composeProject } from "./installation";

test("existing or unobservable runtime namespaces prevent reset", async () => {
  await expect(
    requireRuntimeNamespacesAbsent(["factory-workspace-123456abcdef"], async () => true),
  ).rejects.toThrow("Reset refused");
  await expect(
    requireRuntimeNamespacesAbsent(["factory-workspace-123456abcdef"], async () => {
      throw new Error("namespace observation failed");
    }),
  ).rejects.toThrow("observation failed");
  await requireRuntimeNamespacesAbsent(["factory-workspace-123456abcdef"], async () => false);
});

const installation = parseInstallation(
  {
    version: 1,
    disposable: true,
    name: "release-proof",
    owner: crypto.randomUUID(),
    phase: "active",
    ports: { factory: 51000, postgres: 51001, forgejo: 51002, zero: 51003 },
    runtimeImage: `registry.invalid/host@sha256:${"a".repeat(64)}`,
    browserImage: `registry.invalid/browser@sha256:${"b".repeat(64)}`,
  },
  "release-proof",
);

test("unknown ownership rejects before intent, stop or deletion", async () => {
  const events: string[] = [];
  await expect(
    resetDisposable({
      installation,
      confirmation: installation.name,
      data: true,
      validate: async () => {
        events.push("validate");
        requireOwnedResource(installation, {
          labels: { "com.docker.compose.project": composeProject(installation) },
          projectLabel: "com.docker.compose.project",
        });
      },
      persistIntent: async () => {
        events.push("intent");
      },
      stop: async () => {
        events.push("stop");
      },
      remove: async () => {
        events.push("remove");
      },
      persistOutcome: async () => {
        events.push("outcome");
      },
    }),
  ).rejects.toThrow("unknown disposable ownership");
  expect(events).toEqual(["validate"]);
});

test("developer installation and wrong confirmation never reach external validation", async () => {
  for (const [value, confirmation] of [
    [null, installation.name],
    [installation, "other"],
  ] as const) {
    const events: string[] = [];
    const step = async () => {
      events.push("external");
    };
    await expect(
      resetDisposable({
        installation: value,
        confirmation,
        data: true,
        validate: step,
        persistIntent: step,
        stop: step,
        remove: step,
        persistOutcome: step,
      }),
    ).rejects.toThrow("Reset requires");
    expect(events).toEqual([]);
  }
});

test("approved reset records intent before stop, and outcome only after confirmed removal", async () => {
  const events: string[] = [];
  const input = {
    installation,
    confirmation: installation.name,
    data: true,
    validate: async () => {
      events.push("validate");
    },
    persistIntent: async () => {
      events.push("intent");
    },
    stop: async () => {
      events.push("stop");
    },
    remove: async () => {
      events.push("remove");
      throw new Error("removal uncertain");
    },
    persistOutcome: async () => {
      events.push("outcome");
    },
  };
  await expect(resetDisposable(input)).rejects.toThrow("removal uncertain");
  expect(events).toEqual(["validate", "intent", "stop", "remove"]);
  await resetDisposable({
    ...input,
    remove: async () => {
      events.push("removed");
    },
  });
  expect(events.slice(-5)).toEqual(["validate", "intent", "stop", "removed", "outcome"]);
});

test("checks exact owner, disposable flag and Compose project independently", () => {
  const labels = {
    "factory.dev/installation": installation.owner,
    "factory.dev/disposable": "true",
    "com.docker.compose.project": composeProject(installation),
  };
  expect(() =>
    requireOwnedResource(installation, { labels, projectLabel: "com.docker.compose.project" }),
  ).not.toThrow();
  for (const key of Object.keys(labels))
    expect(() =>
      requireOwnedResource(installation, {
        labels: { ...labels, [key]: "foreign" },
        projectLabel: "com.docker.compose.project",
      }),
    ).toThrow("unknown disposable ownership");
});
