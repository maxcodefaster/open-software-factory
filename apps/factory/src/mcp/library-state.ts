import type { z } from "zod";
import type {
  MCPDefinition,
  MCPLibraryView,
  MCPRole,
  mcpSaveInput,
} from "#conversation-domain/mcp-library";
import type { MCPDraft, MCPEntry, MCPMonitoringSetup, MCPScope } from "./library-shared";

export type MCPActivityState =
  | { kind: "idle"; message: string; error: string; readError: string }
  | { kind: "loading"; message: string; error: string; readError: string }
  | { kind: "mutating"; refreshing: boolean; message: string; error: string; readError: string };

export type PendingMCPSave = {
  basis: string;
  input: z.input<typeof mcpSaveInput>;
};

export type MCPDraftState =
  | { kind: "empty" }
  | { kind: "draft"; draft: MCPDraft; pendingSave?: PendingMCPSave };

export type MCPDetailInteractionState =
  | {
      kind: "idle";
      token: string;
      allowed: string[];
      confirmed: boolean;
      shareTarget: "project" | "system";
    }
  | {
      kind: "authorizing";
      authorizationUrl: string;
      token: string;
      allowed: string[];
      confirmed: boolean;
      shareTarget: "project" | "system";
    };

export const initialMCPActivity = (): MCPActivityState => ({
  kind: "idle",
  message: "",
  error: "",
  readError: "",
});

export const initialMCPDraftState = (): MCPDraftState => ({ kind: "empty" });

export const initialMCPDetailInteraction = (): MCPDetailInteractionState => ({
  kind: "idle",
  token: "",
  allowed: [],
  confirmed: false,
  shareTarget: "project",
});

export function isMCPBusy(activity: MCPActivityState) {
  return activity.kind === "mutating";
}

export function isMCPLoading(activity: MCPActivityState) {
  return activity.kind === "loading" || (activity.kind === "mutating" && activity.refreshing);
}

export function mcpStatusText(activity: MCPActivityState) {
  return isMCPLoading(activity) ? "Loading connections…" : activity.message;
}

export function beginMCPLoad(activity: MCPActivityState, quiet: boolean): MCPActivityState {
  if (quiet) return activity;
  if (activity.kind === "mutating") return { ...activity, refreshing: true };
  return {
    kind: "loading",
    message: activity.message,
    error: activity.error,
    readError: activity.readError,
  };
}

export function finishMCPLoad(activity: MCPActivityState, quiet: boolean): MCPActivityState {
  if (quiet) return activity;
  if (activity.kind === "mutating") return { ...activity, refreshing: false };
  return {
    kind: "idle",
    message: activity.message,
    error: activity.error,
    readError: activity.readError,
  };
}

export function finishMCPMutation(activity: MCPActivityState): MCPActivityState {
  if (activity.kind !== "mutating") return activity;
  return {
    kind: "idle",
    message: activity.message,
    error: activity.error,
    readError: activity.readError,
  };
}

export function activeMCPDraft(state: MCPDraftState): MCPDraft | undefined {
  return state.kind === "draft" ? state.draft : undefined;
}

export function openMCPDraft(
  state: MCPDraftState,
  options: {
    content?: MCPDefinition | undefined;
    item?: MCPEntry | undefined;
    monitoringSetup: boolean;
    projectId?: string | undefined;
    projectName?: string | undefined;
  },
): MCPDraftState {
  if (state.kind === "draft") return state;
  return {
    kind: "draft",
    draft: {
      content: options.content ?? {
        name: "",
        description: "",
        endpoint: "",
        provider: "custom",
        authentication: "oauth",
        roles: ["planning", "build"],
      },
      scope: options.item?.scope ?? (options.monitoringSetup ? "project" : "personal"),
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.projectName ? { projectName: options.projectName } : {}),
      ...(options.item ? { entry: options.item } : {}),
    },
  };
}

export function patchMCPDraftContent(
  state: MCPDraftState,
  patch: Partial<MCPDefinition>,
): MCPDraftState {
  if (state.kind !== "draft") return state;
  return {
    ...state,
    draft: { ...state.draft, content: { ...state.draft.content, ...patch } },
  };
}

export function patchMCPDraftScope(state: MCPDraftState, scope: MCPScope): MCPDraftState {
  if (state.kind !== "draft") return state;
  return {
    ...state,
    draft: { ...state.draft, scope },
  };
}

