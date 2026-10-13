import { expect, test } from "bun:test";
import URI from "../../deploy/theia-ide/node_modules/@theia/core/lib/common/uri";
import {
  requestedWorkspace,
  selectedWorkspaceLocation,
} from "../../deploy/theia-ide/factory-ide-extension/lib/browser/factory-workspace-location";

test("Workspace switching restores the selected identity instead of the original query", () => {
  const selected = selectedWorkspaceLocation(
    "https://factory.example/ide/?workspace=workspace-a",
    new URI("factory-workspace://workspace-b/"),
  );
  expect(requestedWorkspace(selected)).toBe("workspace-b");
  expect(new URL(selected).searchParams.get("workspace")).toBe("workspace-b");
  expect(new URL(selected).pathname).toBe("/ide/");
  expect(
    requestedWorkspace(
      "https://factory.example/ide/?workspace=workspace-a#factory-workspace://workspace-b/",
    ),
  ).toBe("workspace-b");
  expect(() =>
    selectedWorkspaceLocation(selected, new URI("factory-workspace://workspace-a/app.ts")),
  ).toThrow();
});
