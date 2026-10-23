import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { createMCPConnections } from "../../apps/factory/src/mcp/connections";
import { mcpDigest } from "../../apps/factory/src/mcp/controller";
import { factoryProcess } from "../fixtures/factory-process";

const live = process.env["FACTORY_RUN_MCP_LIVE_PROOF"] === "1";
test.skipIf(!live)(
  "a real public HTTPS MCP source passes Factory connection, review, grant and bounded read",
  async () => {
    const fixture = await factoryProcess();
    const database = fixture.connect();
    const manager = crypto.randomUUID();
    const project = crypto.randomUUID();
    const id = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const connections = createMCPConnections(
      database,
      {
        configured: false,
        read: async () => undefined,
        create: async () => {
          throw new Error("The public MCP source must not need credentials");
        },
      },
      "owned-public-mcp-proof",
      "https://factory.example",
    );
    try {
      await database.client`INSERT INTO auth."user"(id,name,email,email_verified)
      VALUES(${manager},'Owned public MCP proof',${`${manager}@public-mcp.test`},true)`;
      await database.client`INSERT INTO factory.administrator(user_id) VALUES(${manager})`;
      await database.client`INSERT INTO factory.project(id,slug,name,repository_url,default_branch,devcontainer_path,created_by)
      VALUES(${project},${`public-mcp-${project}`},'Owned public MCP proof','https://example.invalid/owned.git','main','.devcontainer/devcontainer.json',${manager})`;
      await connections.library.save(
        {
          libraryId: id,
          revisionId,
          expectedRevision: 0,
          scope: "system",
          content: {
            name: "Microsoft Learn",
            description: "Read public Microsoft documentation",
            endpoint: "https://learn.microsoft.com/api/mcp",
            provider: "custom",
            authentication: "none",
            roles: ["planning", "build"],
          },
        },
        manager,
      );
      await connections.connect(id, manager, {
        commandId: crypto.randomUUID(),
        revisionId,
        expectedVersion: 0,
      });
      const connection = await database.client.begin((sql) =>
        connections.library.connectionIn(sql, id),
      );
      const tool = connection.tools.find((tool) => tool.name === "microsoft_docs_fetch");
      if (!tool)
        throw new Error("Microsoft Learn no longer offers the expected public document read");
      await connections.library.review(id, manager, connection.version, [
        { name: tool.name, digest: tool.digest },
      ]);
      await connections.library.grant(id, project, manager, true, connection.version + 1);
      const result = await connections.call(
        {
          connectionId: id,
          credentialEpoch: connection.credentialEpoch,
          revisionId,
          policyVersion: connection.version + 1,
          tools: [tool],
          required: true,
        },
        project,
        manager,
        tool.name,
        {
          url: "https://learn.microsoft.com/en-us/training/support/mcp-developer-reference",
        },
        async () => {},
        new AbortController().signal,
      );
      expect(result.isError).toBe(false);
      expect(result.content.toLowerCase()).toContain("mcp");
      const evidence = `.factory/test-results/mcp-public/${fixture.id}`;
      await mkdir(evidence, { recursive: true });
      await writeFile(
        `${evidence}/result.json`,
        JSON.stringify(
          {
            endpoint: "https://learn.microsoft.com/api/mcp",
            observedAt: new Date().toISOString(),
            tools: connection.tools.map(({ name, digest }) => ({ name, digest })),
            calledTool: tool.name,
            readOnlyApproval: true,
            projectGrant: true,
            resultBytes: Buffer.byteLength(result.content),
            resultDigest: mcpDigest(result.content),
            isError: result.isError,
          },
          null,
          2,
        ),
      );
    } finally {
      await database.client.end();
      await fixture.dispose();
    }
  },
  120_000,
);
