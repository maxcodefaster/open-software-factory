import { describe, expect, test } from "bun:test";
import { readNativePhases, summarizeNativePhases } from "./benchmark-phases";

const event = {
  schema: 1 as const,
  pid: 123,
  phase: "filesystem.syncfs_native_root",
  started_at: "2026-11-08T10:20:30.123456789Z",
  elapsed_ms: 25,
  failed: false,
};
const line = (value: unknown) => `factorybox-phase ${JSON.stringify(value)}`;

describe("native phase attribution", () => {
  test("only bounded valid structured diagnostics are accepted", () => {
    const invalid = [
      "private stderr",
      "factorybox-phase not-json",
      line({ ...event, elapsed_ms: -1 }),
      line({ ...event, phase: "/private/path" }),
      line({ ...event, started_at: "not-a-date" }),
      line({ ...event, secret: "private" }),
      `factorybox-phase ${"x".repeat(512)}`,
    ];
    expect(readNativePhases([...invalid, line(event)].join("\n"))).toEqual([event]);
  });

  test("repeated phases retain counts and failures without adding inclusive parents", () => {
    const parent = { ...event, phase: "pause.total", elapsed_ms: 1000 };
    expect(
      summarizeNativePhases([
        [line(event), line(parent)].join("\n"),
        line({ ...event, elapsed_ms: 75, failed: true }),
      ]),
    ).toEqual([
      { phase: event.phase, count: 2, failed: 1, totalMS: 100, maxMS: 75, meanMS: 50 },
      { phase: "pause.total", count: 1, failed: 0, totalMS: 1000, maxMS: 1000, meanMS: 1000 },
    ]);
  });
});
