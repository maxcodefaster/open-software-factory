import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { runtimeArtifactsSchema, runtimeImageReference } from "../factory/artifacts";

const releaseSchema = z.strictObject({
  version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]+)?$/),
  factoryImage: runtimeImageReference,
});

function replaceOnce(text: string, pattern: RegExp, replacement: string, label: string) {
  if (!pattern.test(text)) throw new Error(`The chart has no ${label} line to set`);
  return text.replace(pattern, replacement);
}

/** Pin the control plane only. Runtime authority/trust comes from the operator's native configuration. */
export function releaseChartFiles(
  files: { chart: string; values: string },
  input: z.infer<typeof releaseSchema>,
) {
  const release = releaseSchema.parse(input);
  let chart = replaceOnce(files.chart, /^version: .*$/m, `version: ${release.version}`, "version");
  chart = replaceOnce(chart, /^appVersion: .*$/m, `appVersion: ${release.version}`, "appVersion");
  const values = replaceOnce(
    files.values,
    /^image: ""$/m,
    `image: "${release.factoryImage}"`,
    "image",
  );
  return { chart, values };
}

export async function packageFactoryChart(input: {
  version: string;
  factoryImage: string;
  artifacts: unknown;
  output: string;
}) {
  const release = releaseSchema.parse({ version: input.version, factoryImage: input.factoryImage });
  const artifacts = runtimeArtifactsSchema.parse(input.artifacts);
  const root = resolve(import.meta.dir, "../..");
  const output = resolve(input.output);
  const staging = await mkdtemp(join(tmpdir(), "factory-native-chart-"));
  const chartDirectory = join(staging, "factory");
  try {
    await mkdir(output, { recursive: true });
    await cp(join(root, "deploy/helm/factory"), chartDirectory, { recursive: true });
    const released = releaseChartFiles(
      {
        chart: await readFile(join(chartDirectory, "Chart.yaml"), "utf8"),
        values: await readFile(join(chartDirectory, "values.yaml"), "utf8"),
      },
      release,
    );
    await writeFile(join(chartDirectory, "Chart.yaml"), released.chart);
    await writeFile(join(chartDirectory, "values.yaml"), released.values);
    const catalog = `${JSON.stringify(artifacts, null, 2)}\n`;
    await writeFile(join(chartDirectory, "runtime-artifacts.json"), catalog);
    const packaged = Bun.spawn(["helm", "package", chartDirectory, "--destination", output], {
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await packaged.exited) !== 0) throw new Error("helm package failed");
    const catalogFile = join(output, `factory-runtime-artifacts-${release.version}.json`);
    await writeFile(catalogFile, catalog);
    return { chart: join(output, `factory-${release.version}.tgz`), artifacts: catalogFile };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      version: { type: "string" },
      "factory-image": { type: "string" },
      artifacts: { type: "string" },
      output: { type: "string", default: "." },
    },
  });
  if (!values.version || !values["factory-image"] || !values.artifacts)
    throw new Error(
      "Usage: package-chart --version VERSION --factory-image REF@sha256:... --artifacts FILE [--output DIR]",
    );
  await packageFactoryChart({
    version: values.version,
    factoryImage: values["factory-image"],
    artifacts: JSON.parse(await readFile(values.artifacts, "utf8")),
    output: values.output,
  });
}
