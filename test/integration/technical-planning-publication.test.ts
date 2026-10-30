import { expect, test } from "bun:test";
import { createTicketDocumentController } from "../../apps/factory/src/change/document";
import { codeReadInput } from "../../apps/factory/src/knowledge/code-read";
import { createProjectAgentController } from "../../apps/factory/src/project-agent/controller";
import { technicalPlanningOutstandingIn } from "../../apps/factory/src/technical-design/store";
import { fixture } from "../fixtures/change-agent-turns";
import { factoryProcess } from "../fixtures/factory-process";

test("the real planning controller publishes a source-grounded design when its optional diagram cannot render", async () => {
  const host = await factoryProcess();
  const database = host.connect();
  const owned = await fixture(undefined, undefined, database);
  const ticketID = crypto.randomUUID();
  const commitSha = "a".repeat(40);
  const content = {
    context: "The existing setup unnecessarily requires private migration references.",
    proposedChanges: "Keep normal dependency setup separate from explicit reference downloads.",
    decisions: ["Preserve every existing verification assertion."],
    assumptions: [],
    risks: [],
    validation: [{ criterion: 1, check: "Run setup without private repository access." }],
    diagrams: [
      {
        title: "Optional setup overview",
        description: "The exact diagram source remains available if rendering fails.",
        source: "@startuml\nthis is invalid syntax\n@enduml",
      },
    ],
  };
  let requests = 0;
  let reads = 0;
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { stream?: boolean };
      requests++;
      const discovering = requests === 1;
      const reading = requests === 2;
      const tooling = discovering || reading;
      const message = tooling
        ? {
            role: "assistant",
            tool_calls: [
              {
                id: "read-owned-setup",
                type: "function",
                function: {
                  name: discovering ? "findCode" : "readCode",
                  arguments: JSON.stringify(
                    discovering
                      ? { query: "tools/setup.mjs" }
                      : {
                          path: "tools/setup.mjs",
                          commitSha,
                          startLine: 1,
                          lineCount: 20,
                        },
                  ),
                },
              },
            ],
          }
        : {
            role: "assistant",
            content: JSON.stringify({
              output: {
                kind: "technical-design",
                message:
                  "The implementation plan preserves the existing setup and check boundaries.",
                design: content,
                citations: [
                  {
                    source: "code",
                    id: owned.projectID,
                    label: "Inspected setup helper",
                    path: "tools/setup.mjs",
                    commitSha,
                    reference: 1,
                  },
                ],
              },
            }),
          };
      const common = { id: `owned-planning-${requests}`, created: 1, model: "owned-planning" };
      const finishReason = tooling ? "tool_calls" : "stop";
      if (!body.stream)
        return Response.json({
          ...common,
          object: "chat.completion",
          choices: [{ index: 0, message, finish_reason: finishReason }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      return new Response(
        `${[
          {
            ...common,
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: tooling
                  ? {
                      ...message,
                      tool_calls: message.tool_calls?.map((call, index) => ({ ...call, index })),
                    }
                  : message,
                finish_reason: null,
              },
            ],
          },
          {
            ...common,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ]
          .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
          .join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const environment = {
    FACTORY_PLANNING_MODEL_BASE_URL: "",
    FACTORY_PLANNING_MODEL_API_KEY: "",
    FACTORY_MODEL_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
    FACTORY_MODEL_API_KEY: "owned-publication-fixture",
    FACTORY_PROJECT_AGENT_MODEL: "owned-planning",
  };
  const previous = Object.keys(environment).map((key) => [key, process.env[key]] as const);
  const controllers = new Set<ReturnType<typeof createProjectAgentController>>();
  function controller() {
    const value = createProjectAgentController(
      database,
      {
        start: async () => {
          throw new Error("Planning must not start Build.");
        },
      },
      {
        codePaths: async () => ({ commitSha, paths: ["tools/setup.mjs"], truncated: false }),
        code: async (_project, value) => {
          reads++;
          const input = codeReadInput.parse(value);
          expect(input.commitSha).toBe(commitSha);
          expect(input.path).toBe("tools/setup.mjs");
          return {
            ...input,
            body: "1: export async function setup() { await installDependencies(); await fetchPrivateReferences(); }",
            truncated: false,
            url: `https://forge.test/source/${commitSha}/tools/setup.mjs`,
          };
        },
      },
    );
    controllers.add(value);
    return value;
  }
  try {
    for (const [key, value] of Object.entries(environment)) process.env[key] = value;
    await database.client`INSERT INTO factory.ticket(id,project_id,title,state,created_by)
      VALUES(${ticketID},${owned.projectID},'Separate private references','ready',${owned.userID})`;
    const product = await createTicketDocumentController(database).save(ticketID, owned.userID, {
      commandId: crypto.randomUUID(),
      expectedVersion: 1,
      expectedDocumentId: null,
      requirementRevisionId: null,
      title: "Separate private references",
      description: "",
      requirement: {
        summary: "Normal setup works without private references.",
        acceptanceCriteria: ["Normal setup does not require private repository access."],
        nonGoals: ["No production writes or changes to verification assertions."],
      },
    });
    const planner = controller();
    await planner.setMode(owned.projectID, ticketID, "plan", owned.userID);
    const result = await planner.message(
      owned.projectID,
      ticketID,
      "Prepare the technical design for the confirmed requirements.",
      owned.userID,
      crypto.randomUUID(),
      "technical-planning",
    );
    expect(result?.turn?.state).toBe("completed");
    expect(reads).toBe(2);
    expect(requests).toBe(3);
    const [saved] = await database.client<
      { canonical: string; renders: (string | null)[]; commit: string; productID: string }[]
    >`SELECT canonical_content AS canonical,diagram_renders AS renders,source_commit AS commit,
      requirement_revision_id AS "productID" FROM factory.technical_design_revision WHERE ticket_id=${ticketID}`;
    expect(JSON.parse(saved?.canonical ?? "null")).toEqual(content);
    expect(saved?.renders).toEqual([null]);
    expect(saved?.commit).toBe(commitSha);
    expect(saved?.productID).toBe(product.requirementRevisionId ?? undefined);
    expect(result?.entries.at(-1)?.body).toContain("source is retained");
    expect(
      await database.client.begin((sql) =>
        technicalPlanningOutstandingIn(sql, ticketID, product.requirementRevisionId),
      ),
    ).toBe(false);
    expect(
      await database.client`SELECT id FROM factory.requirement_approval WHERE ticket_id=${ticketID}`,
    ).toHaveLength(0);
    expect(
      await database.client`SELECT id FROM factory.change WHERE ticket_id=${ticketID}`,
    ).toHaveLength(0);
    await planner.shutdown();
    const recovered = controller();
    await recovered.recover();
    await recovered.get(owned.projectID, ticketID, owned.userID);
    expect(requests).toBe(3);
    expect(
      await database.client`SELECT id FROM factory.technical_design_revision WHERE ticket_id=${ticketID}`,
    ).toHaveLength(1);
  } finally {
    await Promise.all([...controllers].map((value) => value.shutdown()));
    await provider.stop(true);
    for (const [key, value] of previous)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await database.client.end();
    await host.dispose();
  }
}, 60_000);
