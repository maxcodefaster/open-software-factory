import type {
  SkillLibraryEntry,
  SkillLibraryView,
  SkillScope,
} from "#conversation-domain/skill-library";
import type { SkillContent, SkillRevision } from "#conversation-domain/skills";
import { matchesSkill, type SkillFilters } from "./gallery-state";

export type SkillEditorDraft = {
  content: SkillContent;
  entry?: SkillLibraryEntry;
  warnings?: string[];
};

export type SkillViewMode =
  | { kind: "browse"; lastTarget: "project" | "system" }
  | {
      kind: "manage";
      target: "project" | "system";
      inspected?: { proposalId: string; revision: SkillRevision };
    };

export type SkillSurfaceState =
  | { kind: "browser"; selectedId?: string; retainedDraft?: SkillEditorDraft }
  | { kind: "editor"; selectedId?: string; draft: SkillEditorDraft }
  | { kind: "import"; selectedId?: string };

export type SkillActivityState =
  | { kind: "idle"; status: string; error: string }
  | { kind: "loading"; status: string; error: string }
  | { kind: "saving"; refreshing: boolean; status: string; error: string };

export const initialSkillFilters = (): SkillFilters => ({
  query: "",
  owner: "all",
  role: "all",
  availability: "all",
});

export const initialSkillViewMode = (): SkillViewMode => ({
  kind: "browse",
  lastTarget: "project",
});

export const initialSkillSurface = (): SkillSurfaceState => ({
  kind: "browser",
});

export const initialSkillActivity = (): SkillActivityState => ({
  kind: "idle",
  status: "",
  error: "",
});

export function defaultNewSkillContent(): SkillContent {
  return {
    key: "custom-skill",
    name: "",
    description: "",
    instructions: "",
    roles: ["planning", "build"],
    references: [],
  };
}

export function activeSkillDraft(surface: SkillSurfaceState): SkillEditorDraft | undefined {
  if (surface.kind === "editor") return surface.draft;
  if (surface.kind === "browser") return surface.retainedDraft;
  return undefined;
}

export function openSkillEditor(
  surface: SkillSurfaceState,
  entry?: SkillLibraryEntry,
): SkillSurfaceState {
  const existing = activeSkillDraft(surface);
  const draft: SkillEditorDraft = existing ?? {
    ...(entry ? { entry } : {}),
    content: entry?.revisions[0]?.content ?? defaultNewSkillContent(),
  };
  return {
    kind: "editor",
    ...(surface.selectedId ? { selectedId: surface.selectedId } : {}),
    draft,
  };
}

export function openSkillSourceUpdateEditor(
  surface: SkillSurfaceState,
  entry: SkillLibraryEntry,
  content: SkillContent,
  warnings: string[],
): SkillSurfaceState {
  return {
    kind: "editor",
    ...(surface.selectedId ? { selectedId: surface.selectedId } : {}),
    draft: { entry, content, warnings },
  };
}

export function closeSkillEditor(surface: SkillSurfaceState): SkillSurfaceState {
  const retained = activeSkillDraft(surface);
  return {
    kind: "browser",
    ...(surface.selectedId ? { selectedId: surface.selectedId } : {}),
    ...(retained ? { retainedDraft: retained } : {}),
  };
}

export function discardSkillDraft(surface: SkillSurfaceState): SkillSurfaceState {
  return {
    kind: "browser",
    ...(surface.selectedId ? { selectedId: surface.selectedId } : {}),
  };
}

export function openSkillImport(surface: SkillSurfaceState): SkillSurfaceState {
  if (activeSkillDraft(surface)) return surface;
  return {
    kind: "import",
    ...(surface.selectedId ? { selectedId: surface.selectedId } : {}),
  };
}

export function closeSkillImport(surface: SkillSurfaceState): SkillSurfaceState {
  return {
    kind: "browser",
    ...(surface.selectedId ? { selectedId: surface.selectedId } : {}),
  };
}

export function applySkillImportPreview(
  surface: SkillSurfaceState,
  preview: SkillEditorDraft,
): SkillSurfaceState {
  return {
    kind: "editor",
    ...(surface.selectedId ? { selectedId: surface.selectedId } : {}),
    draft: preview,
  };
}

