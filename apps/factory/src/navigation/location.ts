export type FactoryLocation =
  | { view: "home" }
  | { view: "project"; projectID: string }
  | { view: "ticket"; projectID: string; ticketID: string }
  | { view: "knowledge"; projectID: string; pageID?: string }
  | { view: "inbox" }
  | { view: "settings"; projectID?: string }
  | { view: "unavailable" };

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function factoryLocation(path: string): FactoryLocation {
  if (!path.startsWith("/") || path.includes("//")) return { view: "unavailable" };
  const pathname = path.replace(/\/$/, "") || "/";
  if (pathname === "/") return { view: "home" };
  if (pathname === "/inbox") return { view: "inbox" };
  if (pathname === "/settings") return { view: "settings" };
  let parts: string[];
  try {
    parts = pathname.slice(1).split("/").map(decodeURIComponent);
  } catch {
    return { view: "unavailable" };
  }
  const [, projectID, resource, id] = parts;
  if (parts[0] !== "projects" || !projectID || !uuid.test(projectID))
    return { view: "unavailable" };
  if (parts.length === 2) return { view: "project", projectID };
  if (parts.length === 3 && resource === "settings") return { view: "settings", projectID };
  if (parts.length === 3 && resource === "wiki") return { view: "knowledge", projectID };
  if (parts.length !== 4 || !id || !uuid.test(id)) return { view: "unavailable" };
  if (resource === "tickets") return { view: "ticket", projectID, ticketID: id };
  if (resource === "wiki") return { view: "knowledge", projectID, pageID: id };
  return { view: "unavailable" };
}

export function factoryPath(location: Exclude<FactoryLocation, { view: "unavailable" }>): string {
  switch (location.view) {
    case "home":
      return "/";
    case "inbox":
      return "/inbox";
    case "project":
      return `/projects/${location.projectID}`;
    case "ticket":
      return `/projects/${location.projectID}/tickets/${location.ticketID}`;
    case "knowledge":
      return `/projects/${location.projectID}/wiki${location.pageID ? `/${location.pageID}` : ""}`;
    case "settings":
      return location.projectID ? `/projects/${location.projectID}/settings` : "/settings";
  }
}
