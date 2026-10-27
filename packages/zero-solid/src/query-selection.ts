import { createMemo } from "solid-js";

/** Query builders are fresh objects. Subscription identity is client + query. */
export function createQuerySelection<T extends { client: object; key: string }>(
  select: () => T | undefined,
) {
  return createMemo(select, {
    equals: (a, b) => a?.client === b?.client && a?.key === b?.key,
  });
}
