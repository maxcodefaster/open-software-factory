import { describe, expect, test } from "bun:test";
import type { TechnicalDesignContent } from "#requirement-domain/technical-design";
import {
  activeTechnicalDesignState,
  appendEmptyDiagram,
  buildTicketChapters,
  initialTechnicalDesignEditorState,
  isTechnicalDesignEditing,
  isTechnicalDesignSaving,
  removeDiagramAt,
  type TechnicalDesignEditorState,
  technicalDesignError,
  updateDiagramAt,
  updateValidationCheck,
  validateTechnicalDesignForSave,
} from "./ticket-planning-state";

const validDraft: TechnicalDesignContent = {
  context: "Existing service handles tickets.",
  proposedChanges: "Split UI state into explicit discriminated unions.",
  decisions: ["Use pure state transitions"],
  assumptions: ["Existing selectors remain stable"],
  risks: ["Focus drift on modal close"],
  validation: [{ criterion: 1, check: "Run bun test" }],
  diagrams: [
    { title: "Flow", description: "State transitions", source: "@startuml\nA -> B\n@enduml" },
  ],
};

describe("technical design editor state machine", () => {
  test("separates viewing, editing, and saving variants cleanly", () => {
    const viewing = initialTechnicalDesignEditorState();
    expect(isTechnicalDesignEditing(viewing)).toBe(false);
    expect(isTechnicalDesignSaving(viewing)).toBe(false);
    expect(activeTechnicalDesignState(viewing)).toBeUndefined();

    const editing: TechnicalDesignEditorState = {
      kind: "editing",
      baseID: "rev-1",
      draft: validDraft,
      error: "Fix field",
    };
    expect(isTechnicalDesignEditing(editing)).toBe(true);
    expect(isTechnicalDesignSaving(editing)).toBe(false);
    expect(technicalDesignError(editing)).toBe("Fix field");

    const saving: TechnicalDesignEditorState = {
      kind: "saving",
      baseID: "rev-1",
      draft: validDraft,
    };
    expect(isTechnicalDesignEditing(saving)).toBe(true);
    expect(isTechnicalDesignSaving(saving)).toBe(true);
    expect(technicalDesignError(saving)).toBeUndefined();
  });

  test("validates revision freshness and updates draft arrays immutably", () => {
    const editing: Extract<TechnicalDesignEditorState, { kind: "editing" }> = {
      kind: "editing",
      baseID: "rev-1",
      draft: validDraft,
    };
    expect(validateTechnicalDesignForSave(editing, "rev-1").ok).toBe(true);

    const stale = validateTechnicalDesignForSave(editing, "rev-2");
    expect(stale).toEqual({
      ok: false,
      error: "The technical design changed elsewhere. Your draft is retained.",
    });

    const updatedValidation = updateValidationCheck(validDraft, 0, "Run biome and tsc");
    expect(updatedValidation.validation[0]?.check).toBe("Run biome and tsc");

    const appended = appendEmptyDiagram(validDraft);
    expect(appended.diagrams).toHaveLength(2);
    const patched = updateDiagramAt(appended, 1, { title: "Second" });
    expect(patched.diagrams[1]?.title).toBe("Second");
    expect(removeDiagramAt(patched, 0).diagrams).toHaveLength(1);
  });

  test("builds ticket chapters in canonical order", () => {
    expect(
      buildTicketChapters({
        review: true,
        technical: true,
        architecture: false,
        validation: true,
      }).map((c) => c.id),
    ).toEqual(["ticket-review", "ticket-product", "ticket-technical", "ticket-validation"]);
  });
});
