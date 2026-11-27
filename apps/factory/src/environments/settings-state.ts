import {
  type EnvironmentSettingsView,
  type EnvironmentWrite,
  parseEnvironmentPaste,
} from "#project-domain/environment";

export const grants = ["runtime", "verification"] as const;
export type EnvironmentGrant = (typeof grants)[number];

export const grantLabels: Record<EnvironmentGrant, string> = {
  runtime: "Runtime",
  verification: "Verification",
};

export type EnvironmentVariable = EnvironmentWrite["variables"][number];

export type EnvironmentPhase =
  | { kind: "loading" }
  | { kind: "load-error"; message: string }
  | {
      kind: "ready";
      pendingRetry?: EnvironmentWrite | undefined;
      notice?: string | undefined;
      error?: string | undefined;
    }
  | { kind: "saving"; retry: EnvironmentWrite }
  | { kind: "discarding"; pendingRetry?: EnvironmentWrite | undefined };

export type VariableEditorState =
  | { kind: "idle" }
  | { kind: "editing"; index: number; sortAnchor: { name: string; changed: boolean } };

export type EnvImportState =
  | { kind: "closed" }
  | {
      kind: "open";
      text: string;
      shown: boolean;
      result:
        | { kind: "idle" }
        | { kind: "preview"; entries: Array<{ name: string; value: string }> }
        | { kind: "error"; message: string };
    };

export type VariableFilters = {
  open: boolean;
  search: string;
  usage: "all" | EnvironmentGrant;
  state: "all" | "saved" | "draft";
};

export type ActionMenuState = {
  open: boolean;
  index: number | undefined;
};

export function defaultVariableFilters(open = false): VariableFilters {
  return { open, search: "", usage: "all", state: "all" };
}

export function isEnvironmentBusy(phase: EnvironmentPhase): boolean {
  return phase.kind === "loading" || phase.kind === "saving" || phase.kind === "discarding";
}

export function pendingEnvironmentRetry(phase: EnvironmentPhase): EnvironmentWrite | undefined {
  if (phase.kind === "saving") return phase.retry;
  if (phase.kind === "ready" || phase.kind === "discarding") return phase.pendingRetry;
  return undefined;
}

export function environmentError(phase: EnvironmentPhase): string {
  if (phase.kind === "load-error") return phase.message;
  if (phase.kind === "ready") return phase.error ?? "";
  return "";
}

export function environmentNotice(phase: EnvironmentPhase): string {
  return phase.kind === "ready" ? (phase.notice ?? "") : "";
}

export function activeFilterCount(filters: VariableFilters, sort: string): number {
  return [filters.usage !== "all", filters.state !== "all", sort !== "name-asc"].filter(Boolean)
    .length;
}

export function isVariableChanged(
  variable: EnvironmentVariable,
  savedView: EnvironmentSettingsView | undefined,
): boolean {
  const saved = savedView?.variables.find((item) => item.name === variable.name);
  return (
    !saved ||
    variable.value !== undefined ||
    grants.some((grant) => saved[grant] !== variable[grant])
  );
}

export function isEnvironmentDirty(
  variables: EnvironmentVariable[],
  savedView: EnvironmentSettingsView | undefined,
): boolean {
  return Boolean(
    savedView &&
      (variables.length !== savedView.variables.length ||
        variables.some((variable) => isVariableChanged(variable, savedView))),
  );
}

export function filterAndSortVariables(
  variables: EnvironmentVariable[],
  savedView: EnvironmentSettingsView | undefined,
  filters: VariableFilters,
  sort: string,
  editor: VariableEditorState,
): Array<{ variable: EnvironmentVariable; index: number }> {
  const query = filters.search.trim().toLowerCase();
  const editingIndex = editor.kind === "editing" ? editor.index : undefined;
  return variables
    .map((variable, index) => ({ variable, index }))
    .filter(({ variable, index }) => {
      if (editingIndex === index) return true;
      const dirty = isVariableChanged(variable, savedView);
      return (
        variable.name.toLowerCase().includes(query) &&
        (filters.usage === "all" || variable[filters.usage]) &&
        (filters.state === "all" || (filters.state === "draft" ? dirty : !dirty))
      );
    })
    .sort((left, right) => {
      // Keep the active editor in place while its name or value changes.
      const a =
        editor.kind === "editing" && editor.index === left.index
          ? editor.sortAnchor
          : { name: left.variable.name, changed: isVariableChanged(left.variable, savedView) };
      const b =
        editor.kind === "editing" && editor.index === right.index
          ? editor.sortAnchor
          : { name: right.variable.name, changed: isVariableChanged(right.variable, savedView) };
      if (sort === "draft-first" && a.changed !== b.changed) return a.changed ? -1 : 1;
      const names = a.name.localeCompare(b.name);
      return sort === "name-desc" ? -names : names;
    });
}

export function mergeImportedVariables(
  items: EnvironmentVariable[],
  entries: Array<{ name: string; value: string }>,
): EnvironmentVariable[] {
  const result = [...items];
  for (const entry of entries) {
    const index = result.findIndex((item) => item.name === entry.name);
    if (index < 0) result.push({ ...entry, runtime: true, verification: false });
    else {
      const existing = result[index];
      if (existing) result[index] = { ...existing, value: entry.value };
    }
  }
  return result;
}

export function previewEnvironmentImport(state: EnvImportState): EnvImportState {
  if (state.kind !== "open") return state;
  try {
    return {
      ...state,
      result: { kind: "preview", entries: parseEnvironmentPaste(state.text) },
    };
  } catch {
    return {
      ...state,
      result: {
        kind: "error",
        message: "Check the pasted variable names, quotes and duplicate entries.",
      },
    };
  }
}
