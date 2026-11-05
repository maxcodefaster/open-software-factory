import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

// Packages the Helm chart for a release. The packaged chart pins the released Factory image
// and the signed Factorybox worker that passed its native conformance, so an operator only
// supplies the node name and the public addresses.

const digestReference = z.string().regex(/^[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/);
export const workerRelease = z.object({
  schema: z.literal(1),
  image: digestReference,
  executableSHA256: z.string().regex(/^[a-f0-9]{64}$/),
  architecture: z.enum(["arm64", "amd64"]),
});

function replaceOnce(text: string, pattern: RegExp, replacement: string, label: string) {
  if (!pattern.test(text)) throw new Error(`The chart has no ${label} line to set`);
  return text.replace(pattern, replacement);
}

/** Sets the released defaults and keeps every comment and other value as written. */
export function releaseChartFiles(
  files: { chart: string; values: string },
  release: { version: string; factoryImage: string; worker: z.infer<typeof workerRelease> },
) {
  digestReference.parse(release.factoryImage);
  const worker = workerRelease.parse(release.worker);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]+)?$/.test(release.version))
    throw new Error("The release version must look like 0.1.0 or 0.1.0-beta.1");
  let chart = replaceOnce(files.chart, /^version: .*$/m, `version: ${release.version}`, "version");
  chart = replaceOnce(chart, /^appVersion: .*$/m, `appVersion: ${release.version}`, "appVersion");
  let values = replaceOnce(
    files.values,
    /^image: ""$/m,
    `image: "${release.factoryImage}"`,
    "image",
  );
  const factorybox = /^factorybox:\n((?: {2}.*\n|#.*\n|\n)*)/m.exec(values);
  if (!factorybox) throw new Error("The chart has no factorybox block");
  let block = factorybox[0];
  block = replaceOnce(block, /^ {2}image: ""$/m, `  image: "${worker.image}"`, "factorybox image");
  block = replaceOnce(
    block,
    /^ {2}executableSHA256: ""$/m,
    `  executableSHA256: "${worker.executableSHA256}"`,
    "factorybox executableSHA256",
  );
  block = replaceOnce(
    block,
    /^ {2}architecture: ""$/m,
    `  architecture: "${worker.architecture}"`,
    "factorybox architecture",
  );
  values = values.replace(factorybox[0], block);
  return { chart, values };
}

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
  const version = option("--version");
  const factoryImage = option("--factory-image");
  const output = option("--output") ?? ".";
  if (!version || !factoryImage)
    throw new Error(
      "Usage: package-chart --version 0.1.0-beta.1 --factory-image REF@sha256:... [--output DIR]",
    );
  const root = resolve(import.meta.dir, "../..");
  const worker = workerRelease.parse(
    JSON.parse(await readFile(join(root, "deploy/factorybox/release.json"), "utf8")),
  );
  const staging = await mkdtemp(join(tmpdir(), "factory-chart-"));
  const chartDirectory = join(staging, "factory");
  await cp(join(root, "deploy/helm/factory"), chartDirectory, { recursive: true });
  const released = releaseChartFiles(
    {
      chart: await readFile(join(chartDirectory, "Chart.yaml"), "utf8"),
      values: await readFile(join(chartDirectory, "values.yaml"), "utf8"),
    },
    { version, factoryImage, worker },
  );
  await writeFile(join(chartDirectory, "Chart.yaml"), released.chart);
  await writeFile(join(chartDirectory, "values.yaml"), released.values);
  const packaged = Bun.spawn(
    ["helm", "package", chartDirectory, "--destination", resolve(output)],
    {
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if ((await packaged.exited) !== 0) throw new Error("helm package failed");
}
