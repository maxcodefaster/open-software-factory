import { expect, test } from "bun:test";
import { createRoot, createSignal, flush, untrack } from "solid-js";
import { createMCPNavigation } from "./navigation";

test("Input source setup derives its own navigation and restores normal filters without effect copies", () => {
  createRoot((dispose) => {
    const [setup, setSetup] = createSignal<string>();
    const state = createMCPNavigation(setup);
    state.setQuery("retained search");
    state.setSelected("retained connection");
    state.setFilters(true);
    flush();
    setSetup("first");
    flush();
    expect(untrack(state.scope)).toBe("project");
    expect(untrack(state.query)).toBe("");
    expect(untrack(state.selected)).toBeUndefined();
    state.setSelected("setup connection");
    flush();
    setSetup(undefined);
    flush();
    expect(untrack(state.query)).toBe("retained search");
    expect(untrack(state.selected)).toBe("retained connection");
    expect(untrack(state.filters)).toBe(true);
    setSetup("second");
    flush();
    expect(untrack(state.selected)).toBeUndefined();
    dispose();
  });
});
