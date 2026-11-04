import { expect, test } from "bun:test";
import { knownModelRejection } from "../models/execution-policy";
import { rateLimitRefusal, retryRateLimited } from "./provider-retry";

const refusal = (headers: Record<string, string> = {}, statusCode = 429) =>
  Object.assign(new Error("Provider refused"), { statusCode, responseHeaders: headers });

function fakeModel(failures: unknown[]) {
  const calls: unknown[] = [];
  const model = {
    specificationVersion: "v3",
    modelId: "fake",
    get provider() {
      return "fake-provider";
    },
    async doGenerate(options: unknown) {
      calls.push(options);
      const failure = failures.shift();
      if (failure) throw failure;
      return { text: "ok" };
    },
    async doStream(options: unknown) {
      return model.doGenerate(options);
    },
  };
  return { model, calls };
}

test("Retry-After in seconds, milliseconds or an HTTP date names the wait; anything else does not", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");
  expect(rateLimitRefusal(refusal({ "Retry-After": "7" }), now)).toEqual({ waitMs: 7000 });
  expect(rateLimitRefusal(refusal({ "retry-after-ms": "250" }), now)).toEqual({ waitMs: 250 });
  expect(
    rateLimitRefusal(refusal({ "retry-after": "Wed, 04 Nov 2026 12:00:03 GMT" }), now),
  ).toEqual({ waitMs: 3000 });
  expect(rateLimitRefusal(refusal(), now)).toEqual({ waitMs: undefined });
  expect(rateLimitRefusal({ cause: refusal({ "retry-after": "1" }) }, now)).toEqual({
    waitMs: 1000,
  });
  // A 5xx may have consumed inference; it is never a definite refusal to repeat.
  expect(rateLimitRefusal(refusal({ "retry-after": "1" }, 503), now)).toBeUndefined();
  expect(rateLimitRefusal(new Error("socket closed"), now)).toBeUndefined();
});

test("a refused call repeats the same request, keeps the model's own members and spends the budget", async () => {
  const { model, calls } = fakeModel([refusal({ "retry-after-ms": "1" })]);
  const requests = { remaining: 3 };
  const wrapped = retryRateLimited(model, {
    signal: new AbortController().signal,
    state: { until: 0 },
    requests,
  });
  const options = { prompt: "same step" };
  expect(await wrapped.doGenerate(options)).toEqual({ text: "ok" });
  expect(calls).toEqual([options, options]);
  expect(requests.remaining).toBe(2);
  expect(wrapped.modelId).toBe("fake");
  expect(wrapped.provider).toBe("fake-provider");
});

test("a 429 is retried a bounded number of times and then surfaces as a known rejection", async () => {
  const { model, calls } = fakeModel(
    Array.from({ length: 10 }, () => refusal({ "retry-after": "0" })),
  );
  const requests = { remaining: 20 };
  const failure = await retryRateLimited(model, {
    signal: new AbortController().signal,
    state: { until: 0 },
    requests,
    retries: 2,
  })
    .doGenerate({})
    .catch((cause: unknown) => cause);
  expect(calls).toHaveLength(3);
  expect(requests.remaining).toBe(18);
  expect(knownModelRejection(failure)).toBe(true);
});

test("other provider errors, a 429 without a stated wait, long waits and an exhausted budget are not retried", async () => {
  for (const [failure, options] of [
    [refusal({}, 503), {}],
    [refusal({}), {}],
    [new Error("socket closed"), {}],
    [refusal({ "retry-after": "600" }), {}],
    [refusal({ "retry-after": "0" }), { requests: { remaining: 0 } }],
  ] as const) {
    const { model, calls } = fakeModel([failure]);
    const wrapped = retryRateLimited(model, {
      signal: new AbortController().signal,
      state: { until: 0 },
      ...options,
    });
    await expect(wrapped.doGenerate({})).rejects.toBe(failure);
    expect(calls).toHaveLength(1);
  }
});

test("the wait stops on abort and re-checks authority before the repeat", async () => {
  const controller = new AbortController();
  const { model, calls } = fakeModel([refusal({ "retry-after": "30" })]);
  const waiting = retryRateLimited(model, {
    signal: controller.signal,
    state: { until: 0 },
    maximumWaitMs: 60_000,
  }).doGenerate({});
  setTimeout(() => controller.abort(new Error("Stopped")), 10);
  await expect(waiting).rejects.toThrow("Stopped");
  expect(calls).toHaveLength(1);

  const denied = fakeModel([refusal({ "retry-after": "0" })]);
  await expect(
    retryRateLimited(denied.model, {
      signal: new AbortController().signal,
      state: { until: 0 },
      authorize: async () => {
        throw new Error("Authority changed");
      },
    }).doGenerate({}),
  ).rejects.toThrow("Authority changed");
  expect(denied.calls).toHaveLength(1);
});

test("one refusal pauses every concurrent step of the generation", async () => {
  const state = { until: 0 };
  const first = fakeModel([refusal({ "retry-after-ms": "60" })]);
  const second = fakeModel([]);
  const signal = new AbortController().signal;
  const one = retryRateLimited(first.model, { signal, state });
  const two = retryRateLimited(second.model, { signal, state });
  const started = Date.now();
  const pending = one.doGenerate({});
  await Bun.sleep(10);
  await two.doGenerate({});
  await pending;
  expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  expect(second.calls).toHaveLength(1);
});

test("every pause, from a refusal or a shared wait, is reported", async () => {
  const { model } = fakeModel([refusal({ "retry-after-ms": "30" })]);
  const waits: number[] = [];
  const wrapped = retryRateLimited(model, {
    signal: new AbortController().signal,
    state: { until: 0 },
    onWait: (milliseconds) => waits.push(milliseconds),
  });
  await wrapped.doGenerate({});
  expect(waits).toHaveLength(1);
  expect(waits[0]).toBeGreaterThanOrEqual(25);
  // Another agent's pause is waited out before the call and counts as waiting too.
  const shared = retryRateLimited(fakeModel([]).model, {
    signal: new AbortController().signal,
    state: { until: Date.now() + 40 },
    onWait: (milliseconds) => waits.push(milliseconds),
  });
  await shared.doGenerate({});
  expect(waits).toHaveLength(2);
  expect(waits[1]).toBeGreaterThanOrEqual(30);
});
