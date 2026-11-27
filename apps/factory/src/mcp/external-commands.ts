import { z } from "zod";
import { workspaceCommandInput, workspaceCommandRead } from "#workspace-domain/commands";
import { type ExternalToolContext, lifecycleInput, workspaceInput } from "./external-schemas";

export function registerCommandTools({ services, actor, tool }: ExternalToolContext) {
  const { workspaceCommands } = services;
  const userID = actor.userID;

  tool(
    "runCommand",
    "Run a shell command in the native Work container, not locally or on the worker host. Reuse requestID for the same execution. Paused compute resumes; stopped/failed compute requires explicit Start. Returned completion is not Verification.",
    workspaceCommandInput,
    true,
    (input) => workspaceCommands.start(userID, input),
  );

  tool(
    "getCommand",
    "Observe a retained command ID without replaying it or waking compute. Retained observations may not be current.",
    z.strictObject({ commandID: z.uuid() }),
    false,
    ({ commandID }) => workspaceCommands.status(userID, commandID),
  );

  tool(
    "listWorkspaceCommands",
    "List recorded command and PTY identities, participants and compact outcomes without waking compute. These are retained observations, not proof that a process is still running. Use IDs to inspect or cancel an exact execution.",
    workspaceInput.extend({
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().positive().max(100).default(50),
    }),
    false,
    (input) => workspaceCommands.list(userID, input.workspaceID, input.offset, input.limit),
  );

  tool(
    "readCommandOutput",
    "Read bounded stdout/stderr with byte cursors. Resumes paused compute, but never restarts stopped compute. outputLost marks evicted history. Save full logs as a file deliberately.",
    workspaceCommandRead,
    true,
    (input) => workspaceCommands.read(userID, input),
  );

  tool(
    "cancelCommand",
    "Cancel the selected command, not other commands or Workspace compute. Does not guarantee termination of processes or jobs it detached.",
    z.strictObject({ commandID: z.uuid() }),
    true,
    ({ commandID }) => workspaceCommands.cancel(userID, commandID),
  );

  tool(
    "openTerminal",
    "Open a retained PTY in the same native Work container. Disconnect does not close it. Reuse requestID to observe the same shell, never to create another.",
    lifecycleInput,
    true,
    (input) =>
      workspaceCommands.start(
        userID,
        {
          requestID: input.requestID,
          workspaceID: input.workspaceID,
          command: "interactive-terminal",
          env: {},
        },
        "terminal",
      ),
  );

  tool(
    "readTerminal",
    "Read a bounded terminal page without stealing its browser attachment. Resumes paused compute. PTY stdout/stderr are merged. Advance cursor using stdoutNext; outputLost marks missing scrollback.",
    z.strictObject({
      terminalID: z.uuid(),
      cursor: z.number().int().nonnegative().default(0),
    }),
    true,
    (input) =>
      workspaceCommands.read(
        userID,
        { commandID: input.terminalID, stdout: input.cursor, stderr: 0 },
        "terminal",
      ),
  );

  tool(
    "writeTerminal",
    "Send terminal input once. Use a fresh requestID per deliberate input; never replay an unconfirmed input. Read the terminal to determine its effects.",
    z.strictObject({
      requestID: z.uuid(),
      terminalID: z.uuid(),
      input: z.string().max(8192),
    }),
    true,
    (input) => workspaceCommands.terminalOperation(userID, { ...input, action: "input" }),
  );

  tool(
    "resizeTerminal",
    "Set the selected PTY's dimensions, not the editor viewport.",
    z.strictObject({
      requestID: z.uuid(),
      terminalID: z.uuid(),
      columns: z.number().int().min(2).max(500),
      rows: z.number().int().min(1).max(500),
    }),
    true,
    (input) => workspaceCommands.terminalOperation(userID, { ...input, action: "resize" }),
  );

  tool(
    "closeTerminal",
    "Explicitly close one PTY shell, not shared compute. Detached jobs are not guaranteed to stop.",
    z.strictObject({ terminalID: z.uuid() }),
    true,
    ({ terminalID }) => workspaceCommands.cancel(userID, terminalID, "terminal"),
  );
}
