import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { nativeRuntimeArchitecture } from "#runtime-kubernetes/substrate-profile";
import { parseSubstrateProjectTemplate } from "#runtime-kubernetes/substrate-project-template";

const platform = z.enum(["linux/amd64", "linux/arm64"]);
const pinned = z.string().regex(/^[a-zA-Z0-9._:/-]+@sha256:[a-f0-9]{64}$/);
export const starterImagesSchema = z.strictObject({
  platform,
  development: pinned,
  postgres: pinned,
});
export type StarterImages = z.output<typeof starterImagesSchema>;

// These are published, prepared images, not upstream root images or Dockerfiles.
// The caller selects the native worker platform, never the control-plane host.
export function nativeStarterImages(selectedPlatform: string, input: unknown): StarterImages {
  const selected = platform.parse(selectedPlatform);
  if (!input)
    throw new Error(
      "Publish the native Starter work and PostgreSQL images, then configure FACTORY_STARTER_IMAGES with their platform and immutable digests",
    );
  const images = starterImagesSchema.parse(input);
  if (images.platform !== selected)
    throw new Error("Starter images do not match the selected native runtime platform");
  return images;
}

async function configuredStarterImages() {
  const catalog = process.env["FACTORY_STARTER_IMAGES"];
  const configuration = process.env["FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION"];
  if (!catalog || !configuration)
    throw new Error(
      "Starter creation requires published FACTORY_STARTER_IMAGES and the selected FACTORY_SUBSTRATE_WORKSPACES_CONFIGURATION",
    );
  const { runtime } = JSON.parse(await readFile(configuration, "utf8"));
  return nativeStarterImages(`linux/${nativeRuntimeArchitecture(runtime)}`, JSON.parse(catalog));
}

function actorTemplate(images: StarterImages) {
  return `${JSON.stringify(
    parseSubstrateProjectTemplate(
      JSON.stringify({
        containers: [
          {
            name: "work",
            image: images.development,
            command: ["/bin/sh", "-ec", "npm ci && npm run db:wait && npm run db:migrate"],
            volumeMounts: [{ name: "source", mountPath: "/workspace" }],
          },
          {
            name: "postgres",
            image: images.postgres,
            command: ["/usr/local/bin/docker-entrypoint.sh", "postgres", "-h", "127.0.0.1"],
            env: [
              { name: "POSTGRES_DB", value: "app" },
              { name: "POSTGRES_USER", value: "app" },
              { name: "PGDATA", value: "/data/pgdata" },
            ],
            volumeMounts: [{ name: "database", mountPath: "/data" }],
          },
        ],
        volumes: [
          { name: "source", durableDir: {} },
          { name: "database", durableDir: {} },
        ],
      }),
    ),
    null,
    2,
  )}\n`;
}

// Only the authored template. Installed packages, generated output and local
// secrets can never become Project source through Starter creation.
export async function starterFiles(input?: { platform: string; images: unknown }) {
  const images = input
    ? nativeStarterImages(input.platform, input.images)
    : await configuredStarterImages();
  const root = resolve(import.meta.dir, "../../../../templates/starter-app");
  const files: { path: string; content: string }[] = [];
  async function walk(directory: string, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        ["node_modules", "dist", ".output", ".tanstack", ".git"].includes(entry.name) ||
        entry.name.startsWith(".env")
      )
        continue;
      if (entry.isSymbolicLink()) throw new Error("Starter contains a symlink");
      const path = prefix + entry.name;
      if (entry.isDirectory()) await walk(resolve(directory, entry.name), `${path}/`);
      else if (entry.isFile())
        files.push({ path, content: await readFile(resolve(directory, entry.name), "utf8") });
    }
  }
  await walk(root);
  if (files.some((file) => file.path === ".factory/actor-template.json"))
    throw new Error("Starter ActorTemplate must use the selected published image catalog");
  files.push({ path: ".factory/actor-template.json", content: actorTemplate(images) });
  if (
    files.length > 100 ||
    files.reduce((size, file) => size + Buffer.byteLength(file.content), 0) > 2_000_000
  )
    throw new Error("Starter exceeds the supported source bounds");
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
