import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Only the authored template. Installed packages, generated output and local
// secrets can never become Project source through Starter creation.
export async function starterFiles() {
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
  if (
    files.length > 100 ||
    files.reduce((size, file) => size + Buffer.byteLength(file.content), 0) > 2_000_000
  )
    throw new Error("Starter exceeds the supported source bounds");
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
