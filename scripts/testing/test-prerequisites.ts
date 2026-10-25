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
    else if (key.startsWith("FACTORY_ATTACHMENT_S3_")) delete env[key];
  return env;
}

// Bun tests set NODE_ENV=test. A built frontend is served by the real backend,
// not Vite's development proxy, so it must not compile import.meta.env.DEV=true.
// Keep the test runner's own environment unchanged.
export function productionBuildEnvironment(environment: Record<string, string | undefined>) {
  return { ...environment, NODE_ENV: "production" };
}

export function needsTheiaTestBuild(source: string) {
  return scanner
    .scanImports(source)
    .some(({ path }) =>
      /\/deploy\/theia-ide\/(?:node_modules\/|factory-ide-extension\/lib\/)/.test(path),
    );
}

export function needsOIDCTestCA(source: string) {
  return scanner.scanImports(source).some(({ path }) => /\/fixtures\/oidc-provider$/.test(path));
}

export async function appendOwnedTestCA(
  env: Record<string, string | undefined>,
  certificate: string,
  directory: string,
) {
  if (!certificate.includes("-----BEGIN CERTIFICATE-----") || certificate.includes("PRIVATE KEY"))
    throw new Error("Owned test CA must contain public certificates only");
  const previous = env["NODE_EXTRA_CA_CERTS"];
  const existing = previous ? await readFile(previous, "utf8") : "";
  if (existing.includes(certificate.trim())) return;
  const bundle = `${existing.trimEnd()}\n${certificate.trim()}\n`;
  const digest = new Bun.CryptoHasher("sha256").update(bundle).digest("hex");
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `oidc-ca-${digest}.pem`);
  await writeFile(path, bundle, { mode: 0o600 });
  env["NODE_EXTRA_CA_CERTS"] = path;
}

export function needsStarterTestDependencies(selected: readonly string[]) {
  return selected.some((path) =>
    ["/starter.test.ts", "/starter-preview-auth.test.ts"].some((suffix) => path.endsWith(suffix)),
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
  const sources = await Promise.all(selected.map((path) => readFile(resolve(root, path), "utf8")));
  const theia = sources.some(needsTheiaTestBuild);
  const starter = needsStarterTestDependencies(selected);
  const cache = resolve(root, ".factory/cache/test-prerequisites");
  if (sources.some(needsOIDCTestCA)) {
    const mkcert = Bun.spawn(["mise", "exec", "--", "mkcert", "-CAROOT"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const caRoot = (await new Response(mkcert.stdout).text()).trim();
    if ((await mkcert.exited) !== 0 || !caRoot) throw new Error("Owned OIDC test CA unavailable");
    await appendOwnedTestCA(env, await readFile(resolve(caRoot, "rootCA.pem"), "utf8"), cache);
  }
  if (!theia && !starter) return;
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
