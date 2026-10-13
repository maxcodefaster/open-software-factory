export type ProjectRole = "product-contributor" | "developer";

export function projectCapabilities(
  role: ProjectRole | "system-manager" | undefined,
  manageProject = false,
) {
  const develop = role === "developer" || role === "system-manager";
  return {
    contribute: develop || role === "product-contributor",
    develop,
    deliver: develop,
    manage: role === "system-manager" || (role !== undefined && manageProject),
  };
}
