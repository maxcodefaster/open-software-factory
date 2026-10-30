import { describe, expect, test } from "bun:test";
import {
  closeWorkspaceTabState,
  followStagingPromotion,
  openWorkspaceTabState,
  selectedWorkspaceTab,
  type WorkspaceTab,
  workspaceTabRuntimeURL,
} from "./workspace-tabs";

const ticket: WorkspaceTab = { id: "ticket:1", view: "ticket", label: "Ticket" };
const ide: WorkspaceTab = { id: "ide:1", view: "ide", label: "IDE" };
const preview: WorkspaceTab = { id: "preview:1", view: "preview", label: "Preview" };

describe("workspace tabs", () => {
  test("every declared Staging App follows a ready promotion without retargeting development", () => {
    const website = {
      ...preview,
      id: "preview:staging:project:app",
      appChannel: "app",
      attemptID: "old",
    };
    const forms = {
      ...preview,
      id: "preview:staging:project:app-forms",
      appChannel: "app-forms",
      attemptID: "old",
    };
    const development = {
      ...preview,
      id: "preview:app:dev:app-forms",
      appChannel: "app-forms",
      attemptID: "dev",
    };
    const state = { tabs: [website, forms, development], activeTabID: forms.id };
    expect(followStagingPromotion(state, "project", "new")).toEqual({
      tabs: [{ ...website, attemptID: "new" }, { ...forms, attemptID: "new" }, development],
      activeTabID: forms.id,
    });
  });
  test("only the existing Project Staging tab follows a confirmed ready promotion", () => {
    const staging = { ...preview, id: "preview:staging:project", attemptID: "old" };
    const development = {
      ...preview,
      id: "preview:development",
      appChannel: "app",
      attemptID: "ticket-runtime",
    };
    const state = { tabs: [ticket, ide, staging, development], activeTabID: ticket.id };
    expect(followStagingPromotion(state, "project", undefined)).toBe(state);
    expect(followStagingPromotion(state, "other-project", "new")).toBe(state);
    const next = followStagingPromotion(state, "project", "new");
    expect(next).toEqual({
      tabs: [ticket, ide, { ...staging, attemptID: "new" }, development],
      activeTabID: ticket.id,
    });
    expect(followStagingPromotion(next, "project", "new")).toBe(next);
    expect(followStagingPromotion({ tabs: [ticket, ide] }, "project", "new").tabs).toEqual([
      ticket,
      ide,
    ]);
  });
  test("opens a tab once and activates its latest value", () => {
    const opened = openWorkspaceTabState({ tabs: [ticket] }, { ...ticket, label: "Renamed" });

    expect(opened.tabs).toEqual([{ ...ticket, label: "Renamed" }]);
    expect(selectedWorkspaceTab(opened)?.label).toBe("Renamed");
  });

  test("selects the neighboring tab when the active tab closes", () => {
    const closed = closeWorkspaceTabState(
      { tabs: [ticket, ide, preview], activeTabID: ide.id },
      ide.id,
    );

    expect(closed.state).toEqual({ tabs: [ticket, preview], activeTabID: preview.id });
    expect(closed.next).toEqual(preview);
  });

  test("replaces compute without duplicating the logical workspace tab", () => {
    const first = { ...ide, id: "ide:personal:project", attemptID: "attempt-old" };
    const second = { ...first, attemptID: "attempt-new" };
    const opened = openWorkspaceTabState({ tabs: [ticket, first], activeTabID: ticket.id }, second);
    expect(opened.tabs).toEqual([ticket, second]);
    expect(selectedWorkspaceTab(opened)?.attemptID).toBe("attempt-new");
  });

  test("keeps the active tab when a background tab closes", () => {
    const closed = closeWorkspaceTabState({ tabs: [ticket, ide], activeTabID: ide.id }, ticket.id);

    expect(closed.state).toEqual({ tabs: [ide], activeTabID: ide.id });
    expect(closed.next).toEqual(ide);
  });

  test("exposes external runtime URLs only for resolved IDE and Preview tabs", () => {
    expect(workspaceTabRuntimeURL({ ...ide, workspaceID: "workspace-1" })).toBe(
      "/api/developer-ide/access?workspace=workspace-1",
    );
    expect(
      workspaceTabRuntimeURL({ ...ide, workspaceID: "workspace-1", attemptID: "old" }, true),
    ).toBe("/api/developer-ide/access?embed=1&workspace=workspace-1");
    expect(workspaceTabRuntimeURL({ ...ide, attemptID: "attempt-1" })).toBeUndefined();
    expect(workspaceTabRuntimeURL({ ...ide, attemptID: "attempt-1" }, true)).toBeUndefined();
    expect(workspaceTabRuntimeURL({ ...preview, attemptID: "attempt-2" })).toBe(
      "/api/runtime-access?path=%2Fruntime%2Fattempt-2%2Fapp%2F",
    );
    expect(
      workspaceTabRuntimeURL({
        ...preview,
        attemptID: "attempt-2",
        appChannel: "web",
      }),
    ).toBe("/api/runtime-access?path=%2Fruntime%2Fattempt-2%2Fpreview%2Fweb%2F");
    expect(workspaceTabRuntimeURL(ide)).toBeUndefined();
    expect(workspaceTabRuntimeURL(ticket)).toBeUndefined();
  });
});
