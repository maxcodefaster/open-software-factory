type ServerProcess = Pick<ReturnType<typeof Bun.spawn>, "exitCode" | "exited">;

export async function waitForFactory(input: {
  server: ServerProcess;
  baseURL: string;
  startupID: string;
  timeoutMS?: number;
  requestTimeoutMS?: number;
  intervalMS?: number;
}) {
  const deadline = Date.now() + (input.timeoutMS ?? 180_000);
  const exited = input.server.exited.then(() => {
    throw new Error("Factory server exited before readiness");
  });
  // Keep the exit observer handled when readiness wins the race.
  void exited.catch(() => {});
  while (Date.now() < deadline) {
    if (input.server.exitCode !== null) throw new Error("Factory server exited before readiness");
    const response = await Promise.race([
      exited,
      fetch(`${input.baseURL}/api/session`, {
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(input.requestTimeoutMS ?? 1_000, deadline - Date.now())),
        ),
        redirect: "error",
      }).catch(() => null),
    ]);
    if (input.server.exitCode !== null) throw new Error("Factory server exited before readiness");
    const ready =
      response?.ok &&
      response.headers.get("x-open-factory") === "ready" &&
      response.headers.get("x-open-factory-startup") === input.startupID;
    await response?.body?.cancel();
    if (ready) return;
    await Promise.race([
      exited,
      Bun.sleep(Math.max(1, Math.min(input.intervalMS ?? 250, deadline - Date.now()))),
    ]);
  }
  if (input.server.exitCode !== null) throw new Error("Factory server exited before readiness");
  throw new Error("Factory server did not become ready");
}
