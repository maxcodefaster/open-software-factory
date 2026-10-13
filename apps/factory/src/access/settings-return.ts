import { z } from "zod";

const key = "factory:security-return";
const settingsReturn = z.object({
  userID: z.uuid(),
  project: z.object({ id: z.uuid(), name: z.string().max(200) }).optional(),
  scope: z.enum(["personal", "project", "system"]),
  category: z.enum(["people", "security"]),
});
export type SettingsReturn = z.output<typeof settingsReturn>;

export function rememberSettingsReturn(value: SettingsReturn) {
  sessionStorage.setItem(key, JSON.stringify(settingsReturn.parse(value)));
}

export function takeSettingsReturn(userID: string): SettingsReturn | undefined {
  const raw = sessionStorage.getItem(key);
  if (!raw) return;
  sessionStorage.removeItem(key);
  try {
    const value = settingsReturn.parse(JSON.parse(raw));
    if (value.userID === userID) return value;
  } catch {
    // Browser navigation state is optional and never grants Project authority.
  }
}
