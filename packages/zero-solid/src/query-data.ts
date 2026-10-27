import { createStore, reconcile } from "solid-js";

export function createQueryData<T>() {
  const [state, setState] = createStore<{ data: T | undefined }>({ data: undefined });
  return {
    data: () => state.data,
    clear: () =>
      setState((draft) => {
        draft.data = undefined;
      }),
    publish(value: T, primaryKey: readonly string[]) {
      setState(
        reconcile({ data: value }, (row) =>
          row && typeof row === "object" && primaryKey.every((key) => key in row)
            ? JSON.stringify(primaryKey.map((key) => row[key]))
            : undefined,
        ),
      );
    },
  };
}
