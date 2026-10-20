type ForwardProcess = Pick<ReturnType<typeof Bun.spawn>, "exitCode" | "exited">;

export async function waitForRegistry(input: {
  forward: ForwardProcess;
  host: string;
  caFile: string;
  timeoutMS?: number;
}) {
  // kubectl permits a minute for its target Pod to become available. Its
  // forwarding setup must fit inside this check too, not just the HTTPS probe.
  const timeoutMS = input.timeoutMS ?? 60_000;
  const deadline = Date.now() + timeoutMS;
  const exited = input.forward.exited.then(() => {
    throw new Error(
      "Registry port-forward exited before readiness; check its local port and cluster connection",
    );
  });
  void exited.catch(() => {});
  while (Date.now() < deadline) {
    if (input.forward.exitCode !== null)
      throw new Error(
        "Registry port-forward exited before readiness; check its local port and cluster connection",
      );
    const seconds = String(Math.max(0.001, Math.min(1_000, deadline - Date.now()) / 1_000));
    const probe = Bun.spawn(
      [
        "curl",
        "--fail",
        "--silent",
        "--connect-timeout",
        seconds,
        "--max-time",
        seconds,
        "--cacert",
        input.caFile,
        `https://${input.host}/v2/`,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    try {
      const status = await Promise.race([probe.exited, exited]);
      if (input.forward.exitCode !== null)
        throw new Error("Registry port-forward exited before readiness");
      if (status === 0) return;
    } finally {
      if (probe.exitCode === null) probe.kill();
      await probe.exited;
    }
    if (Date.now() < deadline)
      await Promise.race([Bun.sleep(Math.min(250, deadline - Date.now())), exited]);
  }
  throw new Error(
    `Registry forwarding or HTTPS readiness was not confirmed within ${timeoutMS / 1000}s`,
  );
}
