import { z } from "zod";

export const workspaceCommandInput = z.strictObject({
  requestID: z.uuid(),
  workspaceID: z.uuid(),
  command: z.string().min(1).max(65_536),
  cwd: z.string().min(1).max(4096).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(65_536)).default({}),
});

export const workspaceCommandRead = z.strictObject({
  commandID: z.uuid(),
  stdout: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  stderr: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
});

export type WorkspaceCommandInput = z.infer<typeof workspaceCommandInput>;
export type WorkspaceCommandRead = z.infer<typeof workspaceCommandRead>;
