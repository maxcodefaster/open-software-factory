type RecoveredAttempt = { id: string; state: string };
type RecoveryPorts = {
  connected: (attemptID: string) => boolean;
  state: (attemptID: string) => Promise<string | undefined>;
  disconnected: (attemptID: string) => Promise<void>;
  schedule?: (check: () => Promise<void>, delayMS: number) => void;
};

// Connector transport probes every 30s and bounds a reconnect handshake at 15s.
// Start this bounded grace only once Factory can accept its authenticated sockets.
export function recoveredConnectionObserver(attempts: RecoveredAttempt[], ports: RecoveryPorts) {
  let armed = false;
  const schedule =
    ports.schedule ??
    ((check: () => Promise<void>, delayMS: number) => {
      setTimeout(() => {
        void check().catch(() => console.error("Runtime reconnect observation failed"));
      }, delayMS).unref();
    });
  return () => {
    if (armed) return;
    armed = true;
    for (const attempt of attempts) {
      if (attempt.state !== "ready" && attempt.state !== "starting") continue;
      schedule(
        async () => {
          const state = await ports.state(attempt.id);
          if (
            ["create-intended", "starting", "ready"].includes(state ?? "") &&
            !ports.connected(attempt.id)
          )
            await ports.disconnected(attempt.id);
        },
        attempt.state === "ready" ? 60_000 : 300_000,
      );
    }
  };
}
