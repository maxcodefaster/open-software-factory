import type { WorkspaceSourceState } from "../../../packages/workspace-domain/src/source";

export async function recoverWorkspaceSource(
  workspaceID: string,
  restart: boolean,
  signal: AbortSignal,
  commands: {
    stop(workspaceID: string, signal: AbortSignal): Promise<unknown>;
    read(workspaceID: string, signal: AbortSignal): Promise<{ state: WorkspaceSourceState }>;
    ensure(workspaceID: string, signal: AbortSignal): Promise<unknown>;
    wait(signal: AbortSignal): Promise<void>;
  },
) {
  signal.throwIfAborted();
  if (restart) {
    await commands.stop(workspaceID, signal);
    for (;;) {
      signal.throwIfAborted();
      const source = await commands.read(workspaceID, signal);
      signal.throwIfAborted();
      if (source.state === "stopped") break;
      if (source.state === "failed")
        throw new Error("File access Stop was not confirmed. Your files are retained.");
      await commands.wait(signal);
    }
  }
  signal.throwIfAborted();
  await commands.ensure(workspaceID, signal);
  signal.throwIfAborted();
}
