import { createEffect, createMemo, createSignal } from "solid-js";

// Whole milliseconds spent in the current wait. A new value from `waiting`
// restarts the count; a falsy value ends it. Ticks only repaint the reading.
export function createWaitElapsed(waiting: () => unknown, intervalMilliseconds = 5_000) {
  const [now, setNow] = createSignal(Date.now());
  const started = createMemo(() => (waiting() ? Date.now() : undefined));
  createEffect(
    () => started() !== undefined,
    (active) => {
      if (!active) return;
      const timer = setInterval(() => setNow(Date.now()), intervalMilliseconds);
      return () => clearInterval(timer);
    },
  );
  return () => {
    const origin = started();
    return origin === undefined ? 0 : Math.max(0, now() - origin);
  };
}

export function waitLabel(milliseconds: number) {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1_000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${seconds % 60} s`;
}
