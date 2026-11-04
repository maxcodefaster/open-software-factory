export const warmupDelayMilliseconds = 4_000;

export interface WarmupEnvironment {
  // Narrow windows and touch devices keep the editor cold until it is opened.
  constrained(): boolean;
  afterLoad(run: () => void): () => void;
  whenIdle(run: () => void): () => void;
  firstInteraction(run: () => void): () => void;
  delay(milliseconds: number, run: () => void): () => void;
}

// The developer chunks are fetched once the page has loaded and gone idle. The editor itself
// (a multi-megabyte bundle) waits for the first interaction or four seconds more, and never
// starts on a constrained viewport.
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
          if (environment.constrained()) return;
          let started = false;
          const start = () => {
            if (started || stopped) return;
            started = true;
            for (const cancel of cancels) cancel();
            cancels.clear();
            if (!environment.constrained()) options.warm();
          };
          track(environment.firstInteraction(start));
          track(environment.delay(warmupDelayMilliseconds, start));
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
    firstInteraction(run) {
      const events = ["pointerdown", "keydown", "touchstart", "wheel"] as const;
      const listen = { once: true, passive: true, capture: true } as const;
      for (const name of events) window.addEventListener(name, run, listen);
      return () => {
        for (const name of events) window.removeEventListener(name, run, listen);
      };
    },
    delay(milliseconds, run) {
      const timer = setTimeout(run, milliseconds);
      return () => clearTimeout(timer);
    },
  };
}
