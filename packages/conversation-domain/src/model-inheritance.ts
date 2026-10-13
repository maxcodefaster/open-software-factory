import { z } from "zod";
import {
  modelIdInput,
  modelListInput,
  type modelRuleInput,
  modelSettingsView,
} from "./model-settings";

export const modelRoles = ["planning", "build"] as const;
export type ModelRole = (typeof modelRoles)[number];
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const projectRoleInput = z
  .object({
    modelId: modelIdInput.nullable(),
    models: modelListInput.nullable(),
    allowOverride: z.boolean().nullable(),
  })
  .strict();
export const projectModelInput = z
  .object({ version, planning: projectRoleInput, build: projectRoleInput })
  .strict();
export const personalModelInput = z
  .object({
    version,
    planningModelId: modelIdInput.nullable(),
    buildModelId: modelIdInput.nullable(),
  })
  .strict();
export type ProjectModelSettings = z.infer<typeof projectModelInput>;
export type PersonalModelSettings = z.infer<typeof personalModelInput>;
export const effectiveModelView = z.object({
  modelId: modelIdInput,
  models: z.array(modelIdInput),
  source: z.enum(["system", "project", "personal"]),
  allowOverride: z.boolean(),
  lockedReason: z.string().nullable(),
  ignoredReason: z.string().nullable(),
  available: z.boolean(),
});
export type EffectiveModel = z.infer<typeof effectiveModelView>;
export const inheritedModelSettingsView = z.object({
  system: modelSettingsView,
  project: projectModelInput,
  personal: personalModelInput,
  effective: z.object({ planning: effectiveModelView, build: effectiveModelView }),
  projectEffective: z.object({ planning: effectiveModelView, build: effectiveModelView }),
  canManageProject: z.boolean(),
});
export type InheritedModelSettingsView = z.infer<typeof inheritedModelSettingsView>;

export function resolveRoleModel(input: {
  systemModelId: string;
  systemRule: z.infer<typeof modelRuleInput>;
  catalogue: readonly string[];
  project: ProjectModelSettings[ModelRole];
  personalModelId: string | null;
}): EffectiveModel {
  const systemModels = input.systemRule.models.filter((id) => input.catalogue.includes(id));
  const models =
    input.project.models === null
      ? systemModels
      : systemModels.filter((id) => input.project.models?.includes(id));
  const projectDefault =
    input.systemRule.allowOverride &&
    input.project.modelId !== null &&
    models.includes(input.project.modelId)
      ? input.project.modelId
      : null;
  const inherited = projectDefault ?? input.systemModelId;
  const allowOverride = input.systemRule.allowOverride && input.project.allowOverride !== false;
  const personalAllowed =
    allowOverride && input.personalModelId !== null && models.includes(input.personalModelId);
  const modelId =
    personalAllowed && input.personalModelId !== null ? input.personalModelId : inherited;
  return {
    modelId,
    models,
    source: personalAllowed ? "personal" : projectDefault ? "project" : "system",
    allowOverride,
    lockedReason: !input.systemRule.allowOverride
      ? "Locked by System Manager"
      : input.project.allowOverride === false
        ? "Locked by Project Manager"
        : null,
    ignoredReason:
      input.personalModelId !== null && !personalAllowed
        ? "Your saved selection is not permitted by the current rules. Using the inherited default."
        : input.project.modelId !== null && !projectDefault
          ? "The saved Project default is not permitted by the current System rules."
          : null,
    available: models.includes(modelId),
  };
}
