import { describe, expect, test } from "bun:test";
import { personalWorkspaceIdentity, ticketWorkspaceIdentity } from "./workspace";

describe("Development Workspace identity", () => {
  const projectID = "20e65e28-8bad-4c05-a063-3b629808d549";
  const userID = "01994a7d-0000-7000-8000-000000000001";
  const changeID = "01994a7d-0000-7000-8000-000000000002";

  test("keeps one stable Personal Development Workspace per developer and Project", () => {
    const first = personalWorkspaceIdentity(projectID, userID);
    expect(first).toEqual(personalWorkspaceIdentity(projectID, userID));
    expect(first.workspaceID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(Object.keys(first)).toEqual(["workspaceID"]);
  });

  test("separates developers and Projects", () => {
    expect(personalWorkspaceIdentity(projectID, userID)).not.toEqual(
      personalWorkspaceIdentity(projectID, "01994a7d-0000-7000-8000-000000000003"),
    );
    expect(personalWorkspaceIdentity(projectID, userID)).not.toEqual(
      personalWorkspaceIdentity("01994a7d-0000-7000-8000-000000000004", userID),
    );
  });

  test("keeps one shared Ticket Workspace per Change", () => {
    expect(ticketWorkspaceIdentity(changeID)).toEqual(ticketWorkspaceIdentity(changeID));
    expect(ticketWorkspaceIdentity(changeID)).not.toEqual(
      ticketWorkspaceIdentity("01994a7d-0000-7000-8000-000000000005"),
    );
  });

  test("never aliases Personal Development and Ticket identity", () => {
    expect(personalWorkspaceIdentity(projectID, userID)).not.toEqual(
      ticketWorkspaceIdentity(`${projectID}:${userID}`),
    );
  });
});
