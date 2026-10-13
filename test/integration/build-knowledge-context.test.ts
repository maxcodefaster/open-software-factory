import { expect, test } from "bun:test";
import { createChangeAdmission } from "../../apps/factory/src/agent/change-admission";
import { buildModelID, fixture } from "../fixtures/change-agent-turns";

test("Build freezes only authorized active Project Knowledge in its exact dispatch input", async () => {
  const owned = await fixture();
  const pageID = crypto.randomUUID();
  const revisionID = crypto.randomUUID();
  const archivedID = crypto.randomUUID();
  const otherProjectID = crypto.randomUUID();
  const otherPageID = crypto.randomUUID();
  try {
    await owned.database.client`INSERT INTO factory.project(id, slug, name, repository_url,
      default_branch, devcontainer_path, created_by) VALUES(${otherProjectID}, ${`knowledge-denial-${otherProjectID}`},
      'Other Project', 'https://example.invalid/other.git', 'main', '.devcontainer/devcontainer.json', ${owned.userID})`;
    for (const [id, projectID, state, body] of [
      [pageID, owned.projectID, "active", "The starter preview uses the declared web App."],
      [archivedID, owned.projectID, "archived", "ARCHIVED MUST NOT ENTER BUILD"],
      [otherPageID, otherProjectID, "active", "OTHER PROJECT MUST NOT ENTER BUILD"],
    ] as const) {
      await owned.database.client`INSERT INTO factory.knowledge_page(id, project_id, slug, title,
        current_body, generated_body, source_commit_sha, state, created_by)
        VALUES (${id}, ${projectID}, ${`page-${id}`}, 'Starter preview', ${body}, ${body}, ${"a".repeat(40)},
          ${state}::factory.knowledge_page_state, ${owned.userID})`;
    }
    await owned.database.client`INSERT INTO factory.knowledge_revision(id, page_id, ordinal, kind,
      title, body, generated_body, source_commit_sha, created_by) VALUES(${revisionID}, ${pageID}, 1,
      'human', 'Starter preview', 'The starter preview uses the declared web App.',
      'The starter preview uses the declared web App.', ${"a".repeat(40)}, ${owned.userID})`;
    await owned.database
      .client`UPDATE factory.knowledge_page SET current_revision_id = ${revisionID} WHERE id = ${pageID}`;
    const admission = createChangeAdmission(owned.database, buildModelID);
    const commandId = crypto.randomUUID();
    const request = {
      kind: "change-prompt" as const,
      commandId,
      text: "Explain the starter preview without changing files",
    };
    const turn = await admission.admit(owned.changeID, owned.userID, request);
    const intent = await admission.intent(turn.turn.id);
    expect(intent.text).toContain(pageID);
    expect(intent.text).toContain(revisionID);
    expect(intent.text).toContain("The starter preview uses the declared web App.");
    expect(intent.text).not.toContain("ARCHIVED MUST NOT ENTER BUILD");
    expect(intent.text).not.toContain("OTHER PROJECT MUST NOT ENTER BUILD");
    expect(intent.text).toContain("without editing files");
    await owned.database
      .client`UPDATE factory.knowledge_page SET current_body = 'Replaced knowledge' WHERE id = ${pageID}`;
    await admission.admit(owned.changeID, owned.userID, request);
    expect((await admission.intent(turn.turn.id)).text).toBe(intent.text);
    await expect(
      admission.admit(owned.changeID, crypto.randomUUID(), {
        ...request,
        commandId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 404 });
  } finally {
    await owned.database.client.begin(async (sql) => {
      await sql`SET LOCAL session_replication_role = 'replica'`;
      await sql`DELETE FROM factory.knowledge_revision WHERE page_id IN (${pageID}, ${archivedID}, ${otherPageID})`;
      await sql`DELETE FROM factory.knowledge_page WHERE id IN (${pageID}, ${archivedID}, ${otherPageID})`;
      await sql`DELETE FROM factory.project WHERE id = ${otherProjectID}`;
    });
    await owned.dispose();
  }
});
