import { z } from "zod";

export const containerFilePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => value.startsWith("/") && !value.includes("\0") && !value.split("/").includes(".."),
    "Use an absolute Dev Container path without traversal",
  )
  .refine(
    (value) =>
      value === "/" ||
      (!value.endsWith("/") && !value.includes("//") && !value.split("/").includes(".")),
    "Use a normalized absolute Dev Container path",
  );
export const fileVersion = z.string().regex(/^[0-9a-f]{64}$/);
export const workspaceTransferInput = z
  .strictObject({
    requestID: z.uuid(),
    workspaceID: z.uuid(),
    path: containerFilePath,
    direction: z.enum(["upload", "download"]),
    version: fileVersion.optional(),
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(128 << 20)
      .optional(),
    sha256: fileVersion.optional(),
  })
  .refine(
    (value) =>
      value.direction !== "upload" || (value.bytes !== undefined && value.sha256 !== undefined),
    "Upload needs byte length and SHA-256",
  );
export const containerFileMutation = z
  .strictObject({
    requestID: z.uuid(),
    workspaceID: z.uuid(),
    path: containerFilePath,
    action: z.enum(["mkdir", "delete", "rename"]),
    destination: containerFilePath.optional(),
    recursive: z.boolean().default(false),
    overwrite: z.boolean().default(false),
  })
  .refine(
    (value) => value.action !== "rename" || value.destination !== undefined,
    "Rename needs a destination",
  );

export type WorkspaceTransferInput = z.input<typeof workspaceTransferInput>;
export type ContainerFileMutation = z.input<typeof containerFileMutation>;
