import { describe, expect, test } from "bun:test";
import type { EnvironmentSettingsView, EnvironmentWrite } from "#project-domain/environment";
import {
  activeFilterCount,
  defaultVariableFilters,
  environmentError,
  environmentNotice,
  filterAndSortVariables,
  isEnvironmentBusy,
  isEnvironmentDirty,
  isVariableChanged,
  mergeImportedVariables,
  pendingEnvironmentRetry,
  previewEnvironmentImport,
} from "./settings-state";

const savedView: EnvironmentSettingsView = {
  environment: "development",
  version: 2,
  canManage: true,
  storeConfigured: true,
  pending: false,
  pendingCommandID: null,
  variables: [
    { name: "ALPHA", runtime: true, verification: false },
    { name: "BETA", runtime: false, verification: true },
  ],
};

describe("environment settings state machine", () => {
  test("derives busy, retry, error and notice from EnvironmentPhase", () => {
    const retry: EnvironmentWrite = {
      commandID: "cmd-1",
      version: 2,
      variables: [{ name: "ALPHA", runtime: true, verification: false }],
    };
    expect(isEnvironmentBusy({ kind: "loading" })).toBe(true);
    expect(isEnvironmentBusy({ kind: "saving", retry })).toBe(true);
    expect(isEnvironmentBusy({ kind: "discarding", pendingRetry: retry })).toBe(true);
    expect(isEnvironmentBusy({ kind: "ready" })).toBe(false);
    expect(pendingEnvironmentRetry({ kind: "saving", retry })).toEqual(retry);
    expect(pendingEnvironmentRetry({ kind: "ready", pendingRetry: retry })).toEqual(retry);
    expect(environmentError({ kind: "load-error", message: "boom" })).toBe("boom");
    expect(environmentError({ kind: "ready", error: "save failed" })).toBe("save failed");
    expect(environmentNotice({ kind: "ready", notice: "Saved." })).toBe("Saved.");
    expect(environmentNotice({ kind: "loading" })).toBe("");
  });

  test("keeps active editor anchored in sort order while typing and bypasses filters", () => {
    const variables = [
      { name: "ZZZ_RENAMED", runtime: true, verification: false },
      { name: "BETA", runtime: false, verification: true },
    ];
    const result = filterAndSortVariables(
      variables,
      savedView,
      { ...defaultVariableFilters(), search: "beta" },
      "name-asc",
      { kind: "editing", index: 0, sortAnchor: { name: "ALPHA", changed: false } },
    );
    expect(result.map((entry) => entry.index)).toEqual([0, 1]);
  });

  test("detects changed variables, merges imports and previews valid/invalid .env pastes", () => {
    expect(
      isVariableChanged({ name: "ALPHA", runtime: true, verification: false }, savedView),
    ).toBe(false);
    expect(
      isVariableChanged(
        { name: "ALPHA", value: "new-secret", runtime: true, verification: false },
        savedView,
      ),
    ).toBe(true);
    expect(isEnvironmentDirty(savedView.variables, savedView)).toBe(false);
    expect(activeFilterCount({ ...defaultVariableFilters(), usage: "runtime" }, "name-desc")).toBe(
      2,
    );

    const merged = mergeImportedVariables(
      [{ name: "ALPHA", runtime: false, verification: true }],
      [
        { name: "ALPHA", value: "updated" },
        { name: "NEW_VAR", value: "hello" },
      ],
    );
    expect(merged).toEqual([
      { name: "ALPHA", value: "updated", runtime: false, verification: true },
      { name: "NEW_VAR", value: "hello", runtime: true, verification: false },
    ]);

    const okPreview = previewEnvironmentImport({
      kind: "open",
      text: "FOO=bar\nBAZ=qux",
      shown: false,
      result: { kind: "idle" },
    });
    expect(okPreview.kind === "open" && okPreview.result.kind).toBe("preview");

    const badPreview = previewEnvironmentImport({
      kind: "open",
      text: "NOT A VALID LINE",
      shown: false,
      result: { kind: "idle" },
    });
    expect(badPreview.kind === "open" && badPreview.result.kind).toBe("error");
  });
});
