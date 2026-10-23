import { expect, test } from "bun:test";
import { WriterActivity, writerIdleMilliseconds } from "./writer-activity";

test("heartbeats indicate connection but never count as editing or extend the idle window", () => {
  let now = 0;
  const presence = new WriterActivity(() => now);
  expect(presence.snapshot("change", "anna", "1")).toEqual({
    idle: false,
    secondsSinceEdit: null,
    connected: false,
  });
  presence.observe("change", "anna", "1", "edit");
  now = writerIdleMilliseconds;
  presence.observe("change", "anna", "1", "heartbeat");
  expect(presence.snapshot("change", "anna", "1")).toEqual({
    idle: true,
    secondsSinceEdit: 300,
    connected: true,
  });
  presence.observe("change", "anna", "1", "edit");
  expect(presence.snapshot("change", "anna", "1").idle).toBe(false);
});

test("new writer epochs and server restart discard presence rather than inherit an idle grant", () => {
  let now = 0;
  const presence = new WriterActivity(() => now);
  presence.observe("change", "anna", "1", "edit");
  now = writerIdleMilliseconds + 1;
  expect(presence.snapshot("change", "anna", "1").idle).toBe(true);
  expect(presence.snapshot("change", "ben", "2")).toEqual({
    idle: false,
    secondsSinceEdit: null,
    connected: false,
  });
  expect(new WriterActivity(() => now).snapshot("change", "ben", "2").idle).toBe(false);
  presence.clear("change");
  expect(presence.snapshot("change", "ben", "2").idle).toBe(false);
});