export function selectSkillEntry(
  surface: SkillSurfaceState,
  selectedId: string | undefined,
): SkillSurfaceState {
  if (surface.kind === "editor") {
    return {
      kind: "editor",
      draft: surface.draft,
      ...(selectedId ? { selectedId } : {}),
    };
  }
  if (surface.kind === "import") {
    return {
      kind: "import",
      ...(selectedId ? { selectedId } : {}),
    };
  }
  return {
    kind: "browser",
    ...(surface.retainedDraft ? { retainedDraft: surface.retainedDraft } : {}),
    ...(selectedId ? { selectedId } : {}),
  };
}

export function enterSkillManageMode(mode: SkillViewMode): SkillViewMode {
  return mode.kind === "manage" ? mode : { kind: "manage", target: mode.lastTarget };
}

export function exitSkillManageMode(mode: SkillViewMode): SkillViewMode {
  return mode.kind === "browse" ? mode : { kind: "browse", lastTarget: mode.target };
}

export function setSkillManageTarget(
  mode: SkillViewMode,
  target: "project" | "system",
): SkillViewMode {
  return mode.kind === "manage"
    ? { kind: "manage", target }
    : { kind: "browse", lastTarget: target };
}

export function setInspectedSkillProposal(
  mode: SkillViewMode,
  inspected: { proposalId: string; revision: SkillRevision } | undefined,
): SkillViewMode {
  if (mode.kind !== "manage") return mode;
  return inspected
    ? { kind: "manage", target: mode.target, inspected }
    : { kind: "manage", target: mode.target };
}

export function canManageSkills(view: SkillLibraryView | undefined) {
  return Boolean(view?.canManageProject || view?.canManageSystem);
}

export function resolveManagementScope(
  view: SkillLibraryView | undefined,
  projectId: string | undefined,
  mode: SkillViewMode,
): "project" | "system" {
  const target = mode.kind === "manage" ? mode.target : mode.lastTarget;
  return view?.canManageProject && projectId
    ? view?.canManageSystem
      ? target
      : "project"
    : "system";
}

export function resolveSkillScope(
  view: SkillLibraryView | undefined,
  projectId: string | undefined,
  mode: SkillViewMode,
): SkillScope {
  return mode.kind === "manage" && canManageSkills(view)
    ? resolveManagementScope(view, projectId, mode)
    : "personal";
}

export function activeSkillFilterCount(filters: SkillFilters) {
  return [filters.owner, filters.role, filters.availability].filter((value) => value !== "all")
    .length;
}

export function visibleSkillEntries(
  view: SkillLibraryView | undefined,
  mode: SkillViewMode,
  scope: SkillScope,
  filters: SkillFilters,
) {
  const managing = mode.kind === "manage";
  return (view?.entries ?? [])
    .filter(
      (entry) =>
        entry.revisions.length &&
        (!managing ||
          (entry.scope !== "personal" && (scope !== "system" || entry.scope === "system"))) &&
        matchesSkill(entry, view?.choices ?? [], scope, filters),
    )
    .toSorted((a, b) =>
      (a.revisions[0]?.content.name ?? "").localeCompare(b.revisions[0]?.content.name ?? ""),
    );
}

export function visibleSkillProposals(view: SkillLibraryView | undefined, scope: SkillScope) {
  return (view?.proposals ?? []).filter(
    (proposal) =>
      proposal.target === scope &&
      (proposal.target === "system" ? view?.canManageSystem : view?.canManageProject),
  );
}

export function skillActivityBusy(activity: SkillActivityState) {
  return activity.kind === "saving";
}

export function skillActivityLoading(activity: SkillActivityState) {
  return activity.kind === "loading" || (activity.kind === "saving" && activity.refreshing);
}

export function skillActivityStatusText(activity: SkillActivityState) {
  if (activity.kind === "saving") return "Saving…";
  if (activity.kind === "loading") return "Loading skills…";
  return activity.status;
}

export function beginSkillLoad(activity: SkillActivityState): SkillActivityState {
  if (activity.kind === "saving") return { ...activity, refreshing: true };
  return { kind: "loading", status: activity.status, error: activity.error };
}

export function finishSkillLoad(activity: SkillActivityState): SkillActivityState {
  if (activity.kind === "saving") return { ...activity, refreshing: false };
  return { kind: "idle", status: activity.status, error: activity.error };
}

export function finishSkillMutation(activity: SkillActivityState): SkillActivityState {
  if (activity.kind !== "saving") return activity;
  return { kind: "idle", status: activity.status, error: activity.error };
}
