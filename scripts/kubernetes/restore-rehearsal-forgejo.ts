// Self-contained Forgejo SQLite snapshot witness validator (serialized via invocation()).
import type { Witnesses } from "./restore-rehearsal-types";

export async function validateForgejoDatabase(config: { root: string }) {
  const fs = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const { DatabaseSync } = await import("node:sqlite");
  const at = (name: string) => `${config.root}${name}`;
  const w: Witnesses = JSON.parse(await fs.readFile(at("/control/witnesses.json"), "utf8"));
  const fail = (): never => {
    throw Error("Forgejo database/files differ from private witnesses");
  };
  const file = at("/forgejo/data/forgejo.db");
  const expectedFile = w.forgejo.files.find((entry) => entry.path === "forgejo.sqlite3") ?? fail();
  const info = await fs.lstat(file);
  if (
    expectedFile.link !== undefined ||
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size !== expectedFile.bytes
  )
    fail();
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = await fs.lstat(`${file}${suffix}`).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (sidecar) fail();
  }
  const { createReadStream } = await import("node:fs");
  const fileHash = createHash("sha256");
  for await (const chunk of createReadStream(file)) fileHash.update(chunk);
  if (fileHash.digest("hex") !== expectedFile.sha256) fail();
  const handle = await fs.open(file, "r");
  try {
    const header = Buffer.alloc(100);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    // Reject a WAL-format main file even if its required WAL was omitted from the archive.
    if (
      bytesRead !== header.length ||
      header.subarray(0, 16).toString("ascii") !== "SQLite format 3\0" ||
      header[18] !== 1 ||
      header[19] !== 1
    )
      fail();
  } finally {
    await handle.close();
  }
  // Only the witnessed Online Backup snapshot is authoritative. Never run forgejo-db.sql,
  // open the archived live main.db, start Forgejo or reconstruct migration metadata.
  const db = new DatabaseSync(file, {
    readOnly: true,
    allowExtension: false,
  });
  try {
    if (
      db.prepare("PRAGMA journal_mode").get()?.["journal_mode"] !== "delete" ||
      db.prepare("PRAGMA integrity_check").get()?.["integrity_check"] !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").all().length
    )
      fail();
    const names = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((v) => String(v["name"]));
    if (JSON.stringify(names) !== JSON.stringify(Object.keys(w.forgejo.tables).sort())) fail();
    // SQLite witnesses hash sorted JSON row arrays in PRAGMA table_info column order, one LF per row.
    // Blob values use {"hex":"..."}; 64-bit integers use {"integer":"..."} to avoid precision loss.
    for (const name of names) {
      if (!/^[a-z_][a-z0-9_]*$/.test(name)) fail();
      const statement = db.prepare(`SELECT * FROM "${name}"`);
      statement.setReadBigInts(true);
      statement.setReturnArrays(true);
      const rows = statement
        .all()
        .map((row) =>
          JSON.stringify(row, (_key, value: unknown) =>
            typeof value === "bigint"
              ? { integer: String(value) }
              : value instanceof Uint8Array
                ? { hex: Buffer.from(value).toString("hex") }
                : value,
          ),
        )
        .sort();
      const hash = createHash("sha256");
      for (const row of rows) hash.update(`${row}\n`);
      const expected = w.forgejo.tables[name];
      if (!expected || expected.rows !== rows.length || expected.sha256 !== hash.digest("hex"))
        fail();
    }
  } finally {
    db.close();
  }
  const app = await fs.lstat(at("/forgejo-config/app.ini"));
  if (!app.isFile() || app.size === 0) fail();
  // The complete archive inventory/digests were checked before opening the snapshot read-only.
  // Require all operator-declared bare repositories, including repositories with no commits.
  for (const repo of w.forgejo.repositories) {
    if (!repo.startsWith("repos/")) fail();
    const root = at(`/forgejo/git/repositories/${repo.slice(6)}`);
    if (
      !(await fs.lstat(`${root}/HEAD`)).isFile() ||
      !(await fs.lstat(`${root}/objects`)).isDirectory()
    )
      fail();
  }
}
