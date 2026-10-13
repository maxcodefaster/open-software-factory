export const desktopBackgroundKeys = [
  "river-landscape",
  "the-harvesters",
  "mountainous-landscape",
] as const;

export type DesktopBackgroundKey = (typeof desktopBackgroundKeys)[number];

export const defaultDesktopBackgroundKey: DesktopBackgroundKey = "river-landscape";

export function isDesktopBackgroundKey(value: unknown): value is DesktopBackgroundKey {
  return typeof value === "string" && desktopBackgroundKeys.includes(value as DesktopBackgroundKey);
}
