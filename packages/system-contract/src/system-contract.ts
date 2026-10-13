import { z } from "zod";

const appID = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,26}$/)
  .refine((value) => !["agent", "ide", "terminal", "verification"].includes(value), {
    message: "App id is reserved by Factory",
  });

const commandArgument = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !value.includes("\0"), { message: "Command contains a null byte" });

const command = z
  .array(commandArgument)
  .min(1)
  .max(32)
  .refine(
    (value) => {
      const executable = value[0]?.split("/").at(-1);
      return !["bash", "dash", "sh", "zsh"].includes(executable ?? "") || !value.includes("-c");
    },
    { message: "App commands cannot use a shell command string" },
  );

const healthPath = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      value.startsWith("/") &&
      !value.startsWith("//") &&
      !value.includes("?") &&
      !value.includes("#"),
    { message: "Health path must be one absolute path without query or fragment" },
  );

export const systemApp = z
  .object({
    id: appID,
    label: z.string().trim().min(1).max(64),
    command,
    port: z.number().int().min(1_024).max(65_535),
    healthPath,
  })
  .strict();

export const systemContract = z
  .object({
    version: z.literal(1),
    primaryApp: appID,
    apps: z.array(systemApp).min(1).max(4),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    const ports = new Set<number>();
    for (const [index, app] of value.apps.entries()) {
      if (ids.has(app.id)) {
        context.addIssue({
          code: "custom",
          message: `App id ${app.id} is duplicated`,
          path: ["apps", index, "id"],
        });
      }
      if (ports.has(app.port)) {
        context.addIssue({
          code: "custom",
          message: `App port ${app.port} is duplicated`,
          path: ["apps", index, "port"],
        });
      }
      ids.add(app.id);
      ports.add(app.port);
    }
    if (!ids.has(value.primaryApp)) {
      context.addIssue({
        code: "custom",
        message: "Primary App must name one declared App",
        path: ["primaryApp"],
      });
    }
  });

export type SystemContract = z.output<typeof systemContract>;

export class SystemContractError extends Error {
  override readonly name = "SystemContractError";
}

export function parseSystemContract(content: string): SystemContract {
  if (new TextEncoder().encode(content).byteLength > 64 * 1_024) {
    throw new SystemContractError(".factory/system.json exceeds 64 KiB");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(content);
  } catch {
    throw new SystemContractError(".factory/system.json is not valid JSON");
  }
  const parsed = systemContract.safeParse(decoded);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    throw new SystemContractError(
      `.factory/system.json is invalid${location}: ${issue?.message ?? "unknown error"}`,
    );
  }
  return parsed.data;
}

export function primarySystemApp(contract: SystemContract) {
  const app = contract.apps.find((candidate) => candidate.id === contract.primaryApp);
  if (!app) throw new SystemContractError("Primary App is not declared");
  return app;
}
