import { z } from "zod";
import { desktopBackgroundKeys } from "../../../../packages/interface-domain/src/background";

export const uiPreferenceSchema = z.object({
  desktopBackgroundKey: z.enum(desktopBackgroundKeys),
});

export type UIPreference = z.infer<typeof uiPreferenceSchema>;
