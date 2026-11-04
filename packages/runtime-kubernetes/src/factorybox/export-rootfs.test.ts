import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = await readFile(new URL("./export-rootfs.sh", import.meta.url), "utf8");
const writer = script.match(/<<'FACTORY_EXPORT'\n([\s\S]*?)\nFACTORY_EXPORT/)?.[1];
if (!writer) throw new Error("Missing production streaming archive writer");
const node = Bun.which("node");
if (!node) throw new Error("Use the repository-pinned Node runtime");

test.each([0, 42])(
  "streaming export preserves producer exit %i without buffering the archive",
  async (code) => {
    const directory = await mkdtemp(join(tmpdir(), "factory-export-"));
    const destination = join(directory, "rootfs.partial");
    try {
      await writeFile(
        join(directory, "tar"),
        `#!/bin/sh\nexec ${JSON.stringify(node)} -e 'process.stdout.write(Buffer.alloc(17 * 1024 * 1024, 65)); process.exitCode = ${code};'\n`,
        { mode: 0o700 },
      );
      const process = Bun.spawn(
        [
          node,
          "--input-type=module",
          "-e",
          writer.replaceAll("/factory-seed/rootfs.partial", destination),
        ],
        { env: { PATH: directory }, stdout: "ignore", stderr: "pipe" },
      );
      const [exit, error] = await Promise.all([
        process.exited,
        new Response(process.stderr).text(),
      ]);
      expect(exit === 0).toBe(code === 0);
      if (code) expect(error).toContain(`Runtime archive failed: ${code}`);
      const content = await readFile(destination);
      expect(content.byteLength).toBe(17 * 1024 * 1024);
      expect(content.every((value) => value === 65)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("streaming export refuses an existing output before starting its producer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-export-"));
  const destination = join(directory, "rootfs.partial");
  const marker = join(directory, "producer-started");
  try {
    await writeFile(destination, "retained original");
    await writeFile(join(directory, "tar"), `#!/bin/sh\n: > ${JSON.stringify(marker)}\n`, {
      mode: 0o700,
    });
    const process = Bun.spawn(
      [
        node,
        "--input-type=module",
        "-e",
        writer.replaceAll("/factory-seed/rootfs.partial", destination),
      ],
      { env: { PATH: directory }, stdout: "ignore", stderr: "pipe" },
    );
    const [exit, error] = await Promise.all([process.exited, new Response(process.stderr).text()]);
    expect(exit).not.toBe(0);
    expect(error).toContain("EEXIST");
    expect(await readFile(destination, "utf8")).toBe("retained original");
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("streaming export prints the digest of exactly the bytes it wrote", async () => {
  const directory = await mkdtemp(join(tmpdir(), "factory-export-"));
  const destination = join(directory, "rootfs.partial");
  try {
    await writeFile(
      join(directory, "tar"),
      `#!/bin/sh\nexec ${JSON.stringify(node)} -e 'process.stdout.write(Buffer.alloc(9 * 1024 * 1024 + 5, 66));'\n`,
      { mode: 0o700 },
    );
    const process = Bun.spawn(
      [
        node,
        "--input-type=module",
        "-e",
        writer.replaceAll("/factory-seed/rootfs.partial", destination),
      ],
      { env: { PATH: directory }, stdout: "pipe", stderr: "pipe" },
    );
    const [exit, output] = await Promise.all([process.exited, new Response(process.stdout).text()]);
    expect(exit).toBe(0);
    expect(output.trim()).toBe(
      createHash("sha256")
        .update(await readFile(destination))
        .digest("hex"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const reuse = script.match(/<<'FACTORY_REUSE'\n([\s\S]*?)\nFACTORY_REUSE/)?.[1];
if (!reuse) throw new Error("Missing production export reuse program");
const image = `registry.example/runtime@sha256:${"a".repeat(64)}`;
const store = "b".repeat(32);

async function reuseFixture(
  options: { corrupt?: boolean; receipt?: boolean; retired?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "factory-reuse-"));
  const previous = join(root, "seeds", "c".repeat(32), "bootstrap");
  const seed = join(root, "seed");
  await mkdir(previous, { recursive: true, mode: 0o700 });
  await mkdir(seed, { mode: 0o700 });
  const content = Buffer.alloc(3 * 1024 * 1024 + 7, 67);
  const sha = createHash("sha256").update(content).digest("hex");
  await writeFile(join(previous, "intent"), `old-pod\n${store}\n${image}\n`, { mode: 0o600 });
  await writeFile(join(previous, "rootfs.sha256"), `${sha}  rootfs.tar\n`, { mode: 0o600 });
  await writeFile(join(previous, "rootfs.tar"), content, { mode: 0o600 });
  await chmod(join(previous, "rootfs.tar"), 0o600);
  const info = await stat(join(previous, "rootfs.tar"), { bigint: true });
  if (options.receipt !== false)
    await writeFile(
      join(previous, "rootfs.verified.json"),
      `{"version":1,"sha256":"${sha}","file":{"device":${info.dev},"inode":${info.ino},"bytes":${info.size},"mtimeNS":${info.mtimeNs},"ctimeNS":${info.ctimeNs}}}\n`,
      { mode: 0o600 },
    );
  if (options.retired)
    await writeFile(join(previous, "archive-retirement.json"), "{}", { mode: 0o600 });
  if (options.corrupt) {
    // The receipt would be stale after this write, so restore a receipt that matches the corrupted identity.
    const bad = Buffer.from(content);
    bad[10] = 0;
    await writeFile(join(previous, "rootfs.tar"), bad);
    const changed = await stat(join(previous, "rootfs.tar"), { bigint: true });
    await writeFile(
      join(previous, "rootfs.verified.json"),
      `{"version":1,"sha256":"${sha}","file":{"device":${changed.dev},"inode":${changed.ino},"bytes":${changed.size},"mtimeNS":${changed.mtimeNs},"ctimeNS":${changed.ctimeNs}}}\n`,
      { mode: 0o600 },
    );
  }
  if (!reuse || !node) throw new Error("The reuse program or node is missing");
  const program = reuse
    .replaceAll("/factory-seeds", join(root, "seeds"))
    .replaceAll("/factory-seed/", `${seed}/`);
  const run = async () => {
    const process = Bun.spawn([node, "--input-type=module", "-e", program], {
      env: {
        PATH: Bun.env["PATH"] ?? "",
        FACTORY_STORE_ID: store,
        FACTORY_RUNTIME_IMAGE: image,
        FACTORY_SEED_NAMESPACE: "d".repeat(32),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    return { exit, stdout, stderr };
  };
  return { root, previous, seed, content, sha, run };
}

test("a replacement worker reuses a receipted export of the same image after hashing its copy", async () => {
  const fixture = await reuseFixture();
  try {
    const result = await fixture.run();
    expect(result.exit).toBe(0);
    expect(Buffer.compare(await readFile(join(fixture.seed, "rootfs.tar")), fixture.content)).toBe(
      0,
    );
    expect((await readFile(join(fixture.seed, "rootfs.sha256"), "utf8")).trim()).toBe(
      `${fixture.sha}  rootfs.tar`,
    );
    const receipt = await readFile(join(fixture.seed, "rootfs.verified.json"), "utf8");
    const info = await stat(join(fixture.seed, "rootfs.tar"), { bigint: true });
    expect(receipt).toBe(
      `{"version":1,"sha256":"${fixture.sha}","file":{"device":${info.dev},"inode":${info.ino},"bytes":${info.size},"mtimeNS":${info.mtimeNs},"ctimeNS":${info.ctimeNs}}}\n`,
    );
    expect(await Bun.file(join(fixture.seed, "rootfs.partial")).exists()).toBe(false);
    // The source stays untouched for its own owner to retire.
    expect(
      Buffer.compare(await readFile(join(fixture.previous, "rootfs.tar")), fixture.content),
    ).toBe(0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test.each([
  ["no identity receipt", { receipt: false }],
  ["a retirement in progress", { retired: true }],
  ["a corrupted source with a matching identity", { corrupt: true }],
])("export reuse refuses %s and leaves nothing behind", async (_name, options) => {
  const fixture = await reuseFixture(options);
  try {
    const result = await fixture.run();
    expect(result.exit).not.toBe(0);
    for (const name of ["rootfs.tar", "rootfs.partial", "rootfs.sha256", "rootfs.verified.json"])
      expect(await Bun.file(join(fixture.seed, name)).exists()).toBe(false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("export reuse ignores another image or store", async () => {
  const fixture = await reuseFixture();
  try {
    const run = (environment: Record<string, string>) => {
      const program = reuse
        .replaceAll("/factory-seeds", join(fixture.root, "seeds"))
        .replaceAll("/factory-seed/", `${fixture.seed}/`);
      return Bun.spawn([node, "--input-type=module", "-e", program], {
        env: {
          PATH: Bun.env["PATH"] ?? "",
          FACTORY_STORE_ID: store,
          FACTORY_RUNTIME_IMAGE: image,
          ...environment,
        },
        stdout: "ignore",
        stderr: "ignore",
      }).exited;
    };
    expect(
      await run({ FACTORY_RUNTIME_IMAGE: `registry.example/other@sha256:${"e".repeat(64)}` }),
    ).not.toBe(0);
    expect(await run({ FACTORY_STORE_ID: "f".repeat(32) })).not.toBe(0);
    expect(await Bun.file(join(fixture.seed, "rootfs.tar")).exists()).toBe(false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the export archive excludes the exporter's own output and earlier admissions' exports", () => {
  expect(script).toContain("'--exclude=./factory-seed',");
  expect(script).toContain("'--exclude=./factory-seeds',");
});
