import { expect, test } from "bun:test";
import { scheduleWarmup, type WarmupEnvironment } from "./workspace-warmup";

function fakeEnvironment(constrained = false) {
  const waiting = new Map<string, () => void>();
  const hook = (name: string) => (run: () => void) => {
    waiting.set(name, run);
    return () => {
      if (waiting.get(name) === run) waiting.delete(name);
    };
  };
  const environment: WarmupEnvironment = {
    constrained: () => constrained,
    afterLoad: hook("load"),
    whenIdle: hook("idle"),
  };
  const fire = (name: string) => {
    const run = waiting.get(name);
    waiting.delete(name);
    run?.();
  };
  return { environment, fire, waiting };
}

function schedule(environment: WarmupEnvironment) {
  const calls: string[] = [];
  const stop = scheduleWarmup({
    prefetch: () => calls.push("prefetch"),
    warm: () => calls.push("warm"),
    environment,
  });
  return { calls, stop };
}

test("an eligible desktop prepares the editor at the first idle turn without another delay", () => {
  const fake = fakeEnvironment();
  const { calls } = schedule(fake.environment);
  expect(calls).toEqual([]);
  fake.fire("load");
  expect(calls).toEqual([]);
  fake.fire("idle");
  expect(calls).toEqual(["prefetch", "warm"]);
  fake.fire("idle");
  expect(calls).toEqual(["prefetch", "warm"]);
  expect(fake.waiting.size).toBe(0);
});

test("a constrained viewport prefetches chunks but never warms the editor", () => {
  const fake = fakeEnvironment(true);
  const { calls } = schedule(fake.environment);
  fake.fire("load");
  fake.fire("idle");
  expect(calls).toEqual(["prefetch"]);
  expect(fake.waiting.size).toBe(0);
});

test("a viewport that becomes constrained while waiting does not warm", () => {
  let constrained = false;
  const fake = fakeEnvironment();
  const environment = { ...fake.environment, constrained: () => constrained };
  const { calls } = schedule(environment);
  fake.fire("load");
  constrained = true;
  fake.fire("idle");
  expect(calls).toEqual(["prefetch"]);
});

test("stopping cancels every pending step", () => {
  const fake = fakeEnvironment();
  const { calls, stop } = schedule(fake.environment);
  fake.fire("load");
  stop();
  fake.fire("idle");
  expect(calls).toEqual([]);
  expect(fake.waiting.size).toBe(0);
});
