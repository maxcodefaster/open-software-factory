import { z } from "zod";
import {
  type TechnicalDesignContent,
  technicalDesignContentInput,
} from "#requirement-domain/technical-design";
import type { TechnicalDesignRevision } from "../change/contracts";
import { technicalDesignProblem } from "../proposal-problems";

// Private drafts may be incomplete or contain a syntax error. Only the stronger
// domain schema can authorize a save or a render.
export const technicalDraftInput = technicalDesignContentInput.extend({
  context: z.string().max(12_000),
  proposedChanges: z.string().max(12_000),
  validation: z
    .array(
      z.strictObject({
        criterion: z.number().int().min(1).max(100),
        check: z.string().max(2_000),
      }),
    )
    .max(100),
  diagrams: z
    .array(
      z.strictObject({
        title: z.string().max(160),
        description: z.string().max(2_000),
        source: z.string().max(16_000),
      }),
    )
    .max(2),
});

export type TechnicalDesignEditorState =
  | { kind: "viewing" }
  | {
      kind: "editing";
      baseID: string;
      draft: TechnicalDesignContent;
      error?: string | undefined;
    }
  | {
      kind: "saving";
      baseID: string;
      draft: TechnicalDesignContent;
    };

export type ActiveTechnicalDesignState = Exclude<TechnicalDesignEditorState, { kind: "viewing" }>;

export const initialTechnicalDesignEditorState = (): TechnicalDesignEditorState => ({
  kind: "viewing",
});

export function isTechnicalDesignEditing(state: TechnicalDesignEditorState) {
  return state.kind !== "viewing";
}

export function isTechnicalDesignSaving(state: TechnicalDesignEditorState) {
  return state.kind === "saving";
}

export function activeTechnicalDesignState(
  state: TechnicalDesignEditorState,
): ActiveTechnicalDesignState | undefined {
  return state.kind === "viewing" ? undefined : state;
}

export function technicalDesignError(state: TechnicalDesignEditorState): string | undefined {
  return state.kind === "editing" ? state.error : undefined;
}

export function loadTechnicalDesignDraft(
  storageKey: string,
  revision: TechnicalDesignRevision,
): TechnicalDesignContent {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    const content = technicalDraftInput.safeParse(saved?.content);
    if (saved?.id === revision.id && content.success) return content.data;
  } catch {
    /* A corrupt draft never replaces the saved design. */
  }
  return revision.content;
}

export function persistTechnicalDesignDraft(
  storageKey: string,
  baseID: string,
  content: TechnicalDesignContent,
) {
  try {
    localStorage.setItem(storageKey, JSON.stringify({ id: baseID, content }));
  } catch {
    /* The mounted editor still retains the draft. */
  }
}

export function clearTechnicalDesignDraft(storageKey: string) {
  localStorage.removeItem(storageKey);
}

export function beginTechnicalDesignEdit(
  storageKey: string,
  revision: TechnicalDesignRevision,
): TechnicalDesignEditorState {
  return {
    kind: "editing",
    baseID: revision.id,
    draft: loadTechnicalDesignDraft(storageKey, revision),
  };
}

export function validateTechnicalDesignForSave(
  state: Extract<TechnicalDesignEditorState, { kind: "editing" }>,
  currentRevisionID: string,
): { ok: true; data: TechnicalDesignContent } | { ok: false; error: string } {
  const parsed = technicalDesignContentInput.safeParse(state.draft);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: issue ? technicalDesignProblem(issue) : "Complete the technical design before saving.",
    };
  }
  if (state.baseID !== currentRevisionID) {
    return {
      ok: false,
      error: "The technical design changed elsewhere. Your draft is retained.",
    };
  }
  return { ok: true, data: parsed.data };
}

export function updateValidationCheck(
  draft: TechnicalDesignContent,
  index: number,
  check: string,
): TechnicalDesignContent {
  return {
    ...draft,
    validation: draft.validation.map((value, i) => (i === index ? { ...value, check } : value)),
  };
}

export function updateDiagramAt(
  draft: TechnicalDesignContent,
  index: number,
  patch: Partial<TechnicalDesignContent["diagrams"][number]>,
): TechnicalDesignContent {
  return {
    ...draft,
    diagrams: draft.diagrams.map((value, i) => (i === index ? { ...value, ...patch } : value)),
  };
}

export function removeDiagramAt(
  draft: TechnicalDesignContent,
  index: number,
): TechnicalDesignContent {
  return {
    ...draft,
    diagrams: draft.diagrams.filter((_, i) => i !== index),
  };
}

export function appendEmptyDiagram(draft: TechnicalDesignContent): TechnicalDesignContent {
  return {
    ...draft,
    diagrams: [...draft.diagrams, { title: "", description: "", source: "@startuml\n\n@enduml" }],
  };
}

export type TicketChapter = { id: string; label: string };

export function buildTicketChapters(options: {
  review: boolean;
  technical: boolean;
  architecture: boolean;
  validation: boolean;
}): TicketChapter[] {
  return [
    ...(options.review ? [{ id: "ticket-review", label: "Review" }] : []),
    { id: "ticket-product", label: "Product" },
    ...(options.technical ? [{ id: "ticket-technical", label: "Technical design" }] : []),
    ...(options.architecture ? [{ id: "ticket-architecture", label: "Architecture" }] : []),
    ...(options.validation ? [{ id: "ticket-validation", label: "Validation" }] : []),
  ];
}
