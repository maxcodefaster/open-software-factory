import { createEffect, type ParentProps } from "solid-js";
import { FactoryReads } from "../../apps/factory/src/zero/reads";

// Standalone component proofs deliver explicit content-free invalidations.
// Full Factory proofs retain the real PostgreSQL -> Zero -> read observer path.
export function FixtureReads(props: ParentProps) {
  const retries = new Set<() => void>();
  return FactoryReads({
    value: {
      observe(source, read) {
        createEffect(
          () => JSON.stringify(source()),
          (key) => {
            if (key === "null") return;
            const current = JSON.parse(key) as { scope: string };
            const controller = new AbortController();
            const refresh = () => {
              void read(controller.signal);
            };
            const invalidate = (event: Event) => {
              const scope = (event as CustomEvent<{ scope: string }>).detail.scope;
              if (scope === current.scope) refresh();
            };
            retries.add(refresh);
            window.addEventListener("factory:test-read", invalidate);
            refresh();
            return () => {
              retries.delete(refresh);
              controller.abort();
              window.removeEventListener("factory:test-read", invalidate);
            };
          },
        );
      },
      errors: () => [],
      retry() {
        for (const refresh of retries) refresh();
      },
    },
    get children() {
      return props.children;
    },
  });
}
