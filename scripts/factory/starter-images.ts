import { z } from "zod";
import upstream from "../../upstream.json";

const pinned = z.string().regex(/^[a-zA-Z0-9.:/-]+@sha256:[a-f0-9]{64}$/);
export const starterImagesSchema = z.object({
  platform: z.enum(["linux/amd64", "linux/arm64"]),
  development: pinned,
  support: pinned,
});

export function starterImageManifest(index: unknown, platform: string) {
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

export function localStarterCompose(compose: string, images: z.infer<typeof starterImagesSchema>) {
  const confirmed = starterImagesSchema.parse(images);
  return compose
    .replaceAll(upstream.nodeDevelopment.image, confirmed.development)
    .replaceAll(upstream.node.image, confirmed.support);
}
