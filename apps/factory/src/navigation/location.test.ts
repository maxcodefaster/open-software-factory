import { expect, test } from "bun:test";
import { type FactoryLocation, factoryLocation, factoryPath } from "./location";

const projectID = "00000000-0000-4000-8000-000000000001";
const resourceID = "00000000-0000-4000-8000-000000000002";

test("resource URLs round trip without tab state, drafts or runtime capabilities", () => {
  const destinations: Exclude<FactoryLocation, { view: "unavailable" }>[] = [
    { view: "home" },
    { view: "inbox" },
    { view: "settings" },
    { view: "settings", projectID },
    { view: "project", projectID },
    { view: "ticket", projectID, ticketID: resourceID },
    { view: "knowledge", projectID },
    { view: "knowledge", projectID, pageID: resourceID },
  ];
  for (const destination of destinations) {
    const path = factoryPath(destination);
    expect(factoryLocation(path)).toEqual(destination);
    if (path !== "/") expect(factoryLocation(`${path}/`)).toEqual(destination);
    expect(path).not.toMatch(/[?#]/);
  }
});

test("malformed and unsupported resource URLs never select a different item", () => {
  for (const path of [
    "/projects/not-a-uuid",
    `/projects/${projectID}/tickets/not-a-uuid`,
    `/projects/${projectID}/wiki/%`,
    `/projects/${projectID}/wiki/%2F`,
    `/projects/${projectID}/wiki/${resourceID}/edit`,
    `/projects/${projectID}/settings/${resourceID}`,
    `/projects/${projectID}/unknown/${resourceID}`,
    "//",
    "/missing",
  ])
    expect(factoryLocation(path)).toEqual({ view: "unavailable" });
});
