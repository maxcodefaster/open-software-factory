import { expect, test } from "bun:test";
import URI from "../../deploy/theia-ide/node_modules/@theia/core/lib/common/uri";
import { activityNavigationMessage } from "../../deploy/theia-ide/factory-ide-extension/lib/browser/factory-activity-message";
import { AgentFollowGate } from "../../deploy/theia-ide/factory-ide-extension/lib/browser/factory-agent-follow";
import { workspaceResource } from "../../deploy/theia-ide/factory-ide-extension/lib/browser/factory-workspace-files";

test("IDE navigation accepts scoped relative source and bounded read-only diff snapshots", () => {
  const message = {
    type: "factory:open-activity",
    id: crypto.randomUUID(),
    workspaceID: crypto.randomUUID(),
    path: "src/app #1.ts",
    kind: "file",
  } as const;
  expect(activityNavigationMessage(message)).toEqual(message);
  const resource = new URI(`factory-workspace://${message.workspaceID}/`).resolve(message.path);
  expect(workspaceResource(resource)).toEqual({
    workspaceID: message.workspaceID,
    path: message.path,
  });
  expect(
    activityNavigationMessage({ ...message, kind: "diff", diff: "-before\n+after" }),
  ).toBeDefined();
  for (const value of [
    { ...message, workspaceID: "other/../scope" },
    { ...message, path: "../other.ts" },
    { ...message, path: "/etc/passwd" },
    { ...message, path: ".git/config" },
    { ...message, path: "src//app.ts" },
    { ...message, path: "file:///etc/passwd" },
    { ...message, kind: "execute" },
    { ...message, kind: "diff" },
    { ...message, kind: "diff", diff: "+".repeat(64_001) },
  ])
    expect(activityNavigationMessage(value)).toBeUndefined();
});

test("IDE navigation accepts a follow target with a line and rejects a bad line", () => {
  const message = {
    type: "factory:open-activity",
    id: crypto.randomUUID(),
    workspaceID: crypto.randomUUID(),
    path: "src/app.ts",
    kind: "follow",
    line: 12,
  } as const;
  expect(activityNavigationMessage(message)).toEqual(message);
  expect(activityNavigationMessage({ ...message, line: undefined })).toBeDefined();
  for (const line of [0, -1, 1.5, 10_000_001, "3"])
    expect(activityNavigationMessage({ ...message, line })).toBeUndefined();
});

test("following waits for a quiet editor, keeps only the newest target and obeys the switch", () => {
  let clock = 1_000;
  const gate = new AgentFollowGate<string>(() => clock, 4_000);
  gate.offer("first");
  expect(gate.take()).toBe("first");
  gate.interact();
  gate.offer("second");
  gate.offer("third");
  clock += 3_999;
  expect(gate.take()).toBeUndefined();
  clock += 1;
  expect(gate.take()).toBe("third");
  expect(gate.take()).toBeUndefined();
  gate.setFollowing(false);
  gate.offer("ignored");
  clock += 10_000;
  expect(gate.take()).toBeUndefined();
  expect(gate.waiting).toBe(false);
  gate.setFollowing(true);
  gate.offer("again");
  expect(gate.take()).toBe("again");
});
