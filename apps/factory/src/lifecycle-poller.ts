export function createLifecyclePoller(options: {
  read(signal: AbortSignal): Promise<void>;
  visible(): boolean;
  onError(message: string): void;
  interval?: number;
}) {
  const interval = options.interval ?? 1_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let inFlight: Promise<void> | undefined;
  let failures = 0;
  let stopped = false;

  function schedule() {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), Math.min(30_000, interval * 2 ** failures));
  }

  function refresh(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    clearTimeout(timer);
    if (!options.visible()) {
      schedule();
      return Promise.resolve();
    }
    controller = new AbortController();
    inFlight = options
      .read(controller.signal)
      .then(() => {
        failures = 0;
        options.onError("");
      })
      .catch((cause) => {
        if (stopped) return;
        failures = Math.min(failures + 1, 5);
        options.onError(cause instanceof Error ? cause.message : "Factory updates are unavailable");
      })
      .finally(() => {
        inFlight = undefined;
        controller = undefined;
        schedule();
      });
    return inFlight;
  }

  return {
    refresh,
    stop() {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
    },
  };
}
