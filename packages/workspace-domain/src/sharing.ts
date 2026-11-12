import { z } from "zod";

export const workspacePermission = z.enum(["observe", "collaborate"]);

export const workspaceShareInput = z.strictObject({
  commandID: z.uuid(),
  workspaceID: z.uuid(),
  userID: z.uuid(),
  permission: workspacePermission.nullable(),
  expectedVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export const workspaceShareView = z.strictObject({
  workspaceID: z.uuid(),
  userID: z.uuid(),
  permission: workspacePermission.nullable(),
  version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export type WorkspacePermission = z.infer<typeof workspacePermission>;
export type WorkspaceShareInput = z.infer<typeof workspaceShareInput>;
