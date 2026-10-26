import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { requirePinnedImage } from "./preflight";

export const runtimeArtifactNames = [
  "runtime-host",
  "browser-tools",
  "workspace-files",
  "developer-ide",
] as const;

export const runtimeArtifactsSchema = z.record(
  z.enum(runtimeArtifactNames),
  z.string().regex(/^[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}$/),
);
export type RuntimeArtifacts = z.infer<typeof runtimeArtifactsSchema>;

export function localRuntimeDefaults(
  published: RuntimeArtifacts | null,
  bootstrap: { runtimeImage: string; browserImage: string } | null,
) {
  return {
    runtimeImage: published?.["runtime-host"] ?? bootstrap?.runtimeImage,
    browserImage: published?.["browser-tools"] ?? bootstrap?.browserImage,
  };
}

// Publish one complete generation atomically. These are defaults for future
// creates; persisted Runtime Attempts keep their own immutable image references.
export async function installRuntimeArtifacts(directory: string, bundle: unknown) {
  const references = runtimeArtifactsSchema.parse(bundle);
  const destination = resolve(directory, "runtime-artifacts.json");
  const temporary = `${destination}.${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, JSON.stringify(references), { mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return references;
}

// A normal restart reuses immutable artifacts. Publication is explicit, not a
// side effect of opening Factory. Missing/partial first-install state builds once.
export async function publishedRuntimeArtifacts(directory: string) {
  const bundle = await readFile(resolve(directory, "runtime-artifacts.json"), "utf8").catch(
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return null;
      throw cause;
    },
  );
  if (bundle !== null) return runtimeArtifactsSchema.parse(JSON.parse(bundle));
  const references: Record<string, string> = {};
  for (const name of runtimeArtifactNames) {
    const value = await readFile(resolve(directory, `${name}-image`), "utf8").catch(
      (cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return null;
        throw cause;
      },
    );
    if (value === null) return null;
    requirePinnedImage(value.trim());
    references[name] = value.trim();
  }
  return references;
}
