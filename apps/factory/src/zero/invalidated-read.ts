/** Join reads, but never lose an invalidation received during an older read. */
export function createInvalidatedRead(options: {
  read(signal: AbortSignal): Promise<void>;
  visible(): boolean;
  onError?(cause: unknown): void;
}) {
  let pending: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let dirty = false;
  let stopped = false;
  function refresh(): Promise<void> {
    if (stopped) return Promise.resolve();
    dirty = true;
    if (pending) return pending;
    if (!options.visible()) return Promise.resolve();
    pending = (async () => {
      do {
        dirty = false;
        controller = new AbortController();
        try {
          await options.read(controller.signal);
        } catch (cause) {
          if (!stopped && !controller.signal.aborted) options.onError?.(cause);
        }
      } while (dirty && !stopped && options.visible());
    })().finally(() => {
      pending = undefined;
      controller = undefined;
      if (dirty && !stopped && options.visible()) void refresh();
    });
    return pending;
  }
  return {
    refresh,
    stop() {
      stopped = true;
      dirty = false;
      controller?.abort();
    },
  };
}
