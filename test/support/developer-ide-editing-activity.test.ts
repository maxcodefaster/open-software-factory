import { expect, test } from "bun:test";
import { FactoryEditingActivity } from "../../deploy/theia-ide/factory-ide-extension/lib/browser/factory-editing-activity";

test("input stays with its original Workspace and heartbeats never replace queued editing", async () => {
  const sent: unknown[] = [];
  const reporter = new FactoryEditingActivity(async (...args) => {
    sent.push(args.slice(0, 3));
    return true;
  });
  reporter.confirm("buffer-a", 3);
  reporter.confirm("explorer-b", 7);
  reporter.queue("buffer-a", "edit");
  reporter.queue("buffer-a", "heartbeat");
  reporter.queue("explorer-b", "heartbeat");
  await reporter.flush("buffer-a");
  await reporter.flush("explorer-b");
  expect(sent).toEqual([
    ["buffer-a", 3, "edit"],
    ["explorer-b", 7, "heartbeat"],
  ]);
  reporter.close();
});

test("authority changes discard pending signals and old responses cannot erase a newer epoch", async () => {
  const release = Promise.withResolvers<boolean>();
  const sent: unknown[] = [];
  let firstSignal: AbortSignal | undefined;
  const reporter = new FactoryEditingActivity(async (workspace, epoch, kind, signal) => {
    sent.push([workspace, epoch, kind]);
    if (epoch === 2) {
      firstSignal = signal;
      return release.promise;
    }
    return true;
  });
  reporter.confirm("a", 1);
  reporter.queue("a", "edit");
  reporter.confirm("a", 2);
  await reporter.flush("a");
  expect(sent).toHaveLength(0);
  reporter.queue("a", "edit");
  const pending = reporter.flush("a");
  reporter.confirm("a", 3);
  expect(firstSignal?.aborted).toBe(true);
  reporter.queue("a", "heartbeat");
  release.resolve(false);
  await pending;
  await reporter.flush("a");
  expect(sent).toEqual([
    ["a", 2, "edit"],
    ["a", 3, "heartbeat"],
  ]);
  reporter.queue("a", "edit");
  reporter.close();
  await reporter.flush("a");
  expect(sent).toHaveLength(2);
});
