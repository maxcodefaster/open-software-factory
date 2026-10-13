import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

// Run only before the native server starts. 2.0.3 persisted v1 step starts without
// the dispatch timestamp now required by 2.0.27. Event emission is the historical
// boundary we actually retained; it cannot recover provider wait time. Factory
// consumption uses the unchanged step-ended counters, never this timing field.
export function migrateRetainedEvents(path) {
  if (!path || !existsSync(path)) return { migrated: 0 };
  const db = new Database(path, { readwrite: true, strict: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
    const table = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event'")
      .get();
    if (!table) {
      if (
        db
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .get()
      )
        throw new Error("Unrecognized retained OpenCode database; migration refused");
      db.exec("COMMIT");
      return { migrated: 0 };
    }
    const rows = db
      .query(
        "SELECT id, aggregate_id, created, data FROM event WHERE type = 'session.step.started.1'",
      )
      .all();
    const changes = [];
    for (const row of rows) {
      const data = JSON.parse(row.data);
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error("Invalid retained OpenCode step event; migration refused");
      if (Object.hasOwn(data, "started")) {
        if (!Number.isSafeInteger(data.started) || data.started < 0)
          throw new Error("Invalid retained OpenCode dispatch timestamp; migration refused");
        continue;
      }
      if (
        !Number.isSafeInteger(row.created) ||
        row.created < 0 ||
        data.sessionID !== row.aggregate_id ||
        typeof data.assistantMessageID !== "string"
      )
        throw new Error("Invalid historical OpenCode step boundary; migration refused");
      changes.push({ id: row.id, data: JSON.stringify({ ...data, started: row.created }) });
    }
    if (!changes.length) {
      db.exec("COMMIT");
      return { migrated: 0 };
    }
    // serialize includes committed WAL pages. Publish a complete, immutable
    // snapshot before any edits. A content-addressed name also recovers a crash
    // between backup publication and transaction commit without overwriting it.
    const snapshot = db.serialize();
    // A serialized snapshot has every page but no WAL sidecar. SQLite requires
    // rollback-journal header bytes for a standalone serialized WAL database.
    snapshot[18] = 1;
    snapshot[19] = 1;
    const hash = createHash("sha256").update(snapshot).digest("hex");
    const backup = `${path}.before-2.0.27-${hash}.sqlite`;
    const temporary = `${backup}.${crypto.randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, snapshot);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, backup);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const retained = new Database(backup, { readonly: true });
      try {
        if (createHash("sha256").update(retained.serialize()).digest("hex") !== hash)
          throw new Error("Retained OpenCode backup mismatch; migration refused");
      } finally {
        retained.close();
      }
    } finally {
      unlinkSync(temporary);
    }
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    const update = db.query("UPDATE event SET data = ? WHERE id = ?");
    for (const change of changes) update.run(change.data, change.id);
    db.exec("COMMIT");
    return { migrated: changes.length, backup };
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}
