import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import upstream from "../../upstream.json";
import { type FactoryboxFixtureTarget, factoryboxFixtureCommand } from "./factorybox-runtime";

export async function projectPrebuildRecipe(artifacts: string) {
  const directory = resolve(artifacts, "recipe-repository");
  const git = async (...args: string[]) =>
    (
      await promisify(execFile)("git", ["-C", directory, ...args], { timeout: 30_000 })
    ).stdout.trim();
  await promisify(execFile)(
    "git",
    ["clone", "--no-hardlinks", "--", resolve(".factory/runtime-fixture-repository"), directory],
    { timeout: 30_000 },
  );
  const seed = ".devcontainer/prebuild/seed";
  const files: Record<string, string> = {
    ".devcontainer/prebuild/devcontainer.json": JSON.stringify({
      build: { dockerfile: "Dockerfile", context: "../.." },
      features: { "./feature": {} },
      remoteUser: "node",
      onCreateCommand: [
        "node",
        "-e",
        "const fs=require('fs');if(!fs.existsSync('prebuilt-dependency'))fs.cpSync('/opt/project-seed','prebuilt-dependency',{recursive:true,verbatimSymlinks:true});",
      ],
    }),
    ".devcontainer/prebuild/devcontainer-lock.json": JSON.stringify({ features: {} }),
    ".devcontainer/prebuild/Dockerfile": `FROM ${upstream.nodeDevelopment.image.replace(/:[^/@]+(?=@sha256:)/, "")}\nCOPY ${seed} /opt/project-seed\nRUN cd /opt/project-seed && npm ci --offline --ignore-scripts --no-audit --no-fund\n`,
    ".devcontainer/prebuild/feature/devcontainer-feature.json": JSON.stringify({
      id: "factory-proof",
      version: "1.0.0",
      name: "Exact local Feature proof",
      postCreateCommand: [
        "node",
        "-e",
        "require('fs').writeFileSync('prebuild-hook.txt','required hook ran\\n')",
      ],
    }),
    ".devcontainer/prebuild/feature/install.sh":
      "#!/bin/sh\nset -eu\nprintf 'exact committed Feature\\n' > /opt/project-feature-proof\n",
    [`${seed}/package.json`]: JSON.stringify({
      name: "project-seed",
      version: "1.0.0",
      dependencies: { "proof-dependency": "file:./dependency" },
    }),
    [`${seed}/dependency/package.json`]: JSON.stringify({
      name: "proof-dependency",
      version: "1.0.0",
      main: "index.js",
    }),
    [`${seed}/dependency/index.js`]: "module.exports='exact locked dependency';\n",
    [`${seed}/package-lock.json`]: JSON.stringify({
      name: "project-seed",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "project-seed",
          version: "1.0.0",
          dependencies: { "proof-dependency": "file:./dependency" },
        },
        dependency: { name: "proof-dependency", version: "1.0.0" },
        "node_modules/proof-dependency": { resolved: "dependency", link: true },
      },
    }),
  };
  for (const [name, content] of Object.entries(files)) {
    const path = resolve(directory, name);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
  await git("add", ".devcontainer/prebuild");
  await git(
    "-c",
    "user.name=Factory prebuild fixture",
    "-c",
    "user.email=prebuild@example.test",
    "commit",
    "-m",
    "exact local Feature and locked dependency recipe",
  );
  return { directory, commit: await git("rev-parse", "HEAD") };
}

const prebuildResult = z
  .object({
    identity: z.string().regex(/^[a-f0-9]{64}$/),
    image: z.string().regex(/@sha256:[a-f0-9]{64}$/),
  })
  .strict();

export async function produceOwnedProjectPrebuild(input: {
  target: FactoryboxFixtureTarget;
  projectID: string;
  commit: string;
}) {
  const { runtimeHostImage, profile } = input.target.input;
  const registry = runtimeHostImage.slice(0, runtimeHostImage.indexOf("/"));
  const command = [
    "factory-project-prebuild",
    "--commit",
    input.commit,
    "--platform",
    `linux/${profile.architecture}`,
    "--config",
    ".devcontainer/prebuild/devcontainer.json",
    "--image-repository",
    `${registry}/open-factory/prebuilds/${input.projectID}`,
  ];
  const started = performance.now();
  const first = prebuildResult.parse(
    JSON.parse(await factoryboxFixtureCommand(input.target, command, 180_000)),
  );
  const firstMS = Math.round(performance.now() - started);
  const replayAt = performance.now();
  const replay = prebuildResult.parse(
    JSON.parse(await factoryboxFixtureCommand(input.target, command, 180_000)),
  );
  if (JSON.stringify(first) !== JSON.stringify(replay))
    throw new Error("Project prebuild replay changed its immutable artifact");
  const check =
    "const fs=require('fs');process.stdout.write(JSON.stringify({feature:fs.readFileSync('/opt/project-feature-proof','utf8'),dependency:require('/opt/project-seed/node_modules/proof-dependency')}));";
  const seed = z
    .object({ feature: z.string(), dependency: z.string() })
    .parse(
      JSON.parse(
        await factoryboxFixtureCommand(input.target, [
          "docker",
          "run",
          "--rm",
          "--network",
          "none",
          first.image,
          "node",
          "-e",
          check,
        ]),
      ),
    );
  return { ...first, firstMS, replayMS: Math.round(performance.now() - replayAt), seed };
}
