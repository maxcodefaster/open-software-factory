import { z } from "zod";
import { CommandError } from "../command-error";
import { workspaceSubmissionInput } from "../workspace/api";
import { type ExternalToolContext, lifecycleInput, workspaceInput } from "./external-schemas";

export function registerDocumentTools({ services, actor, tool }: ExternalToolContext) {
  const userID = actor.userID;

  tool(
    "inspectWorkspaceSubmission",
    "Observe the saved Ticket checkout HEAD, remote branch and changed files before explicitly submitting. This does not save shared buffers or approve anything.",
    workspaceInput,
    false,
    (input) => services.workspaceSubmission.inspect(userID, input.workspaceID),
  );

  tool(
    "submitWorkspace",
    "Explicitly capture the saved shared Ticket checkout and submit its exact commit for Verification and independent review. This grants no approval or Delivery authority. Unsaved shared buffers must be saved first.",
    workspaceSubmissionInput,
    true,
    (input) => services.workspaceSubmission.submit(userID, input),
  );

  tool(
    "getWorkspaceSubmission",
    "Observe an immutable shared Ticket submission without replaying commit or push.",
    z.strictObject({ requestID: z.uuid() }),
    false,
    (input) => services.workspaceSubmission.observe(userID, input.requestID),
  );

  tool(
    "enableSharedEditing",
    "Enable collaborative document editing for this Workspace. Ticket editing remains bounded by the current human editing phase; this grants no approval or Delivery authority.",
    lifecycleInput,
    true,
    (input) => services.workspaceCollaboration.enable(userID, input.workspaceID, input.requestID),
  );

  tool(
    "readSharedDocument",
    "Read the shared editor buffer, including unsaved edits. This is not necessarily the saved checkout. Use its revision when editing.",
    workspaceInput.extend({
      path: z.string().min(1).max(4096),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().positive().max(16384).default(8192),
      expectedRevision: z.string().optional(),
    }),
    false,
    async (input) => {
      const value = await services.workspaceCollaboration.read(
        userID,
        input.workspaceID,
        input.path,
      );
      if (input.expectedRevision && input.expectedRevision !== value.revision)
        throw new CommandError("conflict", "Shared document changed between pages");
      const end = Math.min(value.content.length, input.offset + input.limit);
      return {
        ...value,
        content: value.content.slice(input.offset, end),
        savedContent: value.conflict
          ? value.savedContent.slice(input.offset, input.offset + input.limit)
          : undefined,
        offset: input.offset,
        nextOffset: end < value.content.length ? end : null,
      };
    },
  );

  tool(
    "editSharedDocument",
    "Apply UTF-16-offset edits to the exact observed shared buffer. Stale revisions conflict; this does not save to disk or submit a Ticket.",
    workspaceInput.extend({
      path: z.string().min(1).max(4096),
      revision: z.string(),
      edits: z
        .array(
          z.strictObject({
            offset: z.number().int().nonnegative(),
            deleteCount: z.number().int().nonnegative(),
            text: z.string().max(65536),
          }),
        )
        .min(1)
        .max(100),
    }),
    true,
    (input) =>
      services.workspaceCollaboration.edit(
        { userID, sessionID: actor.sessionID, kind: "agent", oauthClientID: actor.clientID },
        input.workspaceID,
        { path: input.path, revision: input.revision, edits: input.edits },
      ),
  );

  tool(
    "saveSharedDocument",
    "Save the exact synchronized shared buffer to canonical source. External disk changes never silently overwrite an unsaved shared buffer.",
    workspaceInput.extend({ path: z.string().min(1).max(4096), revision: z.string() }),
    true,
    (input) =>
      services.workspaceCollaboration.save(userID, input.workspaceID, {
        path: input.path,
        revision: input.revision,
      }),
  );

  tool(
    "getWorkspaceParticipants",
    "List currently connected people and agents in the shared editor, with authenticated identities and document cursors. Presence is temporary.",
    workspaceInput,
    false,
    (input) => services.workspaceCollaboration.participants(input.workspaceID, userID),
  );

  tool(
    "resolveSharedDocument",
    "Record an explicit decision after comparing shared and saved content. keep-shared keeps the buffer for a later deliberate Save; use-saved replaces the shared buffer for every participant. Requires both exact observed versions.",
    workspaceInput.extend({
      requestID: z.uuid(),
      path: z.string().min(1).max(4096),
      revision: z.string(),
      diskVersion: z.string(),
      choice: z.enum(["keep-shared", "use-saved"]),
    }),
    true,
    (input) =>
      services.workspaceCollaboration.resolve(userID, input.workspaceID, {
        requestID: input.requestID,
        path: input.path,
        revision: input.revision,
        diskVersion: input.diskVersion,
        choice: input.choice,
      }),
  );
}
