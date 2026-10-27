import { expect, test } from "bun:test";
import { projectResearchTools } from "../../apps/factory/src/project-agent/build-tools";
import { readResearch, searchResearch } from "../../apps/factory/src/project-agent/research";
import { fixture } from "../fixtures/change-agent-turns";
import { fixtureValue } from "../fixtures/value";

test("Coding reads the same Project sources, pages exact versions and rejects changed scope or access", async () => {
  const owned = await fixture();
  const pageID = crypto.randomUUID();
  let allowed = true;
  const tools = projectResearchTools(owned.database, {
    projectID: owned.projectID,
    userID: owned.userID,
    signal: new AbortController().signal,
    authorize: async () => {
      if (!allowed) throw new Error("Owned execution was revoked");
    },
  });
  const search = fixtureValue(
    tools.find((tool) => tool.name === "search_project"),
    'tools.find((tool) => tool.name === "search_project")',
  );
  const read = fixtureValue(
    tools.find((tool) => tool.name === "read_project"),
    'tools.find((tool) => tool.name === "read_project")',
  );
  try {
    const body = `An exact research marker. ${"Authorized retained reference. ".repeat(1000)}`;
    await owned.database.client`INSERT INTO factory.knowledge_page(
      id,project_id,slug,title,current_body,generated_body,source_commit_sha,created_by)
      VALUES(${pageID},${owned.projectID},'research-marker','Exact research marker',
        ${body},${body},${"b".repeat(40)},${owned.userID})`;
    const results = JSON.parse((await search.run({ query: "Exact research marker" })).content);
    expect(results).toEqual(
      await searchResearch(owned.database, owned.projectID, owned.userID, "Exact research marker"),
    );
    expect(results).toContainEqual(expect.objectContaining({ id: pageID, source: "knowledge" }));
    const first = JSON.parse((await read.run({ source: "knowledge", id: pageID })).content);
    expect(first).toEqual(
      await readResearch(owned.database, owned.projectID, owned.userID, "knowledge", pageID),
    );
    expect(first.nextOffset).toBe(16000);
    await expect(read.run({ source: "knowledge", id: pageID, offset: 16000 })).rejects.toThrow(
      "expectedVersion",
    );
    await expect(
      read.run({ source: "knowledge", id: pageID, projectID: crypto.randomUUID() }),
    ).rejects.toThrow();
    await expect(read.run({ source: "knowledge", id: crypto.randomUUID() })).rejects.toThrow(
      "unavailable",
    );
    await owned.database
      .client`UPDATE factory.knowledge_page SET version=version+1 WHERE id=${pageID}`;
    await expect(
      read.run({ source: "knowledge", id: pageID, offset: 16000, expectedVersion: first.version }),
    ).rejects.toThrow("changed");
    allowed = false;
    await expect(search.run({ query: "Exact research marker" })).rejects.toThrow("revoked");
    allowed = true;
    await owned.database.client`DELETE FROM factory.project_membership
      WHERE project_id=${owned.projectID} AND user_id=${owned.userID}`;
    await expect(read.run({ source: "knowledge", id: pageID })).rejects.toThrow();
  } finally {
    await owned.database
      .client`DELETE FROM factory.knowledge_page WHERE id=${pageID} AND project_id=${owned.projectID}`;
    await owned.dispose();
  }
});
