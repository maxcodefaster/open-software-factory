import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateRetainedEvents } from "../../../../deploy/opencode-server/retained-events.mjs";

function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "factory-retained-events-"));
  const path = join(directory, "opencode.db");
  const db = new Database(path);
  db.exec(
    "PRAGMA journal_mode = WAL; CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT, seq INTEGER, created INTEGER, type TEXT, data TEXT); CREATE TABLE inbox (id TEXT PRIMARY KEY, payload TEXT)",
  );
  const started = {
    sessionID: "ses_owned",
    assistantMessageID: "msg_owned",
    model: { id: "owned", providerID: "factory" },
    agent: "build",
  };
  db.query("INSERT INTO event VALUES (?, ?, ?, ?, ?, ?)").run(
    "evt_owned",
    "ses_owned",
    1,
    123,
    "session.step.started.1",
    JSON.stringify(started),
  );
  db.query("INSERT INTO event VALUES (?, ?, ?, ?, ?, ?)").run(
    "evt_ended",
    "ses_owned",
    2,
    456,
    "session.step.ended.1",
    '{"tokens":{"input":100,"output":20},"cost":0.5}',
  );
  db.query("INSERT INTO inbox VALUES (?, ?)").run("msg_queued", '{"text":"Retained input"}');
  try {
    run({ db, path, directory, started });
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("retained event migration preserves WAL history, consumption and queued identity, and retries once", () =>
  fixture(({ db, path, directory, started }) => {
    const before = db.query("SELECT * FROM event ORDER BY seq").all();
    const queued = db.query("SELECT * FROM inbox").all();
    const result = migrateRetainedEvents(path);
    expect(result.migrated).toBe(1);
    const backup = new Database(result.backup, { readonly: true });
    try {
      expect(backup.query("SELECT * FROM event ORDER BY seq").all()).toEqual(before);
      expect(backup.query("SELECT * FROM inbox").all()).toEqual(queued);
    } finally {
      backup.close();
    }
    const after = db.query("SELECT * FROM event ORDER BY seq").all();
    expect(after[0]).toEqual({ ...before[0], data: JSON.stringify({ ...started, started: 123 }) });
    expect(after[1]).toEqual(before[1]);
    expect(db.query("SELECT * FROM inbox").all()).toEqual(queued);
    expect(migrateRetainedEvents(path)).toEqual({ migrated: 0 });
    expect(readdirSync(directory).filter((name) => name.includes("before-2.0.27"))).toHaveLength(1);
  }));

test("invalid retained events roll back all edits and leave the original database intact", () =>
  fixture(({ db, path, directory }) => {
    db.query("INSERT INTO event VALUES (?, ?, ?, ?, ?, ?)").run(
      "evt_invalid",
      "ses_other",
      3,
      789,
      "session.step.started.1",
      '{"sessionID":"wrong","assistantMessageID":"msg_other"}',
    );
    const before = db.query("SELECT * FROM event ORDER BY seq").all();
    expect(() => migrateRetainedEvents(path)).toThrow("migration refused");
    expect(db.query("SELECT * FROM event ORDER BY seq").all()).toEqual(before);
    expect(readdirSync(directory).some((name) => name.includes("before-2.0.27"))).toBe(false);
  }));

test("failure after backup publication rolls back, preserves the backup and permits a safe retry", () =>
  fixture(({ db, path, directory }) => {
    const before = db.query("SELECT * FROM event ORDER BY seq").all();
    db.exec(
      "CREATE TRIGGER owned_refuse BEFORE UPDATE ON event BEGIN SELECT RAISE(ABORT, 'owned refusal'); END",
    );
    expect(() => migrateRetainedEvents(path)).toThrow("owned refusal");
    expect(db.query("SELECT * FROM event ORDER BY seq").all()).toEqual(before);
    const name = readdirSync(directory).find((name) => name.includes("before-2.0.27"));
    const backup = new Database(join(directory, name), { readonly: true });
    try {
      expect(backup.query("SELECT * FROM event ORDER BY seq").all()).toEqual(before);
    } finally {
      backup.close();
    }
    db.exec("DROP TRIGGER owned_refuse");
    expect(migrateRetainedEvents(path).migrated).toBe(1);
    expect(migrateRetainedEvents(path)).toEqual({ migrated: 0 });
  }));
