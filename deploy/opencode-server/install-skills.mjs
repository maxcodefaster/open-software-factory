import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const nativeRoot = "/var/lib/factory/skills/admitted";
// Only trusted native control invokes the CLI. Work sees the same volume at
// /run/factory-skills/admitted. The optional root is for isolated installer tests.
export async function installSkills(manifest, root = nativeRoot) {
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
      !file ||
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
  const native = root === nativeRoot;
  if (native && (process.getuid() !== 0 || process.getgid() !== 0))
    throw new Error("Skill installation requires root native control");
  const uid = native ? 0 : process.getuid();
  const gid = native ? 0 : process.getgid();
  function inspectOwner(info, mode) {
    if (
      info.uid !== uid ||
      info.gid !== gid ||
      (mode === undefined ? (info.mode & 0o7022) !== 0 : (info.mode & 0o7777) !== mode)
    )
      throw new Error("Admitted skill package changed: storage owner or permissions");
  }
  async function inspectDirectory(path, mode) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Skill storage must be a regular directory");
    inspectOwner(info, mode);
  }
  async function inspectFile(path, mode) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new Error("Admitted skill package changed: unsafe file");
    inspectOwner(info, mode);
  }
  // Main initializes the fixed root-owned 0755 volume before Work admission.
  // Never create, follow or repair an unsafe storage parent during installation.
  await inspectDirectory(dirname(root), native ? 0o755 : undefined);
  let present = true;
  try {
    await inspectDirectory(root, 0o555);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    present = false;
  }
  if (present) {
    await inspectFile(join(root, ".manifest.json"), 0o444);
    const saved = JSON.parse(await readFile(join(root, ".manifest.json"), "utf8"));
    if (saved.digest !== manifest.digest)
      throw new Error("Runtime is already bound to another admitted skill set");
    if (hash(JSON.stringify(saved.files)) !== manifest.digest)
      throw new Error("Admitted skill package changed: manifest");
    const actual = [];
    async function walk(path, prefix = "") {
      for (const name of await readdir(path)) {
        if (!prefix && name === ".manifest.json") continue;
        const relative = `${prefix}${name}`;
        const info = await lstat(join(path, name));
        if (info.isSymbolicLink()) throw new Error("Skill storage contains a symlink");
        if (info.isDirectory()) {
          if (!manifest.files.some((file) => file.path.startsWith(`${relative}/`)))
            throw new Error("Admitted skill package changed");
          inspectOwner(info, 0o555);
          await walk(join(path, name), `${relative}/`);
        } else if (info.isFile()) actual.push(relative);
        else throw new Error("Skill storage contains an unsupported resource");
      }
    }
    await walk(root);
    if (actual.length !== manifest.files.length || actual.some((path) => !seen.has(path)))
      throw new Error("Admitted skill package changed");
    for (const file of manifest.files) {
      await inspectFile(join(root, file.path), file.executable ? 0o555 : 0o444);
      if (hash(await readFile(join(root, file.path))) !== file.digest)
        throw new Error("Admitted skill package changed");
    }
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
      flag: "wx",
    });
    await chmod(target, file.executable ? 0o555 : 0o444);
  }
  await writeFile(join(temporary, ".manifest.json"), JSON.stringify(manifest), { mode: 0o444 });
  await chmod(join(temporary, ".manifest.json"), 0o444);
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
