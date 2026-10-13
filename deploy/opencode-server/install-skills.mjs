import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  lstat,
  chmod,
  rename,
  readdir,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const hash = (value) => createHash("sha256").update(value).digest("hex");
// Only the privileged Factory parent invokes this installer. No source checkout paths.
export async function installSkills(manifest, root = "/opt/factory/admitted-skills") {
  if (
    !manifest ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > 1100 ||
    hash(JSON.stringify(manifest.files)) !== manifest.digest
  )
    throw new Error("Invalid admitted skill manifest");
  const seen = new Set();
  for (const file of manifest.files) {
    if (
      typeof file.path !== "string" ||
      !/^factory-[a-f0-9-]{36}\/[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/.test(
        file.path,
      ) ||
      file.path.split("/").some((part) => part === "." || part === "..") ||
      seen.has(file.path) ||
      typeof file.body !== "string" ||
      typeof file.executable !== "boolean" ||
      hash(Buffer.from(file.body, "base64")) !== file.digest
    )
      throw new Error("Invalid admitted skill file");
    seen.add(file.path);
  }
  if (Buffer.byteLength(JSON.stringify(manifest)) > 7_100_000)
    throw new Error("Admitted skill manifest is too large");
  async function inspectDirectory(path) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Skill storage must be a regular directory");
  }
  await mkdir(dirname(root), { recursive: true });
  await inspectDirectory(dirname(root));
  let present = true;
  try {
    await inspectDirectory(root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    present = false;
  }
  if (present) {
    const saved = JSON.parse(await readFile(join(root, ".manifest.json"), "utf8"));
    if (saved.digest !== manifest.digest)
      throw new Error("Runtime is already bound to another admitted skill set");
    const actual = [];
    async function walk(path, prefix = "") {
      for (const name of await readdir(path)) {
        if (!prefix && name === ".manifest.json") continue;
        const relative = `${prefix}${name}`;
        const info = await lstat(join(path, name));
        if (info.isSymbolicLink()) throw new Error("Skill storage contains a symlink");
        if (info.isDirectory()) await walk(join(path, name), `${relative}/`);
        else if (info.isFile()) actual.push(relative);
        else throw new Error("Skill storage contains an unsupported resource");
      }
    }
    await walk(root);
    if (actual.length !== manifest.files.length || actual.some((path) => !seen.has(path)))
      throw new Error("Admitted skill package changed");
    for (const file of manifest.files)
      if (hash(await readFile(join(root, file.path))) !== file.digest)
        throw new Error("Admitted skill package changed");
    return;
  }
  const temporary = await mkdtemp(`${root}.pending-`);
  for (const file of manifest.files) {
    const target = join(temporary, file.path);
    const parts = file.path.split("/").slice(0, -1);
    let parent = temporary;
    for (const part of parts) {
      parent = join(parent, part);
      await mkdir(parent, { recursive: true });
      await inspectDirectory(parent);
    }
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe skill file destination");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await writeFile(target, Buffer.from(file.body, "base64"), {
      mode: file.executable ? 0o555 : 0o444,
    });
    await chmod(target, file.executable ? 0o555 : 0o444);
  }
  await writeFile(join(temporary, ".manifest.json"), JSON.stringify(manifest), { mode: 0o444 });
  async function seal(path) {
    for (const name of await readdir(path)) {
      const target = join(path, name);
      if ((await lstat(target)).isDirectory()) await seal(target);
    }
    await chmod(path, 0o555);
  }
  await seal(temporary);
  await rename(temporary, root);
}
if (import.meta.main) {
  const input = await Bun.stdin.text();
  await installSkills(JSON.parse(input));
}
