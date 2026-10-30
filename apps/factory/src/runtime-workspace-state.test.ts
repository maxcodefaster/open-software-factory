import { describe, expect, test } from "bun:test";
import type { RuntimeAttempt } from "./api-contracts";
import { retryableMainPreview, runtimeWorkspaceURL } from "./runtime-workspace-state";
import type { WorkspaceTab } from "./workspace-tabs";

const projectID = "project-1";
const ready: RuntimeAttempt = {
  id: "attempt-1",
  projectId: projectID,
  workspaceId: "workspace-1",
  workspaceKind: "personal",
  runtimeKind: "personal",
  state: "ready",
};
const ide: WorkspaceTab = {
  id: "ide:workspace-1",
  view: "ide",
  label: "IDE",
  attemptID: ready.id,
};
const preview: WorkspaceTab = {
  ...ide,
  id: "preview:workspace-1:web",
  view: "preview",
  appChannel: "web",
};

test("only settled current Main Previews may commission another Start", () => {
  const staging = { ...ready, runtimeKind: "staging" as const, currentStaging: true };
  expect(retryableMainPreview({ ...staging, state: "failed" }, projectID)).toBe(true);
  expect(retryableMainPreview({ ...staging, state: "stopped" }, projectID)).toBe(true);
  for (const state of ["starting", "create-intended", "stopping", "cleanup-failed", "ready"])
    expect(retryableMainPreview({ ...staging, state }, projectID)).toBe(false);
  expect(retryableMainPreview({ ...staging, state: "failed" }, "other-project")).toBe(false);
  expect(
    retryableMainPreview({ ...staging, currentStaging: false, state: "failed" }, projectID),
  ).toBe(false);
  expect(retryableMainPreview({ ...ready, state: "failed" }, projectID)).toBe(false);
  expect(retryableMainPreview(undefined, projectID)).toBe(false);
});

