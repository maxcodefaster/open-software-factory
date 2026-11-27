import { z } from "zod";

export {
  nativeStarterImages,
  starterImagesSchema,
} from "../../apps/factory/src/setup/starter";

export function requireStarterImageConfiguration(
  input: unknown,
  role: "starter-work" | "starter-postgres",
  platform: "linux/arm64" | "linux/amd64",
) {
  const image = z
    .object({
      Id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      Os: z.literal("linux"),
      Architecture: z.enum(["arm64", "amd64"]),
      Config: z.object({ User: z.string() }),
    })
    .parse(input);
  if (`linux/${image.Architecture}` !== platform)
    throw new Error("Prepared Starter image differs from the selected native worker platform");
  if (image.Config.User !== (role === "starter-work" ? "1000:1000" : "postgres"))
    throw new Error("Prepared Starter image does not retain its required non-root user");
  return image.Id;
}

export function starterImageManifest(index: unknown, platform: string) {
  z.enum(["linux/amd64", "linux/arm64"]).parse(platform);
  const [os, architecture] = platform.split("/");
  const manifests = z
    .object({
      manifests: z.array(
        z.object({
          digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          platform: z.object({ os: z.string(), architecture: z.string() }),
        }),
      ),
    })
    .parse(index).manifests;
  const matches = manifests.filter(
    (manifest) => manifest.platform.os === os && manifest.platform.architecture === architecture,
  );
  if (matches.length !== 1) throw new Error("Starter image has no unique exact platform manifest");
  const [manifest] = matches;
  if (!manifest) throw new Error("Starter native manifest missing");
  return manifest.digest;
}
