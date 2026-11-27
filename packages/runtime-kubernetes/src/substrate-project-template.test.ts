import { describe, expect, test } from "bun:test";
import example from "../../../test/fixtures/native-project/actor-template.json";
import {
  parseSubstrateProjectTemplate,
  substrateProjectSource,
} from "./substrate-project-template";

function project() {
  return structuredClone(example);
}
const parse = (value: unknown) => parseSubstrateProjectTemplate(JSON.stringify(value));

describe("Project native ActorTemplate", () => {
  test("accepts native containers and durable directories without a Compose translation", () => {
    const template = parse(project());
    expect(substrateProjectSource(template)).toBe("/workspaces/monorepo");
    expect(template.containers[1]?.command).toEqual([
      "/usr/local/bin/docker-entrypoint.sh",
      "postgres",
    ]);
    expect(template.volumes).toHaveLength(2);
    expect(template).toStrictEqual(project());
    expect(template).not.toHaveProperty("snapshotConfig");
  });
  test.each(["SNAPSHOT_FIDELITY_MEMORY", "SNAPSHOT_FIDELITY_ROOTFS"])(
    "accepts only the native snapshot preference %s without changing the Project spec",
    (preferredFidelity) => {
      const value = { ...project(), snapshotConfig: { preferredFidelity } };
      expect(parse(value)).toStrictEqual(value);
    },
  );
  test.each([
    "SNAPSHOT_FIDELITY_VOLUMES",
    "SNAPSHOT_FIDELITY_UNSPECIFIED",
    "SNAPSHOT_FIDELITY_UNKNOWN",
    "MEMORY",
    "ROOTFS",
    "",
    1,
    2,
    3,
    null,
    undefined,
  ])("rejects unsupported snapshot preference %s", (preferredFidelity) => {
    expect(() => parse({ ...project(), snapshotConfig: { preferredFidelity } })).toThrow();
  });
  test.each([
    { snapshotConfig: null },
    { snapshotConfig: [] },
    { snapshotConfig: "SNAPSHOT_FIDELITY_ROOTFS" },
    { snapshotConfig: {} },
  ])("rejects malformed or incomplete snapshot configuration %j", ({ snapshotConfig }) => {
    expect(() => parse({ ...project(), snapshotConfig })).toThrow();
  });
  test.each([
    ["storageLocation", "s3://unowned/snapshots"],
    ["goldenSnapshotConfig", { mode: "GOLDEN_SNAPSHOT_MODE_ENABLED" }],
    ["goldenSnapshotConfig", { mode: "GOLDEN_SNAPSHOT_MODE_DISABLED" }],
    ["unknown", true],
  ] as const)("rejects unsupported snapshot configuration key %s (%j)", (key, value) => {
    expect(() =>
      parse({
        ...project(),
        snapshotConfig: { preferredFidelity: "SNAPSHOT_FIDELITY_ROOTFS", [key]: value },
      }),
    ).toThrow();
  });
  test.each([
    "metadata",
    "workerSelector",
    "resources",
    "storageLocation",
    "goldenSnapshotConfig",
    "status",
    "dockerComposeFile",
    "build",
  ])("rejects repository-owned infrastructure/unsupported %s", (key) => {
    expect(() => parse({ ...project(), [key]: {} })).toThrow();
  });
  test.each(["args", "wakeupProbe"])("Factory rejects unsupported work %s", (key) => {
    const value = project();
    Object.assign(value.containers[0]!, {
      [key]: key === "wakeupProbe" ? { httpGet: { path: "/ready", port: 3000 } } : ["sh"],
    });
    expect(() => parse(value)).toThrow(key === "args" ? /preparation command/ : /Factory owns/);
  });
  test("retains the native work preparation argv without a Dev Container hook language", () => {
    const value = project();
    Object.assign(value.containers[0]!, {
      command: ["/bin/sh", "-ec"],
      args: ["npm ci && npm run db:migrate"],
    });
    const work = parse(value).containers[0]!;
    expect(work.command).toEqual(["/bin/sh", "-ec"]);
    expect(work.args).toEqual(["npm ci && npm run db:migrate"]);
  });
  test("rejects mutable images and unsupported privilege/device fields", () => {
    const value = project();
    value.containers[0]!.image = "node:latest";
    expect(() => parse(value)).toThrow(/immutable/);
    for (const key of ["privileged", "devices", "securityContext", "resources", "depends_on"]) {
      const value = project();
      Object.assign(value.containers[1]!, { [key]: {} });
      expect(() => parse(value)).toThrow();
    }
  });
  test("requires explicit native service entrypoints", () => {
    const value = project();
    Reflect.deleteProperty(value.containers[1]!, "command");
    expect(() => parse(value)).toThrow(/explicit entrypoint/);
  });
  test.each([
    "FACTORY_CONNECTOR_TOKEN",
    "ATE_NAMESPACE",
    "LD_PRELOAD",
    "HTTP_PROXY",
    "https_proxy",
    "SSL_CERT_FILE",
  ])("does not accept transport or infrastructure variable %s", (name) => {
    const value = project();
    value.containers[1]!.env = [{ name, value: "not-authority" }];
    expect(() => parse(value)).toThrow();
  });
  test("rejects duplicates, undeclared/overlapping/reserved mounts and missing work Source", () => {
    const mutations = [
      (value: ReturnType<typeof project>) => {
        value.containers[1]!.name = "work";
      },
      (value: ReturnType<typeof project>) => {
        value.volumes[1]!.name = "source";
      },
      (value: ReturnType<typeof project>) => {
        value.containers[0]!.volumeMounts[0]!.name = "missing";
      },
      (value: ReturnType<typeof project>) => {
        value.containers[0]!.volumeMounts = [];
      },
      (value: ReturnType<typeof project>) => {
        value.containers[0]!.name = "factory-control";
      },
      (value: ReturnType<typeof project>) => {
        value.volumes[1]!.name = "factory-skills";
      },
      (value: ReturnType<typeof project>) => {
        value.containers[0]!.volumeMounts[0]!.mountPath = "/run/factory-skills/admitted";
      },
      (value: ReturnType<typeof project>) => {
        value.containers[1]!.name = "database-";
      },
      (value: ReturnType<typeof project>) => {
        value.containers[0]!.volumeMounts[0]!.mountPath = "/";
      },
      (value: ReturnType<typeof project>) => {
        value.containers[0]!.volumeMounts[0]!.mountPath = "/opt/factory/stolen";
      },
      (value: ReturnType<typeof project>) => {
        value.containers[0]!.volumeMounts[0]!.mountPath = "/opt";
      },
      (value: ReturnType<typeof project>) => {
        value.containers[0]!.volumeMounts[0]!.mountPath = "/workspaces/monorepo/";
      },
      (value: ReturnType<typeof project>) => {
        value.containers[0]!.volumeMounts[0]!.mountPath = "/work/../escape";
      },
      (value: ReturnType<typeof project>) => {
        value.containers[0]!.volumeMounts.push({
          name: "database",
          mountPath: "/workspaces/monorepo/data",
        });
      },
    ];
    for (const mutate of mutations) {
      const value = project();
      mutate(value);
      expect(() => parse(value)).toThrow();
    }
  });
  test("rejects host/external/image volumes rather than constructing another storage provider", () => {
    for (const type of ["external", "hostPath", "image", "systemInfo"]) {
      const value = project();
      Object.assign(value.volumes[1]!, { [type]: {} });
      expect(() => parse(value)).toThrow();
    }
  });
  test("keeps all Source writers in work rather than sharing its directories with services", () => {
    const source = project();
    source.containers[1]!.volumeMounts.push({
      name: "source",
      mountPath: "/checkout",
    });
    expect(() => parse(source)).toThrow(/must not be shared with native services/);
    const sharedData = project();
    sharedData.containers[0]!.volumeMounts.push({
      name: "database",
      mountPath: "/service-data",
    });
    expect(() => parse(sharedData)).toThrow(/must not be shared with native services/);
  });
  test("bounds malformed and oversized input", () => {
    expect(() => parseSubstrateProjectTemplate("{")).toThrow(/valid JSON/);
    expect(() => parseSubstrateProjectTemplate(" ".repeat(65537))).toThrow(/64 KiB/);
  });
});