describe("runtime workspace frame identity", () => {
  test("App-only projection opens a member Preview without exposing another developer's IDE", () => {
    const apps = [
      { attemptID: ready.id, projectID, channel: "web", label: "Developer · Web", state: "ready" },
    ];
    expect(runtimeWorkspaceURL(preview, projectID, [], undefined, apps)).toBe(
      "/api/runtime-access?embed=1&path=%2Fruntime%2Fattempt-1%2Fpreview%2Fweb%2F",
    );
    expect(runtimeWorkspaceURL(ide, projectID, [], undefined, apps)).toBeUndefined();
    expect(runtimeWorkspaceURL(preview, "other-project", [], undefined, apps)).toBeUndefined();
    expect(
      runtimeWorkspaceURL({ ...preview, appChannel: "app-admin" }, projectID, [], undefined, apps),
    ).toBeUndefined();
    expect(runtimeWorkspaceURL(preview, projectID, [], undefined, [])).toBeUndefined();
  });
  test("declared staging Apps are listed before compute is ready without mounting an unusable frame", () => {
    const staged = { ...ready, runtimeKind: "staging" as const, workspaceId: undefined };
    const apps = [
      {
        attemptID: staged.id,
        projectID,
        channel: "app-forms",
        label: "Staging · Forms",
        state: "starting",
      },
    ];
    const tab = { ...preview, appChannel: "app-forms" };
    expect(
      runtimeWorkspaceURL(tab, projectID, [{ ...staged, state: "starting" }], undefined, apps),
    ).toBeUndefined();
    expect(runtimeWorkspaceURL(tab, projectID, [staged], undefined, apps)).toContain("app-forms");
    expect(runtimeWorkspaceURL(tab, projectID, [], undefined, apps)).toBeUndefined();
  });
  test("never falls back to a runtime IDE while declared development Previews remain scoped", () => {
    expect(runtimeWorkspaceURL(ide, projectID, [ready])).toBeUndefined();
    expect(runtimeWorkspaceURL(preview, projectID, [ready])).toBe(
      "/api/runtime-access?embed=1&path=%2Fruntime%2Fattempt-1%2Fpreview%2Fweb%2F",
    );
    expect(
      runtimeWorkspaceURL(ide, projectID, [{ ...ready, runtimeKind: "ticket" }]),
    ).toBeUndefined();
  });

  test("never substitutes another attempt or another Project", () => {
    expect(
      runtimeWorkspaceURL(preview, projectID, [{ ...ready, id: "replacement" }]),
    ).toBeUndefined();
    expect(runtimeWorkspaceURL(preview, "project-2", [ready])).toBeUndefined();
    expect(
      runtimeWorkspaceURL({ id: ide.id, view: "ide", label: "IDE" }, projectID, [ready]),
    ).toBeUndefined();
  });

  test("an active App can resume a paused Attempt while untouched background tabs never mount a frame", () => {
    const paused = { ...ready, state: "paused" };
    const url = runtimeWorkspaceURL(preview, projectID, [paused]);
    expect(url).toBeDefined();
    expect(runtimeWorkspaceURL(preview, projectID, [paused], undefined, [], false)).toBeUndefined();
    expect(runtimeWorkspaceURL(preview, projectID, [paused], url, [], false)).toBe(url);
    expect(runtimeWorkspaceURL(preview, projectID, [ready], undefined, [], false)).toBeUndefined();
    expect(
      runtimeWorkspaceURL(preview, projectID, [{ ...paused, state: "failed" }]),
    ).toBeUndefined();
  });

  test("retains only an already-attached exact frame during Connector reconnection", () => {
    const attached = runtimeWorkspaceURL(preview, projectID, [ready]);
    expect(attached).toBeDefined();
    const reconnecting = { ...ready, state: "starting", failure: "child connector reconnecting" };
    expect(runtimeWorkspaceURL(preview, projectID, [reconnecting], attached)).toBe(attached);
    expect(runtimeWorkspaceURL(preview, projectID, [reconnecting])).toBeUndefined();
    expect(
      runtimeWorkspaceURL(preview, projectID, [{ ...ready, state: "starting" }], attached),
    ).toBeUndefined();
    expect(runtimeWorkspaceURL(preview, "other-project", [reconnecting], attached)).toBeUndefined();
    expect(
      runtimeWorkspaceURL(preview, projectID, [{ ...reconnecting, id: "replacement" }], attached),
    ).toBeUndefined();
    expect(
      runtimeWorkspaceURL(preview, projectID, [{ ...reconnecting, state: "stopping" }], attached),
    ).toBeUndefined();
    const staging = { ...ready, runtimeKind: "staging" as const };
    const tab = { ...ide, view: "preview" as const, id: "preview:staging" };
    const stagingURL = runtimeWorkspaceURL(tab, projectID, [staging]);
    expect(
      runtimeWorkspaceURL(
        tab,
        projectID,
        [{ ...staging, state: "starting", failure: "parent connector reconnecting" }],
        stagingURL,
      ),
    ).toBe(stagingURL);
  });

  test.each(["pending", "starting", "failed", "stopped", "cancelled"])(
    "does not mount a %s runtime",
    (state) =>
      expect(runtimeWorkspaceURL(preview, projectID, [{ ...ready, state }])).toBeUndefined(),
  );

  test("does not expose IDE or development Preview for Staging or Verification", () => {
    for (const runtimeKind of ["staging", "verification"] as const) {
      const attempt = { ...ready, runtimeKind };
      expect(runtimeWorkspaceURL(ide, projectID, [attempt])).toBeUndefined();
      expect(runtimeWorkspaceURL(preview, projectID, [attempt])).toBeUndefined();
    }
    expect(
      runtimeWorkspaceURL(preview, projectID, [{ ...ready, workspaceId: undefined }]),
    ).toBeUndefined();
  });

  test("resolves Staging only through its App route", () => {
    const stagingTab: WorkspaceTab = {
      id: "preview:staging",
      view: "preview",
      label: "Staging",
      attemptID: ready.id,
    };
    expect(runtimeWorkspaceURL(stagingTab, projectID, [ready])).toBeUndefined();
    expect(runtimeWorkspaceURL(stagingTab, projectID, [{ ...ready, runtimeKind: "staging" }])).toBe(
      "/api/runtime-access?embed=1&path=%2Fruntime%2Fattempt-1%2Fapp%2F",
    );
    expect(runtimeWorkspaceURL({ ...ide, view: "ticket" }, projectID, [ready])).toBeUndefined();
  });
});