export function resolvePendingMCPSave(
  state: Extract<MCPDraftState, { kind: "draft" }>,
  content: MCPDefinition,
): { nextState: Extract<MCPDraftState, { kind: "draft" }>; submitted: PendingMCPSave } {
  const { draft } = state;
  const basis = JSON.stringify({
    libraryId: draft.entry?.id ?? null,
    expectedRevision: draft.entry?.revisions[0]?.revision ?? 0,
    scope: draft.scope,
    projectId: draft.scope === "project" ? draft.projectId : null,
    content,
  });
  if (state.pendingSave && state.pendingSave.basis === basis) {
    return { nextState: state, submitted: state.pendingSave };
  }
  const submitted: PendingMCPSave = {
    basis,
    input: {
      libraryId: draft.entry?.id ?? crypto.randomUUID(),
      revisionId: crypto.randomUUID(),
      expectedRevision: draft.entry?.revisions[0]?.revision ?? 0,
      scope: draft.scope,
      ...(draft.scope === "project" && draft.projectId ? { projectId: draft.projectId } : {}),
      content,
    },
  };
  return { nextState: { ...state, pendingSave: submitted }, submitted };
}

export function mcpAuthorizationUrl(state: MCPDetailInteractionState): string | undefined {
  return state.kind === "authorizing" ? state.authorizationUrl : undefined;
}

export function clearMCPAuthorization(state: MCPDetailInteractionState): MCPDetailInteractionState {
  if (state.kind === "idle") return state;
  return {
    kind: "idle",
    token: state.token,
    allowed: state.allowed,
    confirmed: state.confirmed,
    shareTarget: state.shareTarget,
  };
}

export function resetMCPDetailInteraction(
  state: MCPDetailInteractionState,
  allowed: string[] = [],
): MCPDetailInteractionState {
  return {
    kind: "idle",
    token: "",
    allowed,
    confirmed: false,
    shareTarget: state.shareTarget,
  };
}

export function resetMCPDetailOnMonitoringEnter(
  state: MCPDetailInteractionState,
): MCPDetailInteractionState {
  return {
    kind: "idle",
    token: "",
    allowed: state.allowed,
    confirmed: false,
    shareTarget: state.shareTarget,
  };
}

export function applyMCPConnectResult(
  state: MCPDetailInteractionState,
  authorizationUrl: string | null | undefined,
): MCPDetailInteractionState {
  if (authorizationUrl) {
    return {
      kind: "authorizing",
      authorizationUrl,
      token: "",
      allowed: [],
      confirmed: false,
      shareTarget: state.shareTarget,
    };
  }
  return resetMCPDetailInteraction(state, []);
}

export function syncMCPDetailAfterLoad(
  state: MCPDetailInteractionState,
  previousEntry: MCPEntry | undefined,
  nextEntry: MCPEntry | undefined,
): MCPDetailInteractionState {
  let next = state;
  if (
    previousEntry &&
    (previousEntry.revisions[0]?.id !== nextEntry?.revisions[0]?.id ||
      previousEntry.connection?.version !== nextEntry?.connection?.version ||
      previousEntry.connection?.state !== nextEntry?.connection?.state)
  ) {
    next = {
      ...next,
      confirmed: false,
      allowed: nextEntry?.connection?.allowedTools ?? [],
    };
  }
  if (nextEntry?.connection?.state !== "authorizing") {
    next = clearMCPAuthorization(next);
  }
  return next;
}

export function toggleMCPToolSelection(
  state: MCPDetailInteractionState,
  toolName: string,
  checked: boolean,
): MCPDetailInteractionState {
  return {
    ...state,
    allowed: checked
      ? [...state.allowed, toolName]
      : state.allowed.filter((name) => name !== toolName),
    confirmed: false,
  };
}

export function isMonitoringSetupHere(
  setup: MCPMonitoringSetup | undefined,
  projectId: string | undefined,
) {
  return Boolean(setup && setup.projectId === projectId);
}

export function isMonitoringSetupBlocked(
  setup: MCPMonitoringSetup | undefined,
  projectId: string | undefined,
  view: MCPLibraryView | undefined,
) {
  return Boolean(setup && (!isMonitoringSetupHere(setup, projectId) || !view?.canManageProject));
}

export function isMCPDraftForMonitoring(
  draftState: MCPDraftState,
  setup: MCPMonitoringSetup | undefined,
) {
  const draft = activeMCPDraft(draftState);
  return draft?.scope === "project" && draft.projectId === setup?.projectId;
}

export function filterMCPEntries(
  view: MCPLibraryView | undefined,
  options: {
    query: string;
    owner: string;
    workType: string;
    scope: MCPScope;
    monitoringSetup: boolean;
  },
) {
  const query = options.query.toLowerCase();
  return (view?.entries ?? []).filter((item) => {
    const content = item.revisions[0]?.content;
    return (
      content &&
      `${content.name} ${content.description} ${content.endpoint}`.toLowerCase().includes(query) &&
      (options.owner === "all" || item.scope === options.owner) &&
      (options.workType === "all" || content.roles.includes(options.workType as MCPRole)) &&
      (options.scope === "personal" || item.scope !== "personal") &&
      (!options.monitoringSetup || item.scope !== "personal")
    );
  });
}

export function activeMCPFilterCount(owner: string, workType: string) {
  return [owner, workType].filter((value) => value !== "all").length;
}
