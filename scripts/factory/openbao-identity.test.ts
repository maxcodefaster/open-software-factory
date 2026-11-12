import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localOpenBao } from "./openbao";

test.each([
  { uid: 1000 },
  { gid: 1000 },
  { uid: -1, gid: 1000 },
  { uid: 1000.5, gid: 1000 },
  { uid: 1000, gid: "1000" },
])(
  "local OpenBao rejects an incomplete or invalid runtime owner without changing retained identity: %j",
  async (profile) => {
    const directory = await mkdtemp(join(tmpdir(), "owned-openbao-identity-"));
    const state = join(directory, "openbao");
    await mkdir(state, { mode: 0o700 });
    const file = join(state, "identity.json");
    const bytes = JSON.stringify({ owner: crypto.randomUUID(), port: 40222, ...profile });
    await writeFile(file, bytes, { mode: 0o600 });
    try {
      await expect(localOpenBao(directory)).rejects.toThrow();
      expect(await readFile(file, "utf8")).toBe(bytes);
      expect(await lstat(join(state, "config")).catch(() => undefined)).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
