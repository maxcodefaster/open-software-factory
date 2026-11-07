import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { releaseChartFiles, workerValuesFile } from "./package-chart";

const chart = readFileSync("deploy/helm/factory/Chart.yaml", "utf8");
const values = readFileSync("deploy/helm/factory/values.yaml", "utf8");
const zeros = "0".repeat(64);
const release = {
  version: "0.1.0-beta.1",
  factoryImage: `ghcr.io/example/factory@sha256:${"1".repeat(64)}`,
  worker: {
    schema: 1 as const,
    image: `ghcr.io/example/factorybox-worker@sha256:${"2".repeat(64)}`,
    executableSHA256: "3".repeat(64),
    architecture: "arm64" as const,
  },
};

test("the released chart pins the Factory image and the signed worker, nothing else", () => {
  const released = releaseChartFiles({ chart, values }, release);
  expect(released.chart).toContain("version: 0.1.0-beta.1");
  expect(released.chart).toContain("appVersion: 0.1.0-beta.1");
  expect(released.values).toContain(`image: "${release.factoryImage}"`);
  expect(released.values).toContain(`  image: "${release.worker.image}"`);
  expect(released.values).toContain(`  executableSHA256: "${"3".repeat(64)}"`);
  expect(released.values).toContain('  architecture: "arm64"');
  expect(released.values).toContain('  nodeName: ""');
  expect(released.values.split("\n").length).toBe(values.split("\n").length);
});

test("a malformed release input is refused", () => {
  expect(() => releaseChartFiles({ chart, values }, { ...release, version: "beta" })).toThrow();
  expect(() =>
    releaseChartFiles(
      { chart, values },
      { ...release, factoryImage: "ghcr.io/example/factory:latest" },
    ),
  ).toThrow();
  expect(() =>
    releaseChartFiles(
      { chart, values },
      { ...release, worker: { ...release.worker, executableSHA256: zeros.slice(1) } },
    ),
  ).toThrow();
  expect(() => releaseChartFiles({ chart: "name: x\n", values }, release)).toThrow();
});

test("architecture values keep the worker image and executable together", () => {
  const amd64 = { ...release.worker, architecture: "amd64" as const };
  expect(Bun.YAML.parse(workerValuesFile(amd64))).toEqual({
    factorybox: {
      architecture: "amd64",
      image: amd64.image,
      executableSHA256: amd64.executableSHA256,
    },
  });
  expect(() => workerValuesFile({ ...amd64, executableSHA256: "" })).toThrow();
});
