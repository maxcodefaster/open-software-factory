import { expect, test } from "bun:test";
import { createTicketDocumentController } from "../../apps/factory/src/change/document";
import { createProjectAgentController } from "../../apps/factory/src/project-agent/controller";
import { codeReadInput } from "../../apps/factory/src/knowledge/code-read";
import { fixture } from "../fixtures/change-agent-turns";
import { eventually, factoryProcess } from "../fixtures/factory-process";
import { ownedPostgresServer } from "../fixtures/postgres-server";
import { unansweredClarification } from "../../packages/conversation-domain/src/clarification";
import { technicalPlanningOutstandingIn } from "../../apps/factory/src/technical-design/store";

test.skipIf(process.env["FACTORY_TECHNICAL_PLANNING_LIVE"] !== "1")(
  "real configured Planning creates product intent, then a source-grounded technical revision with a rendered diagram",
  async () => {
    const postgres = await ownedPostgresServer();
    const previous = process.env["FACTORY_TEST_POSTGRES"];
    let host: Awaited<ReturnType<typeof factoryProcess>> | undefined;
    let connection: ReturnType<Awaited<ReturnType<typeof factoryProcess>>["connect"]> | undefined;
    try {
      process.env["FACTORY_TEST_POSTGRES"] = JSON.stringify(postgres.identity);
      host = await factoryProcess();
      if (previous === undefined) delete process.env["FACTORY_TEST_POSTGRES"];
      else process.env["FACTORY_TEST_POSTGRES"] = previous;
      const db = host.connect();
      connection = db;
      const owned = await fixture(undefined, undefined, db),
        ticketID = crypto.randomUUID();
      const commitSha = "d".repeat(40);
      let reads = 0;
      await db.client`INSERT INTO factory.ticket(id,project_id,title,description,state,created_by)
        VALUES(${ticketID},${owned.projectID},'Add an invoice CSV export',
          'Export authorized invoices for a selected billing period.','ready',${owned.userID})`;
      const controller = createProjectAgentController(
        db,
        { start: async () => null },
        {
          codePaths: async (_project, _query, _user, pinned) => {
            if (pinned) expect(pinned).toBe(commitSha);
            return { commitSha, paths: ["src/invoices.ts"], truncated: false };
          },
          code: async (_project, value) => {
            reads++;
            const input = codeReadInput.parse(value);
            expect(input.commitSha).toBe(commitSha);
            expect(input.path).toBe("src/invoices.ts");
            return {
              ...input,
              truncated: false,
              body: [
                "1: export type Invoice = { number: string; issueDate: string; total: string };",
                "2: export async function authorizedInvoices(accountId: string, period: string, actorId: string): Promise<Invoice[]> {",
                "3:   await requireInvoiceAccess(actorId, accountId);",
                "4:   return invoiceStore.forPeriod(accountId, period);",
                "5: }",
                "6: // Existing UI invokes authorizedInvoices and renders an empty state when the list is empty.",
                "7: // No CSV formatter or export command exists yet.",
                "8: // Local checks: bun test; browser tests: bun run test:browser.",
              ].join("\n"),
              url: `https://forge.test/source/${commitSha}/src/invoices.ts`,
            };
          },
        },
      );
      await controller.setMode(owned.projectID, ticketID, "plan", owned.userID);
      const product = await controller.message(
        owned.projectID,
        ticketID,
        "Plan this settled feature. A user with existing invoice access can export the currently selected billing period as CSV. Include invoice number, issue date and canonical decimal total. Reuse existing permissions and period selection. Empty periods show a message without a download. Unauthorized users receive no data. Exclude scheduling and new permissions. These product decisions are confirmed; propose the requirements directly. After confirmation, inspect src/invoices.ts and include one focused PlantUML component diagram in the technical design.",
        owned.userID,
        crypto.randomUUID(),
        "full-planning",
      );
      const proposal = product?.entries.findLast((entry) => entry.kind === "requirement");
      expect(proposal?.payload["fullPlanning"]).toBe(true);
      if (!proposal)
        throw new Error("The live planner did not produce the settled product proposal.");
      const base = proposal.payload["base"] as {
        version: number;
        documentId: string | null;
        revisionId: string | null;
      };
      const ticket = proposal.payload["ticket"] as { title: string; description: string };
      const requirement = proposal.payload["requirement"] as {
        summary: string;
        acceptanceCriteria: string[];
        nonGoals: string[];
      };
      const documents = createTicketDocumentController(db, (sql, input) =>
        controller.admitTechnicalIn(sql, input),
      );
      const confirmed = await documents.save(ticketID, owned.userID, {
        commandId: crypto.randomUUID(),
        expectedVersion: base.version,
        expectedDocumentId: base.documentId,
        requirementRevisionId: base.revisionId,
        proposalEntryId: proposal.id,
        ...ticket,
        requirement,
      });
      await controller.recover();
      let result = await eventually(
        () => controller.get(owned.projectID, ticketID, owned.userID),
        (view) =>
          Boolean(view?.turn && !["pending", "dispatching", "running"].includes(view.turn.state)),
        "The live technical Planning turn did not settle.",
        90_000,
      );
      expect(result?.turn?.state).toBe("completed");
      // Exercise real technical clarification too. These are the synthetic
      // product owner's fixed decisions, not fabricated repository facts.
      for (
        let question = unansweredClarification(result?.entries ?? []);
        question;
        question = unansweredClarification(result?.entries ?? [])
      ) {
        console.info({ technicalQuestion: question.body });
        result = await controller.answer(
          owned.projectID,
          ticketID,
          question.id,
          {
            selectedOptionIds: [],
            customText:
              "Use the simplest synchronous implementation in the existing invoices module. Reuse authorizedInvoices for all access checks. Add a CSV formatter and exportInvoicesCSV alongside it, return a CSV string or an explicit empty result, and connect the existing invoice-list action to that function. Do not introduce jobs, persistence, new permissions, frameworks or dependencies. Use comma-separated RFC 4180 quoting and UTF-8; preserve canonical decimal totals. Include one focused component diagram. These choices are confirmed.",
          },
          owned.userID,
          crypto.randomUUID(),
        );
        expect(result?.turn?.state).toBe("completed");
      }
      const [design] = await db.client<
        {
          productID: string;
          sourceCommit: string;
          canonical: string;
          renders: string[];
          citations: { source: string; path?: string }[];
        }[]
      >`
        SELECT requirement_revision_id AS "productID",source_commit AS "sourceCommit",canonical_content AS canonical,
          diagram_renders AS renders,citations FROM factory.technical_design_revision WHERE ticket_id=${ticketID}`;
      if (!design)
        console.info({
          technicalOutcome: result?.entries.at(-1)?.kind,
          explanation: result?.entries.at(-1)?.body,
          reads,
        });
      expect(design?.productID).toBe(confirmed.requirementRevisionId ?? undefined);
      expect(design?.sourceCommit).toBe(commitSha);
      expect(reads).toBeGreaterThan(0);
      expect(
        await db.client.begin((sql) =>
          technicalPlanningOutstandingIn(sql, ticketID, confirmed.requirementRevisionId),
        ),
      ).toBe(false);
      expect(design?.renders[0]).toContain("<svg");
      expect(
        design?.citations.some(
          (citation) => citation.source === "code" && citation.path === "src/invoices.ts",
        ),
      ).toBe(true);
      expect(
        await db.client`SELECT id FROM factory.requirement_approval WHERE ticket_id=${ticketID}`,
      ).toHaveLength(0);
      expect(
        await db.client`SELECT id FROM factory.change WHERE ticket_id=${ticketID}`,
      ).toHaveLength(0);
      console.info({
        journey: "Product confirmation to source-grounded Technical Planning",
        reads,
        diagrams: design?.renders.length,
        implementationStarted: false,
      });
    } finally {
      if (previous === undefined) delete process.env["FACTORY_TEST_POSTGRES"];
      else process.env["FACTORY_TEST_POSTGRES"] = previous;
      await connection?.client.end();
      await host?.dispose();
      await postgres.dispose();
    }
  },
  180_000,
);
