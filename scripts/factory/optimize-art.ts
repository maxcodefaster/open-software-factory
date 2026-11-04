import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";

// Re-encodes the full-size wallpapers in apps/factory/public/art to at most `budget` bytes.
// Each picture keeps the highest JPEG quality (at least 62) that fits, at 2048 pixels wide or the next smaller width. The thumbnails
// are already small and stay as they are. Run: mise exec -- bun scripts/factory/optimize-art.ts
export const wallpaperWidths = [2048, 1920, 1792, 1600];
export const wallpaperBudget = 350_000;
const minimumQuality = 62;

function encodeAt(image: Awaited<ReturnType<typeof loadImage>>, width: number, budget: number) {
  const height = Math.round((image.height * width) / image.width);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, width, height);
  let best = canvas.toBuffer("image/jpeg", minimumQuality);
  if (best.length > budget) return undefined;
  let low = minimumQuality;
  let high = 85;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = canvas.toBuffer("image/jpeg", middle);
    if (candidate.length <= budget) {
      best = candidate;
      low = middle;
    } else high = middle - 1;
  }
  return { bytes: best, quality: low, width, height };
}

// The widest size that fits keeps the highest quality; very detailed paintings step down in width.
export async function encodeWallpaper(source: string | Buffer, budget = wallpaperBudget) {
  const image = await loadImage(source);
  for (const width of wallpaperWidths) {
    const encoded = encodeAt(image, Math.min(width, image.width), budget);
    if (encoded) return encoded;
  }
  throw new Error(`No width reaches ${budget} bytes at quality ${minimumQuality}`);
}

if (import.meta.main) {
  const directory = resolve(import.meta.dir, "../../apps/factory/public/art");
  for (const name of (await readdir(directory)).sort()) {
    if (!name.endsWith(".jpg") || name.endsWith("-thumb.jpg")) continue;
    const path = join(directory, name);
    const file = Bun.file(path);
    if (file.size <= wallpaperBudget) continue;
    const encoded = await encodeWallpaper(Buffer.from(await file.arrayBuffer()));
    await Bun.write(path, encoded.bytes);
    console.log(
      `${name}: ${file.size} -> ${encoded.bytes.length} bytes, ${encoded.width}x${encoded.height}, quality ${encoded.quality}`,
    );
  }
}
