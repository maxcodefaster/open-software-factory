import { expect, test } from "bun:test";
import { appResponseNotice, previewStatus } from "./preview-status";

const app = { label: "App", port: 3000, state: "ready" };

test("starting compute is named before the App is awaited", () => {
  const status = previewStatus({
    attempt: { state: "starting" },
    app,
    waited: 5_000,
    phase: "loading",
  });
  expect(status.headline).toContain("Starting compute");
});

test("a running compute names the App and its port, then admits it has not answered", () => {
  const waiting = previewStatus({
    attempt: { state: "ready" },
    app,
    waited: 5_000,
    phase: "loading",
  });
  expect(waiting.headline).toBe("Waiting for the App on port 3000…");
  const slow = previewStatus({
    attempt: { state: "ready" },
    app,
    waited: 31_000,
    phase: "loading",
  });
  expect(slow.headline).toBe("The App on port 3000 has not answered yet. You can keep waiting.");
  expect(slow.detail).toContain("keeps waiting");
});

test("without a known App the generic opening and slow texts remain", () => {
  expect(previewStatus({ waited: 0, phase: "loading" }).headline).toBe("Opening Preview…");
  expect(previewStatus({ waited: 31_000, phase: "loading" }).headline).toBe(
    "Preview is taking longer to open. You can keep waiting.",
  );
});

test("capacity waits keep their own explanation", () => {
  expect(
    previewStatus({
      attempt: { state: "create-intended", computeWait: "capacity" },
      waited: 0,
      phase: "loading",
    }).headline,
  ).toContain("execution capacity");
});

test.each([
  [{ state: "failed", exitCode: 1 }, "exited with code 1"],
  [{ state: "stopped" }, "not running"],
])("an exited App process is the recorded cause %j", (process, cause) => {
  const status = previewStatus({
    attempt: { state: "ready" },
    app: { ...app, process },
    waited: 1_000,
    phase: "failed",
  });
  expect(status.cause).toContain(cause);
});

test("a recorded runtime failure wins over a generic transport cause", () => {
  const status = previewStatus({
    attempt: { state: "failed", failure: "Health check timed out after 120 s" },
    app,
    waited: 1_000,
    phase: "failed",
    unreachable: true,
  });
  expect(status.cause).toBe("Health check timed out after 120 s");
});

test("an unreachable App and a refused request are told apart", () => {
  const unreachable = previewStatus({
    attempt: { state: "ready" },
    app,
    waited: 60_000,
    phase: "failed",
    unreachable: true,
  });
  expect(unreachable.cause).toContain("port 3000");
  expect(unreachable.cause).toContain("health check");
  const refused = previewStatus({ attempt: { state: "ready" }, app, waited: 0, phase: "failed" });
  expect(refused.cause).toContain("refused");
  expect(refused.detail).toContain("Reload view");
});

test("an App-served 5xx page is described as the App's answer, never a Factory failure", () => {
  expect(appResponseNotice(503, app)).toContain("App's own response");
  expect(appResponseNotice(503, app)).toContain("HTTP 503");
  expect(appResponseNotice(200, app)).toBeUndefined();
  expect(appResponseNotice(undefined, app)).toBeUndefined();
});
