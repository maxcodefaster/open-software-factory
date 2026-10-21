import { isolatedRuntimeOrigin } from "./runtime-origins";

export function developerIDEOrigin(factoryOrigin: string, userID: string, epoch: number) {
  const origin = new URL(factoryOrigin);
  const secure = origin.protocol === "https:";
  // Cookies do not distinguish ports. Keep both Factory and upstream Theia
  // cookies separate when local installations share an account and epoch.
  const listener = `${secure ? "s" : "h"}${origin.port || (secure ? "443" : "80")}`;
  return isolatedRuntimeOrigin(
    factoryOrigin,
    `${userID.replaceAll("-", "")}-${epoch}-${listener}-editor`,
  );
}
