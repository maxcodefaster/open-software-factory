import { describe, expect, test } from "bun:test";
import type { MCPDefinition } from "#conversation-domain/mcp-library";
import type { MCPEntry } from "./library-shared";
import {
  activeMCPDraft,
  applyMCPConnectResult,
  beginMCPLoad,
  finishMCPLoad,
  finishMCPMutation,
  initialMCPActivity,
  initialMCPDetailInteraction,
  initialMCPDraftState,
  isMCPBusy,
  isMCPLoading,
  mcpAuthorizationUrl,
  mcpStatusText,
  openMCPDraft,
  patchMCPDraftContent,
  patchMCPDraftScope,
  resolvePendingMCPSave,
  syncMCPDetailAfterLoad,
  toggleMCPToolSelection,
} from "./library-state";

const definition: MCPDefinition = {
  name: "Sentry",
  description: "Read issues",
  endpoint: "https://mcp.sentry.dev/mcp",
  provider: "sentry",
  authentication: "oauth",
  roles: ["planning", "build"],
};

const baseEntry: MCPEntry = {
  id: "mcp-1",
  scope: "project",
  ownerId: null,
  projectId: "proj-1",
  cover: null,
  editable: true,
  revisions: [{ id: "rev-1", revision: 1, digest: "d1", content: definition }],
  connection: {
    id: "conn-1",
    revisionId: "rev-1",
    state: "authorizing",
    version: 1,
    tools: [],
    allowedTools: ["list_issues"],
    projectGrants: [],
    editable: true,
  },
};

describe("MCP library draft state machine", () => {
  test("reuses idempotent save identity for unchanged basis and regenerates on edit", () => {
    const opened = openMCPDraft(initialMCPDraftState(), {
      content: definition,
      monitoringSetup: true,
      projectId: "proj-1",
      projectName: "Demo",
    });
    expect(opened.kind).toBe("draft");
    if (opened.kind !== "draft") throw new Error("expected draft");

    const first = resolvePendingMCPSave(opened, definition);
    const repeat = resolvePendingMCPSave(first.nextState, definition);
    expect(repeat.submitted.input.libraryId).toBe(first.submitted.input.libraryId);
    expect(repeat.submitted.input.revisionId).toBe(first.submitted.input.revisionId);

    const edited = patchMCPDraftContent(first.nextState, { description: "Updated" });
    expect(activeMCPDraft(edited)?.content.description).toBe("Updated");
    if (edited.kind !== "draft") throw new Error("expected draft");
    const afterEdit = resolvePendingMCPSave(edited, edited.draft.content);
    expect(afterEdit.submitted.input.revisionId).not.toBe(first.submitted.input.revisionId);

    const rescoped = patchMCPDraftScope(edited, "system");
    expect(activeMCPDraft(rescoped)?.scope).toBe("system");
  });
});

describe("MCP library detail interaction and activity state machines", () => {
  test("manages OAuth authorization URL and resets tool confirmation on version change", () => {
    const initial = initialMCPDetailInteraction();
    const authorizing = applyMCPConnectResult(initial, "https://auth.example/start");
    expect(authorizing.kind).toBe("authorizing");
    expect(mcpAuthorizationUrl(authorizing)).toBe("https://auth.example/start");

    const selected = toggleMCPToolSelection(authorizing, "list_issues", true);
    expect(selected.allowed).toEqual(["list_issues"]);
    expect(selected.confirmed).toBe(false);

    const baseConnection = baseEntry.connection;
    if (!baseConnection) throw new Error("expected connection");
    const nextEntry: MCPEntry = {
      ...baseEntry,
      connection: {
        ...baseConnection,
        state: "review",
        version: 2,
        allowedTools: ["get_issue"],
      },
    };
    const synced = syncMCPDetailAfterLoad({ ...selected, confirmed: true }, baseEntry, nextEntry);
    expect(synced.kind).toBe("idle");
    expect(mcpAuthorizationUrl(synced)).toBeUndefined();
    expect(synced.confirmed).toBe(false);
    expect(synced.allowed).toEqual(["get_issue"]);
  });

  test("distinguishes quiet background loads from foreground loading and mutations", () => {
    const idle = initialMCPActivity();
    expect(beginMCPLoad(idle, true)).toBe(idle);

    const loading = beginMCPLoad(idle, false);
    expect(isMCPLoading(loading)).toBe(true);
    expect(mcpStatusText(loading)).toBe("Loading connections…");
    expect(finishMCPLoad(loading, false).kind).toBe("idle");

    const mutating = {
      kind: "mutating" as const,
      refreshing: false,
      message: "Saved",
      error: "",
      readError: "",
    };
    expect(isMCPBusy(mutating)).toBe(true);
    const refreshing = beginMCPLoad(mutating, false);
    expect(isMCPLoading(refreshing)).toBe(true);
    const settled = finishMCPMutation(finishMCPLoad(refreshing, false));
    expect(settled).toEqual({ kind: "idle", message: "Saved", error: "", readError: "" });
  });
});
