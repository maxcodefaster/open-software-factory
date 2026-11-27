import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { nativeRuntimeArchitecture } from "#runtime-kubernetes/substrate-profile";
import { parseSubstrateProjectTemplate } from "#runtime-kubernetes/substrate-project-template";
import { nativeStarterImages } from "../../apps/factory/src/setup/starter";

// Exact authored source only; never recursively copy a checkout, generated output
// or credentials into a live fixture. The catalog is explicit, never a fake default.
export async function runtimeProjectFiles(input: { platform: string; images: unknown }) {
  const images = nativeStarterImages(input.platform, input.images);
  const paths = [
    ".factory/actor-template.json",
    ".factory/system.json",
    ".forgejo/workflows/factory-verification.yml",
    "package.json",
    "README.md",
    "src/server.mjs",
    "src/version.txt",
    "src/worker.mjs",
    "support.mjs",
  ];
  return Promise.all(
    paths.map(async (path) => {
      let content = await readFile(resolve(import.meta.dir, "runtime-project", path), "utf8");
      if (path === ".factory/actor-template.json") {
        const template = parseSubstrateProjectTemplate(content);
        const work = template.containers.find((container) => container.name === "work");
        if (!work) throw new Error("Native runtime fixture has no work container");
        work.image = images.development;
        content = `${JSON.stringify(template, null, 2)}\n`;
      }
      return { path, content };
    }),
  );
}

// Live consumers select the actual native worker, then read the installation's
// explicit catalog. Missing publication fails before their owned setup begins.
export async function configuredRuntimeProjectFiles(nativeConfiguration: string) {
  const { runtime } = JSON.parse(await readFile(nativeConfiguration, "utf8"));
  const platform = `linux/${nativeRuntimeArchitecture(runtime)}`;
  const raw = process.env["FACTORY_STARTER_IMAGES"];
  const images: unknown = raw ? JSON.parse(raw) : undefined;
  return runtimeProjectFiles({ platform, images });
}
