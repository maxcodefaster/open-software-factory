import type { Accessor } from "solid-js";
import type { LibraryCoverKey } from "#conversation-domain/library-covers";
import type { SkillLibraryEntry, SkillLibraryView } from "#conversation-domain/skill-library";
import type { SkillRevision } from "#conversation-domain/skills";
import { serverCall } from "../server-functions/result";
import {
  acceptSkillSharing,
  checkSkillSourceUpdate,
  getSkillRevision,
  proposeSkillSharing,
  saveSkillChoice,
  saveSkillCover,
} from "../server-functions/skills";
import type { ChooseSkill } from "./choice-controls";
import { skillAvailability } from "./gallery-state";
import { openSkillSourceUpdateEditor, type SkillSurfaceState } from "./library-state";

export function createSkillLibraryCommands(options: {
  projectId: Accessor<string | undefined>;
  view: Accessor<SkillLibraryView | undefined>;
  hasDraft: Accessor<boolean>;
  mutate: (action: () => Promise<unknown>, message: string) => Promise<boolean>;
  onOpenSourceUpdate: (updater: (surface: SkillSurfaceState) => SkillSurfaceState) => void;
  onFocusEditor: () => void;
  onInspected: (inspected: { proposalId: string; revision: SkillRevision } | undefined) => void;
  onAccepted: (libraryId: string) => void;
}) {
  const choose: ChooseSkill = (entry, target, selectedRole, state, revisionId) => {
    const current = skillAvailability(entry, options.view()?.choices ?? [], target, selectedRole);
    const selectedRevision = revisionId ?? current.revision?.id;
    const projectId = options.projectId();
    void options.mutate(
      () =>
        serverCall(
          saveSkillChoice({
            data: [
              {
                libraryId: entry.id,
                scope: target,
                ...(projectId ? { projectId } : {}),
                role: selectedRole,
                state,
                ...(selectedRevision ? { revisionId: selectedRevision } : {}),
                expectedVersion: current.own?.version ?? 0,
              },
            ],
          }),
        ),
      target === "personal"
        ? "Choice saved for your new work in this Project"
        : `Default saved for new ${target === "system" ? "Factory" : "Project"} work`,
    );
  };

  function checkSource(entry: SkillLibraryEntry) {
    if (options.hasDraft()) return;
    const projectId = options.projectId();
    void options.mutate(async () => {
      const revision = entry.revisions[0];
      if (!revision) return;
      const result = await serverCall(
        projectId
          ? checkSkillSourceUpdate({ data: [revision.id, projectId] })
          : checkSkillSourceUpdate({ data: [revision.id] }),
      );
      if (result.current) return "The pinned source is current";
      options.onOpenSourceUpdate((current) =>
        openSkillSourceUpdateEditor(
          current,
          entry,
          { ...result.content, key: revision.content.key, name: revision.content.name },
          [
            ...result.warnings,
            "A newer pinned source is available. Compare it with the saved version under Files, source & options. Factory adaptations and your edits are not merged automatically.",
          ],
        ),
      );
      options.onFocusEditor();
    }, "Source check complete");
  }

  function share(entry: SkillLibraryEntry, target: "project" | "system") {
    const revision = entry.revisions[0];
    if (!revision) return;
    const projectId = options.projectId();
    void options.mutate(
      () =>
        serverCall(
          proposeSkillSharing({
            data: [
              {
                id: crypto.randomUUID(),
                revisionId: revision.id,
                target,
                ...(target === "project" ? { projectId } : {}),
              },
            ],
          }),
        ),
      "Exact version proposed for sharing",
    );
  }

  function inspectProposal(proposalId: string, revisionId: string) {
    const projectId = options.projectId();
    void options.mutate(async () => {
      const revision = await serverCall(
        projectId
          ? getSkillRevision({ data: [revisionId, projectId] })
          : getSkillRevision({ data: [revisionId] }),
      );
      options.onInspected({ proposalId, revision });
    }, "Proposed version opened");
  }

  function acceptProposal(proposalId: string) {
    void options.mutate(async () => {
      const result = await serverCall(acceptSkillSharing({ data: [proposalId] }));
      options.onAccepted(result.libraryId);
      options.onInspected(undefined);
    }, "Version added to the shared library. Enable it for new work.");
  }

  function saveCover(libraryId: string, key: LibraryCoverKey, expectedVersion: number) {
    return options.mutate(
      () => serverCall(saveSkillCover({ data: [{ libraryId, key, expectedVersion }] })),
      "Cover saved.",
    );
  }

  return { choose, checkSource, share, inspectProposal, acceptProposal, saveCover };
}
