import { z } from "zod";

export const repositoryMirrorCreate = z.strictObject({
  commandID: z.uuid(),
  targetURL: z.string().trim().min(1).max(2048),
  username: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\s:@/\\]+$/),
  token: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[^\r\n\0]+$/),
  confirmOverwrite: z.literal(true),
});
export const repositoryMirrorCommand = z.strictObject({
  commandID: z.uuid(),
});
export const repositoryMirrorRemove = repositoryMirrorCommand.extend({
  remoteName: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
  targetURL: z.string().min(1).max(2048),
});

export type RepositoryMirror = {
  remoteName: string;
  targetURL: string;
  syncOnCommit: boolean;
  interval: string;
  branchFilter: string;
  lastAttempt: string | null;
  failed: boolean;
};
export type RepositoryMirrorProject = { id: string; name: string };
export type RepositoryMirrorView = {
  projectID: string;
  mirrors: RepositoryMirror[];
  pending: { commandID: string; action: "create" | "remove" | "sync" } | null;
};
