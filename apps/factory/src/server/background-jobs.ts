// One process owns these observations. Skipped ticks are not queued or replayed.
export function createBackgroundJobs() {
  const timers = new Set<ReturnType<typeof setInterval>>();
  const running = new Set<Promise<void>>();
  let stopping = false;
  let closing: Promise<void> | undefined;

  function every(
    failure: string,
    operation: () => Promise<unknown>,
    delay: number,
    immediate = false,
  ) {
    let active = false;
    const run = () => {
      if (stopping || active) return;
      active = true;
      const task = Promise.resolve()
        .then(operation)
        .then(
          () => {},
          () => console.error(failure),
        )
        .finally(() => {
          active = false;
          running.delete(task);
        });
      running.add(task);
    };
    const timer = setInterval(run, delay);
    timer.unref();
    timers.add(timer);
    if (immediate) run();
  }

  function close() {
    if (closing) return closing;
    stopping = true;
    for (const timer of timers) clearInterval(timer);
    timers.clear();
    closing = Promise.all([...running]).then(() => {});
    return closing;
  }

  return { every, close };
}
