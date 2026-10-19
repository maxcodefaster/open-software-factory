// A confirmed Stop is the boundary before a retained access service may start
// another epoch. The commands capture their target; navigation only cancels.
export async function confirmAccessStopped(
  signal: AbortSignal,
  commands: {
    stop(signal: AbortSignal): Promise<unknown>;
    read(signal: AbortSignal): Promise<{ state: string }>;
    wait(signal: AbortSignal): Promise<void>;
  },
  unconfirmedMessage: string,
) {
  signal.throwIfAborted();
  await commands.stop(signal);
  for (;;) {
    signal.throwIfAborted();
    const current = await commands.read(signal);
    signal.throwIfAborted();
    if (current.state === "stopped") return;
    if (current.state === "failed") throw new Error(unconfirmedMessage);
    await commands.wait(signal);
  }
}
