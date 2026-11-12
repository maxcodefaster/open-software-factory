import { z } from "zod";

// Installation-selected, finite Actor limits. Old provisioning facts without
// this field retain the exact limits rendered by their original template.
export const substrateResources = z.strictObject({
  cpuMilli: z.number().int().positive().max(1_000_000),
  memoryMiB: z.number().int().positive().max(10_000_000),
});

export function substrateResourceReservation(config: {
  resources?: z.infer<typeof substrateResources> | undefined;
}) {
  return config.resources
    ? substrateResources.parse(config.resources)
    : { cpuMilli: 1500, memoryMiB: 1024 };
}
