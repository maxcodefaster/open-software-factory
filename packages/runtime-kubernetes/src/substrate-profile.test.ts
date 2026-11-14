import { expect, test } from "bun:test";
import { nativeRuntimeArchitecture, pinnedNativeSandboxSpec } from "./substrate-profile";

test.each(["amd64", "arm64"])("native runtime keeps its observed %s identity", (value) => {
  const runtime = {
    version: {
      attributes: [
        { key: "architecture", value },
        { key: "sandbox_bundle_hash", value: `sha256:${"a".repeat(64)}` },
      ],
    },
  };
  const before = structuredClone(runtime);
  expect(nativeRuntimeArchitecture(runtime)).toBe(value);
  expect(runtime).toEqual(before);
});

for (const attributes of [
  [],
  [{ key: "architecture", value: "riscv64" }],
  [{ key: "architecture", value: "ARM64" }],
  [
    { key: "architecture", value: "arm64" },
    { key: "architecture", value: "arm64" },
  ],
  [
    { key: "architecture", value: "arm64" },
    { key: "architecture", value: "amd64" },
  ],
])
  test(`unknown or ambiguous native architecture refuses without a host fallback: ${JSON.stringify(attributes)}`, () => {
    expect(() => nativeRuntimeArchitecture({ version: { attributes } })).toThrow();
  });

test("both official archives share the pinned profile version but never each other's content hash", () => {
  const spec = pinnedNativeSandboxSpec();
  const assets = spec.versions[0]?.assets;
  expect(Object.keys(assets ?? {}).sort()).toEqual(["amd64", "arm64"]);
  expect(assets?.arm64.gvisor.url).toContain("/aarch64/");
  expect(assets?.amd64.gvisor.url).toContain("/x86_64/");
  expect(assets?.arm64.gvisor.sha256).not.toBe(assets?.amd64.gvisor.sha256);
  expect(spec).toEqual(pinnedNativeSandboxSpec());
});
