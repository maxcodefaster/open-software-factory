import { expect, test } from "bun:test";
import URI from "../../deploy/theia-ide/node_modules/@theia/core/lib/common/uri";
import { activityNavigationMessage } from "../../deploy/theia-ide/factory-ide-extension/lib/browser/factory-activity-message";
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
