import { z } from "zod";
import { sessionSchema } from "../access/contracts";
import { uiPreferenceSchema } from "../preferences/contracts";

export const bootstrapSchema = z.object({
  session: sessionSchema.nullable(),
  uiPreference: uiPreferenceSchema,
  zeroCacheURL: z.string(),
  planningCacheScope: z.string().regex(/^[a-f0-9]{64}$/),
  forgeOrigins: z.object({ browser: z.string().url(), transport: z.string().url() }).optional(),
  modelRelayConfigured: z.boolean(),
  identity: z
    .object({ companySignIn: z.boolean(), sessionDays: z.number() })
    .default({ companySignIn: false, sessionDays: 7 }),
});

export type Bootstrap = z.infer<typeof bootstrapSchema>;
