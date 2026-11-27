import { describe, expect, test } from "bun:test";
import type { SkillLibraryEntry, SkillLibraryView } from "#conversation-domain/skill-library";
import type { SkillRevision } from "#conversation-domain/skills";
import {
  activeSkillDraft,
  applySkillImportPreview,
  beginSkillLoad,
  closeSkillEditor,
  closeSkillImport,
  discardSkillDraft,
  enterSkillManageMode,
  exitSkillManageMode,
  finishSkillLoad,
  finishSkillMutation,
  initialSkillActivity,
  initialSkillSurface,
  initialSkillViewMode,
  openSkillEditor,
  openSkillImport,
  resolveManagementScope,
  resolveSkillScope,
  selectSkillEntry,
  setInspectedSkillProposal,
  setSkillManageTarget,
  skillActivityBusy,
  skillActivityLoading,
  skillActivityStatusText,
} from "./library-state";

const sampleRevision: SkillRevision = {
  id: "rev-1",
  revision: 1,
  digest: "digest-1",
  published: true,
  content: {
    key: "test-skill",
    name: "Test skill",
    description: "Description",
    instructions: "Instructions",
    roles: ["planning", "build"],
    references: [],
  },
};

const sampleEntry: SkillLibraryEntry = {
  id: "lib-1",
  scope: "personal",
  ownerId: "user-1",
  projectId: null,
  cover: null,
  editable: true,
  revisions: [sampleRevision],
};

describe("skill library surface state machine", () => {
  test("preserves exact draft identity across editor cancel and resume", () => {
    const initial = selectSkillEntry(initialSkillSurface(), sampleEntry.id);
    const opened = openSkillEditor(initial, sampleEntry);
    expect(opened.kind).toBe("editor");
    expect(opened.selectedId).toBe(sampleEntry.id);
    const draftRef = activeSkillDraft(opened);
    expect(draftRef?.entry?.id).toBe(sampleEntry.id);

    const closed = closeSkillEditor(opened);
    expect(closed.kind).toBe("browser");
    expect(closed.selectedId).toBe(sampleEntry.id);
    expect(activeSkillDraft(closed)).toBe(draftRef);

    const resumed = openSkillEditor(closed);
    expect(resumed.kind).toBe("editor");
    expect(activeSkillDraft(resumed)).toBe(draftRef);

    const discarded = discardSkillDraft(resumed);
    expect(discarded.kind).toBe("browser");
    expect(activeSkillDraft(discarded)).toBeUndefined();
  });

  test("forbids entering import while a retained draft exists, and transitions import preview into editor", () => {
    const withDraft = closeSkillEditor(openSkillEditor(initialSkillSurface(), sampleEntry));
    expect(openSkillImport(withDraft)).toBe(withDraft);

    const clean = discardSkillDraft(withDraft);
    const importing = openSkillImport(clean);
    expect(importing.kind).toBe("import");

    const previewed = applySkillImportPreview(importing, {
      content: sampleRevision.content,
      warnings: ["Check references"],
    });
    expect(previewed.kind).toBe("editor");
    expect(activeSkillDraft(previewed)?.warnings).toEqual(["Check references"]);

    expect(closeSkillImport(importing).kind).toBe("browser");
  });
});

describe("skill library view mode and activity state machines", () => {
  test("tracks management target and inspected proposal only in manage mode", () => {
    const view: SkillLibraryView = {
      canManageProject: true,
      canManageSystem: true,
      entries: [],
      choices: [],
      proposals: [],
      sharedVersions: [],
    };
    const browse = initialSkillViewMode();
    expect(resolveSkillScope(view, "proj-1", browse)).toBe("personal");

    const manage = enterSkillManageMode(browse);
    expect(manage.kind).toBe("manage");
    expect(resolveManagementScope(view, "proj-1", manage)).toBe("project");

    const sysManage = setSkillManageTarget(manage, "system");
    expect(resolveSkillScope(view, "proj-1", sysManage)).toBe("system");

    const withInspected = setInspectedSkillProposal(sysManage, {
      proposalId: "prop-1",
      revision: sampleRevision,
    });
    expect(withInspected.kind === "manage" && withInspected.inspected?.proposalId).toBe("prop-1");

    const exited = exitSkillManageMode(withInspected);
    expect(exited).toEqual({ kind: "browse", lastTarget: "system" });
    expect(resolveManagementScope(view, "proj-1", enterSkillManageMode(exited))).toBe("system");
  });

  test("tracks concurrent saving and refresh without losing status text", () => {
    const idle = initialSkillActivity();
    const loading = beginSkillLoad(idle);
    expect(skillActivityLoading(loading)).toBe(true);
    expect(skillActivityBusy(loading)).toBe(false);
    expect(skillActivityStatusText(loading)).toBe("Loading skills…");
    expect(finishSkillLoad(loading).kind).toBe("idle");

    const saving = {
      kind: "saving" as const,
      refreshing: false,
      status: "Saved",
      error: "",
    };
    const refreshing = beginSkillLoad(saving);
    expect(skillActivityBusy(refreshing)).toBe(true);
    expect(skillActivityLoading(refreshing)).toBe(true);
    expect(skillActivityStatusText(refreshing)).toBe("Saving…");

    const doneRefresh = finishSkillLoad(refreshing);
    expect(skillActivityBusy(doneRefresh)).toBe(true);
    expect(skillActivityLoading(doneRefresh)).toBe(false);

    const settled = finishSkillMutation(doneRefresh);
    expect(settled).toEqual({ kind: "idle", status: "Saved", error: "" });
  });
});
