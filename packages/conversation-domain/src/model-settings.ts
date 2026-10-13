import { z } from "zod";

export const modelIdInput = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\w./:-]+$/)
  .refine((id) => !id.includes("://"));
export const modelListInput = z
  .array(modelIdInput)
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length);
export const modelRuleInput = z
  .object({ models: modelListInput, allowOverride: z.boolean() })
  .strict();
export const modelRulesInput = z
  .object({ planning: modelRuleInput, build: modelRuleInput })
  .strict();
export const modelDefaultsInput = z
  .object({
    version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    planningModelId: modelIdInput,
    buildModelId: modelIdInput,
    rules: modelRulesInput.optional(),
  })
  .strict();

export const modelSettingsView = modelDefaultsInput.extend({
  rules: modelRulesInput,
  source: z.enum(["environment", "administrator"]),
  models: z.array(modelIdInput),
  connection: z.object({ configured: z.boolean(), host: z.string().nullable() }),
});
export type ModelSettingsView = z.infer<typeof modelSettingsView>;

export const modelConnectionResult = z.object({
  status: z.enum(["reachable", "unavailable", "unconfigured"]),
});

export function approvedModelCatalogue(input: {
  planningModelId: string;
  buildModelId: string;
  additionalIds?: string | undefined;
}) {
  return [
    ...new Set([
      input.planningModelId,
      input.buildModelId,
      ...(input.additionalIds
        ?.split(",")
        .map((id) => id.trim())
        .filter(Boolean) ?? []),
    ]),
  ].map((id) => modelIdInput.parse(id));
}
