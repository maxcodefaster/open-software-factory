import { readdirSync } from "node:fs";
import { resolve } from "node:path";

// The primary font is otherwise discovered only after the desktop renders, so
// text swaps late. The Link header starts that download with the document.
// Module preloads were measured and rejected: under HTTP/1.1's six connections
// they queued ahead of the bootstrap call.
export function createPageHint(clientDirectory: string) {
  let files: string[] = [];
  try {
    files = readdirSync(resolve(clientDirectory, "assets"));
  } catch {
    return undefined;
  }
  const font = files.find((file) => /^inter-latin-wght-normal-[\w-]{8,}\.woff2$/.test(file));
  const link = font
    ? `</assets/${font}>; rel=preload; as=font; type="font/woff2"; crossorigin`
    : undefined;
  return link;
}
