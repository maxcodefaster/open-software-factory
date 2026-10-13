import { z } from "zod";

export const identityConfiguration = z
  .object({
    mode: z.enum(["local", "oidc"]),
    sessionDays: z.number().int().min(1).max(30),
    issuer: z.url().max(2048).optional(),
    clientID: z.string().trim().min(1).max(512).optional(),
    clientSecret: z.string().min(16).max(4096).optional(),
    domain: z.string().trim().min(1).max(253).optional(),
    directoryToken: z.string().min(32).max(4096).optional(),
    directorySubjectClaim: z
      .string()
      .regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/)
      .default("oid"),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.mode === "oidc" &&
      (!value.issuer || !value.clientID || !value.clientSecret || !value.domain)
    )
      context.addIssue({
        code: "custom",
        message: "Company sign-in requires issuer, client ID, client secret and domain",
      });
    if (
      value.mode === "local" &&
      (value.issuer || value.clientID || value.clientSecret || value.directoryToken)
    )
      context.addIssue({
        code: "custom",
        message: "Local sign-in does not use provider credentials",
      });
  });
export const identityConfigurationWrite = z
  .object({
    commandID: z.uuid(),
    version: z.number().int().nonnegative(),
    configuration: identityConfiguration,
  })
  .strict();
export type IdentityConfiguration = z.output<typeof identityConfiguration>;
export function identityMetadata(configuration: IdentityConfiguration) {
  const {
    clientSecret: _clientSecret,
    directoryToken: _directoryToken,
    ...metadata
  } = configuration;
  return { ...metadata, directoryEnabled: Boolean(configuration.directoryToken) };
}
export const identityConfigurationView = z.object({
  version: z.number().int().nonnegative(),
  mode: z.enum(["local", "oidc"]),
  sessionDays: z.number().int().min(1).max(30),
  issuer: z.string().nullable(),
  clientID: z.string().nullable(),
  domain: z.string().nullable(),
  directoryEnabled: z.boolean(),
  storeConfigured: z.boolean(),
  candidates: z.array(
    z.object({
      commandID: z.uuid(),
      mode: z.enum(["local", "oidc"]),
      issuer: z.string().nullable(),
      state: z.enum(["write-intended", "saved", "active", "superseded"]),
      tested: z.boolean(),
    }),
  ),
});
