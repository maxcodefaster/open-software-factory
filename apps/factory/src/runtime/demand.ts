export function runtimeDocumentRequest(request: Request) {
  return request.method === "GET" && request.headers.get("sec-fetch-mode") === "navigate";
}

// Only a deliberate App open or trusted App activity calls this command.
// Polling, health reads and socket reconnects continue to observe without waking.
export function createRuntimeDemand(
  runtime: {
    get(attemptID: string): Promise<{ state: string; failure: string | null } | null>;
    resumeForApp(attemptID: string, userID: string, deadline: number): Promise<unknown>;
  },
  hub: { use(attemptID: string): boolean },
  sleep: (ms: number) => Promise<unknown> = Bun.sleep,
  now = () => performance.now(),
) {
  return async (attemptID: string, userID: string) => {
    const deadline = now() + 420_000;
    let requested = false;
    while (now() < deadline) {
      const current = await runtime.get(attemptID);
      if (!current || current.failure) return false;
      if (current.state === "ready") return hub.use(attemptID);
      if (["pausing", "paused", "resuming"].includes(current.state) && !requested) {
        requested = true;
        await runtime.resumeForApp(attemptID, userID, deadline);
        continue;
      }
      if (!["create-intended", "starting", "pausing", "resuming"].includes(current.state))
        return false;
      await sleep(250);
    }
    return false;
  };
}
