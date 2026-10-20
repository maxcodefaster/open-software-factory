import { expect, test } from "bun:test";
import { projectModelConnection } from "../../apps/factory/src/project-agent/adapter";
import { createProjectAgentController } from "../../apps/factory/src/project-agent/controller";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";

test.skipIf(process.env["FACTORY_CODE_RESEARCH_LIVE"] !== "1")(
  "real Luna discovers and reads exact code; downgraded Contributors cannot see code-derived output",
  async () => {
    if (globalThis.process.env["FACTORY_PROJECT_AGENT_MODEL"] !== "gpt-6-luna")
      throw new Error("Explicit Luna planning configuration is required for this proof");
    projectModelConnection();
    const process = await factoryProcess();
    const db = process.connect();
    try {
      const owned = await fixture(undefined, undefined, db);
      const sha = "d".repeat(40);
      let discoveries = 0,
        reads = 0;
      const controller = createProjectAgentController(
        db,
        { start: async () => null },
        {
          codePaths: async () => {
            discoveries++;
            return { commitSha: sha, paths: ["src/server.ts"], truncated: false };
          },
          code: async (_projectID, value) => {
            reads++;
            const { codeReadInput } = await import("../../apps/factory/src/knowledge/code-read");
            const input = codeReadInput.parse(value);
            expect(input.path).toBe("src/server.ts");
            expect(input.commitSha).toBe(sha);
            return {
              ...input,
              body: "1: export function health() { return { status: 'ok', version: 7 }; }",
              truncated: false,
              url: `https://forge.test/source/${sha}/src/server.ts`,
            };
          },
        },
      );
      const result = await controller.message(
        owned.projectID,
        undefined,
        "Find and read the actual server code. What object does the health function return? Cite the inspected exact-commit file, not a Wiki or guess. Answer only; do not plan work.",
        owned.userID,
        crypto.randomUUID(),
      );
      const answer = result?.entries.findLast((entry) => entry.kind === "agent-message");
      expect(result?.turn?.modelId).toBe("gpt-6-luna");
      expect(answer?.body).toContain("7");
      expect(answer?.payload["visibility"]).toBe("developer");
      expect(answer?.citations).toContainEqual({
        source: "code",
        id: owned.projectID,
        label: expect.any(String),
        reference: expect.any(Number),
        commitSha: sha,
        path: "src/server.ts",
      });
      expect(discoveries).toBeGreaterThan(0);
      expect(reads).toBeGreaterThan(0);
      await db.client`UPDATE factory.project_membership SET role='product-contributor'
        WHERE project_id=${owned.projectID} AND user_id=${owned.userID}`;
      const contributor = await controller.get(owned.projectID, undefined, owned.userID);
      expect(contributor?.entries.some((entry) => entry.id === answer?.id)).toBe(false);
      expect(
        contributor?.entries.some((entry) =>
          entry.citations.some((citation) => citation.source === "code"),
        ),
      ).toBe(false);
      console.log({
        journey: "Exact-commit code research",
        discoveries,
        reads,
        permissionDowngradePreserved: true,
      });
    } finally {
      await db.client.end({ timeout: 0 });
      await process.dispose();
    }
  },
  90_000,
);
