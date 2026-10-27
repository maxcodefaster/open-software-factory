import { z } from "zod";

export const deliveryDelegationInput = z.strictObject({
  commandId: z.uuid(),
  expectedPolicyId: z.uuid().nullable(),
  enabled: z.boolean(),
});
export const deliverySettingsView = z.object({
  policyId: z.uuid().nullable(),
  enabled: z.boolean(),
  delegatedBy: z.uuid().nullable(),
  canManage: z.boolean(),
  canDelegate: z.boolean(),
});
