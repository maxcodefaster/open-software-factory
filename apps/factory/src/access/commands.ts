import { z } from "zod";

export const managedUserInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    email: z.email().max(320),
    password: z.string().min(12).max(128),
  })
  .strict();

export const memberInput = z
  .object({
    email: z.email().max(320),
    role: z.enum(["developer", "product-contributor"]),
    manageProject: z.boolean().default(false),
  })
  .strict();

export const passwordChangeInput = z
  .object({
    currentPassword: z.string().min(1).max(1024),
    newPassword: z.string().max(1024),
    confirmPassword: z.string().max(1024),
  })
  .strict();
