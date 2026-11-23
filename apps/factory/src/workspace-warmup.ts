export interface WarmupEnvironment {
  // Narrow windows and touch devices keep the editor cold until it is opened.
  constrained(): boolean;
  afterLoad(run: () => void): () => void;
  whenIdle(run: () => void): () => void;
}

// Prepare the existing editor after the page's first idle turn, not after another
// interaction or timer. Constrained viewports still fetch only the small chunks.
export function scheduleWarmup(options: {
  prefetch(): void;
  warm(): void;
  environment: WarmupEnvironment;
}) {
  const { environment } = options;
  const cancels = new Set<() => void>();
  let stopped = false;
  const track = (cancel: () => void) => {
    cancels.add(cancel);
    return cancel;
  };
  track(
    environment.afterLoad(() => {
      if (stopped) return;
      track(
        environment.whenIdle(() => {
          if (stopped) return;
          options.prefetch();
          if (!environment.constrained()) options.warm();
        }),
      );
    }),
  );
  return () => {
    stopped = true;
    for (const cancel of cancels) cancel();
    cancels.clear();
  };
}

export function browserWarmupEnvironment(): WarmupEnvironment {
  return {
    constrained: () => matchMedia("(max-width: 760px), (pointer: coarse)").matches,
    afterLoad(run) {
      if (document.readyState === "complete") {
        const timer = setTimeout(run, 0);
        return () => clearTimeout(timer);
      }
      window.addEventListener("load", run, { once: true });
      return () => window.removeEventListener("load", run);
    },
    whenIdle(run) {
      if (typeof requestIdleCallback === "function") {
        const handle = requestIdleCallback(run, { timeout: 2_000 });
        return () => cancelIdleCallback(handle);
      }
      const timer = setTimeout(run, 200);
      return () => clearTimeout(timer);
    },
  };
}
