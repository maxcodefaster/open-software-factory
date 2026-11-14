export async function recoverWorkspaceSource(
  workspaceID: string,
  signal: AbortSignal,
  commands: {
    ensure(workspaceID: string, signal: AbortSignal): Promise<unknown>;
  },
) {
  signal.throwIfAborted();
  await commands.ensure(workspaceID, signal);
  signal.throwIfAborted();
}
