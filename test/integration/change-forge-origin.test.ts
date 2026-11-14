import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createChangeController } from "../../apps/factory/src/change/controller";
import type { createForgejoClient } from "../../packages/forge/src/forge";
import { canonicalRequirementContent } from "../../packages/requirement-domain/src/requirement";
import { eventually, factoryProcess } from "../fixtures/factory-process";

test("Change admission accepts the configured public Forge behind a private API and rejects foreign repository identities before Forge writes", async () => {
  const fixture = await factoryProcess();
  const database = fixture.connect();
  const configuration = {
    FACTORY_FORGEJO_API_URL: "http://forge-control.native.test:3000/api/v1/",
    FACTORY_FORGEJO_PUBLIC_URL: "https://git.native.test",
    FACTORY_FORGEJO_TOKEN: "owned-no-external-forge-token",
    FACTORY_FORGEJO_OWNER: "owned",
  };
  const previous = new Map(Object.keys(configuration).map((key) => [key, process.env[key]]));
  const userID = crypto.randomUUID();
  const sha = "a".repeat(40);
  let forgeCalls = 0;
  const forge = {
    async getDefaultBranch() {
      forgeCalls++;
      return { name: "main", headSha: sha };
    },
    async getBranch(_repository: unknown, name: string) {
      forgeCalls++;
      return { name, headSha: sha };
    },
    async ensureBranch(repository: { owner: string; name: string }, name: string) {
      forgeCalls++;
      expect(repository).toEqual({ owner: "owned", name: "repo" });
      return { name, headSha: sha };
    },
  } as unknown as ReturnType<typeof createForgejoClient>;
  try {
    await database.client`INSERT INTO auth."user"(id,name,email)
      VALUES(${userID},'Native origin fixture',${`${userID}@factory.invalid`})`;
    Object.assign(process.env, configuration);
    const changes = createChangeController(
      database,
      {
        async stop() {
          throw Error("Origin admission cannot stop compute");
        },
      },
      undefined,
      undefined,
      forge,
    );
    // Installation identities belong to this controller lifetime, not a later
    // ambient environment mutation or another owned fixture.
    process.env["FACTORY_FORGEJO_PUBLIC_URL"] = "https://foreign.native.test";
    for (const [repositoryURL, allowed] of [
      ["https://git.native.test/owned/repo.git", true],
      ["http://forge-control.native.test:3000/owned/repo.git", true],
      ["https://foreign.native.test/owned/repo.git", false],
      ["https://git.native.test.foreign.test/owned/repo.git", false],
      ["http://git.native.test/owned/repo.git", false],
      ["https://git.native.test:8443/owned/repo.git", false],
      ["https://user:owned@git.native.test/owned/repo.git", false],
      ["https://git.native.test/prefix/owned/repo.git", false],
      ["https://git.native.test/owned/repo%2Fforeign.git", false],
      ["https://git.native.test/owned/repo.git?source=other", false],
      ["https://git.native.test/owned/repo.git#source", false],
      ["https://git.native.test/foreign/repo.git", false],
    ] as const) {
      const projectID = crypto.randomUUID(),
        ticketID = crypto.randomUUID(),
        revisionID = crypto.randomUUID();
      const content = canonicalRequirementContent({
        summary: "Verify configured Forge origin admission",
        acceptanceCriteria: ["Only the installation's exact Forge identities are admitted"],
        nonGoals: [],
      });
      await database.client.begin(async (sql) => {
        await sql`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
          VALUES(${projectID},${`forge-origin-${projectID}`},'Origin fixture',${repositoryURL},
            'main','.devcontainer/devcontainer.json',${userID})`;
        await sql`INSERT INTO factory.project_membership(project_id,user_id,role,updated_by)
          VALUES(${projectID},${userID},'developer',${userID})`;
        await sql`INSERT INTO factory.ticket(id,project_id,title,created_by)
          VALUES(${ticketID},${projectID},'Origin fixture',${userID})`;
        await sql`INSERT INTO factory.requirement_revision(id,ticket_id,ordinal,canonical_content,content_digest,created_by)
          VALUES(${revisionID},${ticketID},1,${content},${createHash("sha256").update(content).digest("hex")},${userID})`;
        await sql`INSERT INTO factory.requirement_approval(id,ticket_id,requirement_revision_id,approved_by)
          VALUES(${crypto.randomUUID()},${ticketID},${revisionID},${userID})`;
      });
      const before = forgeCalls;
      if (allowed) {
        const change = await changes.start(ticketID, userID);
        if (!change) throw Error("Configured Forge origin was not admitted");
        await eventually(
          () => changes.get(change.id),
          (current) => current?.state === "active",
          "Origin fixture branch reconciliation did not finish",
        );
        expect(forgeCalls).toBeGreaterThan(before);
      } else {
        await expect(changes.start(ticketID, userID)).rejects.toThrow();
        expect(forgeCalls).toBe(before);
        expect(
          await database.client`SELECT id FROM factory.change WHERE ticket_id=${ticketID}`,
        ).toHaveLength(0);
      }
    }
  } finally {
    for (const [key, value] of previous)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await database.client.end({ timeout: 1 });
    await fixture.dispose();
  }
}, 60_000);
