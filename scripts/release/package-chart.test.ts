import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import imagePins from "../../deploy/helm/factory/image-pins.json";
import { runtimeArtifactNames } from "../factory/artifacts";
import { packageFactoryChart, releaseChartFiles } from "./package-chart";

const chart = readFileSync("deploy/helm/factory/Chart.yaml", "utf8");
const values = readFileSync("deploy/helm/factory/values.yaml", "utf8");
const release = {
  version: "0.1.0-beta.1",
  factoryImage: `ghcr.io/example/factory@sha256:${"1".repeat(64)}`,
};
const artifacts = Object.fromEntries(
  runtimeArtifactNames.map((role, i) => [
    role,
    `ghcr.io/example/${role}@sha256:${String(i + 2).repeat(64)}`,
  ]),
);

test("the released chart pins only Factory and leaves native trust and identity explicit", () => {
  const released = releaseChartFiles({ chart, values }, release);
  expect(released.chart).toContain("version: 0.1.0-beta.1");
  expect(released.chart).toContain("appVersion: 0.1.0-beta.1");
  expect(released.values).toContain(`image: "${release.factoryImage}"`);
  expect(released.values).toContain('  workspaceConfigurationSecret: ""');
  expect(released.values).toContain('  provisionerTokenSecret: ""');
  expect(released.values).not.toContain("factorybox:");
  expect(released.values.split("\n").length).toBe(values.split("\n").length);
});

test("malformed and legacy release inputs refuse rather than adding a worker compatibility path", () => {
  for (const invalid of [
    { ...release, version: "beta" },
    { ...release, factoryImage: "ghcr.io/example/factory:latest" },
    { ...release, worker: { image: "obsolete" } },
    { ...release, factoryImage: `ghcr.io/example/../factory@sha256:${"1".repeat(64)}` },
  ])
    expect(() => releaseChartFiles({ chart, values }, invalid)).toThrow();
  expect(() => releaseChartFiles({ chart: "name: x\n", values }, release)).toThrow();
});

test("real Helm packaging carries the complete Actor artifact set and no architecture worker values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-native-package-test-"));
  const run = async (args: string[]) => {
    const process = Bun.spawn(args, { cwd: directory, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    return { exit, stdout, stderr };
  };
  try {
    await expect(
      packageFactoryChart({
        ...release,
        artifacts: { "runtime-host": artifacts["runtime-host"] },
        output: directory,
      }),
    ).rejects.toThrow();
    const packaged = await packageFactoryChart({ ...release, artifacts, output: directory });
    expect(JSON.parse(await readFile(packaged.artifacts, "utf8"))).toEqual(artifacts);
    const content = await run(["tar", "-xzOf", packaged.chart, "factory/runtime-artifacts.json"]);
    expect(content.exit).toBe(0);
    expect(JSON.parse(content.stdout)).toEqual(artifacts);
    expect(Object.keys(JSON.parse(content.stdout))).toEqual([...runtimeArtifactNames]);
    expect(content.stdout).not.toContain("workspace-files");
    const pins = await run(["tar", "-xzOf", packaged.chart, "factory/image-pins.json"]);
    expect(pins.exit).toBe(0);
    expect(JSON.parse(pins.stdout)).toEqual(imagePins);
    const files = await run(["tar", "-tzf", packaged.chart]);
    expect(files.exit).toBe(0);
    expect(files.stdout).not.toContain("values.arm64.yaml");
    expect(files.stdout).not.toContain("values.amd64.yaml");
    const shown = await run(["helm", "show", "values", packaged.chart]);
    expect(shown.exit).toBe(0);
    expect(shown.stdout).not.toContain("factorybox");
    expect(shown.stdout).toContain(release.factoryImage);
    const missing = await run([
      "helm",
      "template",
      "native",
      packaged.chart,
      "--set",
      "publicURL=https://factory.example",
      "--set",
      "forgejoPublicURL=https://git.factory.example",
    ]);
    expect(missing.exit).not.toBe(0);
    expect(missing.stderr).toContain("substrate.workspaceConfigurationSecret");
    const rendered = await run([
      "helm",
      "template",
      "native",
      packaged.chart,
      "--set",
      "publicURL=https://factory.example",
      "--set",
      "forgejoPublicURL=https://git.factory.example",
      "--set",
      "substrate.workspaceConfigurationSecret=owned-native",
      "--set",
      "substrate.provisionerTokenSecret=owned-owner",
    ]);
    expect(rendered.exit).toBe(0);
    expect(rendered.stdout).not.toContain("FACTORY_FACTORYBOX");
    for (const image of Object.values(imagePins)) expect(rendered.stdout).toContain(image);
    const isolated = join(directory, "standalone");
    await mkdir(isolated);
    expect((await run(["tar", "-xzf", packaged.chart, "-C", isolated])).exit).toBe(0);
    await writeFile(
      join(isolated, "factory/image-pins.json"),
      JSON.stringify({ ...imagePins, zero: "untrusted:latest" }),
    );
    const invalidPins = await run([
      "helm",
      "template",
      "native",
      join(isolated, "factory"),
      "--set",
      "publicURL=https://factory.example",
      "--set",
      "forgejoPublicURL=https://git.factory.example",
      "--set",
      "substrate.workspaceConfigurationSecret=owned-native",
      "--set",
      "substrate.provisionerTokenSecret=owned-owner",
    ]);
    expect(invalidPins.exit).not.toBe(0);
    expect(invalidPins.stderr).toContain("zero service image must be pinned");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
