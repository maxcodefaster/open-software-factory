import { expect, test } from "bun:test";
import type { MCPLibraryView } from "../../../../packages/conversation-domain/src/mcp-library";
import { monitoringSourceAvailable } from "./sources";

const source = {
  id: "source",
  scope: "project" as const,
  projectId: "project",
  ownerId: null,
  editable: true,
  revisions: [
    {
      id: "reviewed",
      revision: 1,
      digest: "a".repeat(64),
      content: {
        name: "Monitoring",
        description: "",
        endpoint: "https://source.example/mcp",
        provider: "custom" as const,
        authentication: "oauth" as const,
        roles: ["planning" as const, "build" as const],
      },
    },
  ],
  connection: {
    id: "source",
    revisionId: "reviewed",
    state: "ready" as const,
    version: 1,
    tools: [],
    allowedTools: ["read_issue"],
    projectGrants: [],
    editable: true,
  },
} satisfies MCPLibraryView["entries"][number];

test("monitoring setup and webhooks require the same reviewed shared Project source", () => {
  expect(monitoringSourceAvailable(source, "project")).toBe(true);
  expect(monitoringSourceAvailable(source, "another-project")).toBe(false);
  expect(monitoringSourceAvailable({ ...source, scope: "personal" }, "project")).toBe(false);
  expect(monitoringSourceAvailable({ ...source, connection: null }, "project")).toBe(false);
  for (const state of ["disconnected", "authorizing", "review", "reconnect", "revoked"] as const)
    expect(
      monitoringSourceAvailable(
        {
          ...source,
          connection: { ...source.connection, state },
        },
        "project",
      ),
    ).toBe(false);
  expect(
    monitoringSourceAvailable(
      {
        ...source,
        connection: { ...source.connection, allowedTools: [] },
      },
      "project",
    ),
  ).toBe(false);
});

test("Factory sources require a grant for this Project", () => {
  const shared = { ...source, scope: "system" as const, projectId: null };
  expect(monitoringSourceAvailable(shared, "project")).toBe(false);
  expect(
    monitoringSourceAvailable(
      {
        ...shared,
        connection: { ...source.connection, projectGrants: ["another-project"] },
      },
      "project",
    ),
  ).toBe(false);
  expect(
    monitoringSourceAvailable(
      {
        ...shared,
        connection: { ...source.connection, projectGrants: ["project"] },
      },
      "project",
    ),
  ).toBe(true);
});

test("eligibility follows the connected revision, not an unrelated newer definition", () => {
  const revision = source.revisions[0];
  if (!revision) throw new Error("Missing source fixture revision");
  expect(
    monitoringSourceAvailable(
      {
        ...source,
        revisions: [{ ...revision, id: "unconnected" }],
      },
      "project",
    ),
  ).toBe(false);
  const planning = {
    ...revision,
    content: { ...revision.content, roles: ["planning" as const] },
  };
  expect(monitoringSourceAvailable({ ...source, revisions: [planning] }, "project")).toBe(false);
  expect(
    monitoringSourceAvailable(
      {
        ...source,
        revisions: [{ ...planning, id: "newer", revision: 2 }, ...source.revisions],
      },
      "project",
    ),
  ).toBe(true);
});
