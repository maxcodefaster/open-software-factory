import { expect, test } from "bun:test";
import {
  slice20StartupTargetFailures,
  startupMeasurements,
  type StartupMeasurement,
} from "./runtime-startup";

test("Slice 20 targets reject real slow desktop measurements rather than accepting readiness", () => {
  expect(
    slice20StartupTargetFailures({
      loadedSourceMS: 72_385,
      executableTerminalMS: 105_253,
      restartedTerminalMS: 52_505,
    }),
  ).toEqual([
    "loaded source: 72385 ms exceeds 8500 ms",
    "executable Terminal: 105253 ms exceeds 21500 ms",
    "stopped executable Terminal: 52505 ms exceeds 18500 ms",
  ]);
  expect(
    slice20StartupTargetFailures({
      loadedSourceMS: 8500,
      executableTerminalMS: 21_500,
      restartedTerminalMS: 18_500,
    }),
  ).toEqual([]);
  expect(
    slice20StartupTargetFailures({ executableTerminalMS: 21_501, restartedTerminalMS: 18_501 }),
  ).toHaveLength(2);
});

test("invalid clocks cannot pass a startup target", () => {
  for (const invalid of [NaN, Infinity, -1])
    expect(
      slice20StartupTargetFailures({
        loadedSourceMS: invalid,
        executableTerminalMS: invalid,
        restartedTerminalMS: invalid,
      }),
    ).toEqual([
      "loaded source: invalid measurement",
      "executable Terminal: invalid measurement",
      "stopped executable Terminal: invalid measurement",
    ]);
});

test("extracts bounded startup clocks without retaining runtime output", () => {
  const record: StartupMeasurement = {
    phase: "browser-image",
    startedAt: "2026-10-09T12:00:00.123Z",
    durationMs: 120_000,
  };
  const raw = JSON.stringify({
    output: `\u0002\u0000factory-startup ${JSON.stringify(record)}\nsecret-do-not-record\n`,
  });
  expect(startupMeasurements(`${raw}\n${raw}\nApp log`)).toEqual([record]);
  expect(
    startupMeasurements(
      `factory-startup ${JSON.stringify({ ...record, secret: "must-not-persist" })}`,
    ),
  ).toEqual([]);
  expect(
    startupMeasurements(`factory-startup ${JSON.stringify({ ...record, durationMs: -1 })}`),
  ).toEqual([]);
});

test("decodes adjacent Docker-framed records in one Envbox output envelope", () => {
  const first: StartupMeasurement = {
    phase: "devcontainer-start",
    startedAt: "2026-10-09T12:00:00Z",
    durationMs: 500,
  };
  const second: StartupMeasurement = { ...first, phase: "tool-injection", durationMs: 750 };
  const raw = JSON.stringify({
    output: `\u0002\u0000factory-startup ${JSON.stringify(first)}\u0002\u0000factory-startup ${JSON.stringify(second)}`,
  });
  expect(startupMeasurements(raw)).toEqual([first, second]);
});
