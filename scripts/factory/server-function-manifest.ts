import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import type { PersistedServerFunctionManifest } from "@solidjs/vite-plugin";

export const factoryFunctionManifestID = "virtual:factory-server-functions";

export async function serverFunctionImports(root: string, buildDirectory: string) {
  const manifest: PersistedServerFunctionManifest = JSON.parse(
    await readFile(resolve(buildDirectory, "client/.vite/solid-server-functions.json"), "utf8"),
  );
  return manifest.modules
    .map((module) => `import ${JSON.stringify(resolve(root, module))};`)
    .join("\n");
}

// The pinned plugin reads two-invocation manifests from root/dist/client,
// irrespective of outDir. Supply its documented manifest virtual module from
// this build's own client discoveries without modifying the upstream compiler.
export function factoryServerFunctionManifest(root: string, buildDirectory: string): Plugin {
  return {
    name: "factory:server-function-manifest",
    enforce: "pre",
    resolveId(id) {
      if (id === factoryFunctionManifestID) return { id, moduleSideEffects: true };
    },
    async load(id) {
      if (id === factoryFunctionManifestID) return serverFunctionImports(root, buildDirectory);
    },
  };
}
