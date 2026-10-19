import type { WorkspaceSourceState } from "../../../packages/workspace-domain/src/source";
import { confirmAccessStopped } from "./access-stop";

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
  if (restart)
    await confirmAccessStopped(
      signal,
      {
        stop: (signal) => commands.stop(workspaceID, signal),
        read: (signal) => commands.read(workspaceID, signal),
        wait: commands.wait,
      },
      "File access Stop was not confirmed. Your files are retained.",
    );
  signal.throwIfAborted();
  await commands.ensure(workspaceID, signal);
  signal.throwIfAborted();
}
