const inFlightOperations = new Set<Promise<unknown>>();

// Factory waits for admitted native work during shutdown. Substrate owns its
// lifecycle locks; there is no second worker scheduler or dispatch semaphore.
export function trackNativeOperation<T>(operation: Promise<T>) {
  inFlightOperations.add(operation);
  const done = () => void inFlightOperations.delete(operation);
  operation.then(done, done);
  return operation;
}

export async function drainNativeOperations(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (inFlightOperations.size && Date.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...inFlightOperations]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(1, deadline - Date.now()));
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return inFlightOperations.size;
}
