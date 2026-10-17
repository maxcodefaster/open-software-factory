import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const scanner = new Bun.Transpiler({ loader: "ts" });

export function verificationEnvironment(environment: Record<string, string | undefined>) {
  const env = { ...environment };
  for (const key of Object.keys(env))
    if (
      key.startsWith("FACTORY_") &&
      (key.endsWith("_LIVE") || key.includes("_PROOF") || /MODEL.*(KEY|TOKEN|BASE_URL)/.test(key))
    )
      delete env[key];
  return env;
}

export function needsTheiaTestBuild(source: string) {
  return scanner
    .scanImports(source)
    .some(({ path }) =>
      /\/deploy\/theia-ide\/(?:node_modules\/|factory-ide-extension\/lib\/)/.test(path),
    );
}

export function prerequisiteFingerprint(files: readonly { path: string; content: string }[]) {
  const hash = new Bun.CryptoHasher("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path).update("\0").update(file.content).update("\0");
  }
  return hash.digest("hex");
}

async function fingerprint(directory: string, paths: string[]) {
  return prerequisiteFingerprint(
    await Promise.all(
      paths.map(async (path) => ({
        path,
        content: await readFile(resolve(directory, path), "utf8"),
      })),
    ),
  );
}

async function command(args: string[], directory: string, env: Record<string, string | undefined>) {
  const child = Bun.spawn(args, {
    cwd: directory,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0)
    throw new Error(`Test prerequisite ${args[0]} failed in ${directory}`);
}

export async function prepareTestPrerequisites(
  selected: string[],
  env: Record<string, string | undefined>,
) {
  const theia = (
    await Promise.all(selected.map((path) => readFile(resolve(root, path), "utf8")))
  ).some(needsTheiaTestBuild);
  const starter = selected.some((path) => path.endsWith("/starter-preview-auth.test.ts"));
  if (!theia && !starter) return;
  const cache = resolve(root, ".factory/cache/test-prerequisites");
  await mkdir(cache, { recursive: true });
  for (const target of [
    ...(theia ? [{ name: "theia", directory: "deploy/theia-ide" }] : []),
    ...(starter ? [{ name: "starter", directory: "templates/starter-app" }] : []),
  ]) {
    const directory = resolve(root, target.directory);
    const manifest = resolve(cache, `${target.name}.json`);
    const previous = await readFile(manifest, "utf8")
      .then((value) => JSON.parse(value) as { dependencies: string; build: string })
      .catch(() => undefined);
    const manifests = [
      "package.json",
      "package-lock.json",
      ...(target.name === "theia"
        ? ["browser-app/package.json", "factory-ide-extension/package.json"]
        : []),
    ];
    const dependencies = await fingerprint(directory, manifests);
    const installed =
      previous?.dependencies === dependencies &&
      (await Bun.file(
        resolve(
          directory,
          target.name === "theia"
            ? "node_modules/@theia/core/package.json"
            : "node_modules/better-auth/package.json",
        ),
      ).exists());
    if (!installed) {
      console.log(`Preparing locked ${target.name} dependencies for the selected tests`);
      await command(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], directory, env);
    }
    let build = dependencies;
    if (target.name === "theia") {
      const sources: string[] = [];
      for await (const path of new Bun.Glob("factory-ide-extension/src/**/*").scan({
        cwd: directory,
        onlyFiles: true,
      }))
        sources.push(path);
      build = await fingerprint(directory, [
        ...manifests,
        "factory-ide-extension/tsconfig.json",
        ...sources,
      ]);
      if (
        !installed ||
        previous?.build !== build ||
        !(await Bun.file(
          resolve(directory, "factory-ide-extension/lib/browser/factory-workspace-files.js"),
        ).exists())
      ) {
        console.log("Compiling the pinned Factory editor adapter for its tests");
        await command(
          ["npm", "run", "build", "--workspace", "factory-ide-extension"],
          directory,
          env,
        );
      }
    }
    await writeFile(manifest, JSON.stringify({ dependencies, build }));
  }
}
