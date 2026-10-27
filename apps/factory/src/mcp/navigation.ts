import { type Accessor, createSignal, untrack } from "solid-js";

type Navigation = {
  scope: "personal" | "project" | "system";
  query: string;
  owner: string;
  workType: string;
  filters: boolean;
  selected: string | undefined;
  editor: boolean;
};
const initial = (scope: Navigation["scope"]): Navigation => ({
  scope,
  query: "",
  owner: "all",
  workType: "all",
  filters: false,
  selected: undefined,
  editor: false,
});

export function createMCPNavigation(setupID: Accessor<string | undefined>) {
  const [normal, setNormal] = createSignal(initial("personal"));
  const [setup, setSetup] = createSignal(() => ({ id: setupID(), ...initial("project") }));
  const current = () => (setupID() ? setup() : normal());
  function field<K extends keyof Navigation>(key: K) {
    return [
      () => current()[key],
      (value: Navigation[K] | ((previous: Navigation[K]) => Navigation[K])) => {
        const patch = (previous: Navigation) => ({
          ...previous,
          [key]: typeof value === "function" ? value(previous[key]) : value,
        });
        if (untrack(setupID)) setSetup((previous) => ({ ...previous, ...patch(previous) }));
        else setNormal(patch);
      },
    ] as const;
  }
  const [scope, setScope] = field("scope");
  const [query, setQuery] = field("query");
  const [owner, setOwner] = field("owner");
  const [workType, setWorkType] = field("workType");
  const [filters, setFilters] = field("filters");
  const [selected, setSelected] = field("selected");
  const [editor, setEditor] = field("editor");
  return {
    scope,
    setScope,
    query,
    setQuery,
    owner,
    setOwner,
    workType,
    setWorkType,
    filters,
    setFilters,
    selected,
    setSelected,
    editor,
    setEditor,
  };
}
