import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createMonitoringWorker } from "../../apps/factory/src/monitoring/worker";
import { monitoringFixture } from "../fixtures/monitoring";
import { clarifyProjectInput } from "../../apps/factory/src/project-agent/input";

test.skipIf(process.env["FACTORY_PROJECT_INPUT_LIVE"] !== "1")(
  "configured Project Harness enriches generic feedback from two required MCP sources and prepares one unapproved Ticket",
  async () => {
    if (
      !process.env["FACTORY_PROJECT_AGENT_MODEL"] ||
      !process.env["FACTORY_PLANNING_MODEL_API_KEY"]
    )
      throw new Error("The configured Planning model is required");
    const f = await monitoringFixture({
      readIssue: (id) =>
        `Owned feedback ${id}. Customer research found that invoice exports are hidden in the invoice detail menu. ` +
        "The product decision is to add an Export CSV action to each invoice-list row, preserve the existing detail-menu action, " +
        "and export only that row's invoice. A user without invoice export permission must not see or invoke the action. " +
        "Acceptance can be checked in the invoice list with and without permission. Do not change the CSV format.",
    });
    let worker: ReturnType<typeof createMonitoringWorker> | undefined;
    const evidence = resolve(".factory/test-results/inputs/model", crypto.randomUUID());
    try {
      await mkdir(evidence, { recursive: true });
      const second = await f.addSource("project");
      const hookId = crypto.randomUUID();
      const saved = await f.controller.save(f.projectId, f.userId, {
        id: hookId,
        commandId: crypto.randomUUID(),
        expectedVersion: 0,
        name: "Customer research",
        enabled: true,
        instructions:
          "Read feedback 42 using each connected source. Use their product decision to prepare concise requirements and testable acceptance criteria. Do not implement.",
        connectionIds: [f.source.id, second.id],
      });
      worker = createMonitoringWorker(f.database, {
        mcp: f.mcp,
        code: {
          codePaths: async () => ({ commitSha: "a".repeat(40), paths: [], truncated: false }),
          code: async () => {
            throw new Error("This product request needs no implementation source");
          },
        },
        changes: {
          start: async () => {
            throw new Error("Generic Inputs cannot commission Build");
          },
        },
        agent: {
          admitStartIn: async () => {
            throw new Error("Generic Inputs cannot admit Build");
          },
        },
        delivery: {
          get: async () => null,
          approve: async () => {
            throw new Error("No Delivery delegation");
          },
        },
        signingKey: "owned-input-live-key",
        prepare: async (input) => {
          try {
            return await clarifyProjectInput(input);
          } catch (cause) {
            const errors: Array<{ name: string; message: string }> = [];
            let current = cause;
            for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
              errors.push({ name: current.name, message: current.message.slice(0, 3000) });
              current = current.cause;
            }
            await writeFile(
              resolve(evidence, "inference-error.json"),
              JSON.stringify(errors, null, 2),
            );
            throw cause;
          }
        },
      });
      const send = () =>
        f.routes.intake(
          new Request(saved.url!, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              id: "feedback-42",
              title: "Improve invoice export discoverability",
              context: { feedbackId: "42" },
            }),
          }),
        );
      expect((await send())?.status).toBe(202);
      await worker.project(f.projectId);
      const view = await f.controller.view(f.projectId, f.userId);
      const event = view.incidents[0]!;
      const rows = await f.database
        .client`SELECT diagnosis,skill_assignment,model_id FROM factory.monitoring_incident WHERE id=${event.id}`;
      const observations = await f.database
        .client`SELECT kind,digest FROM factory.monitoring_evidence WHERE incident_id=${event.id}`;
      const usage = await f.database
        .client`SELECT outcome,source,counters FROM factory.usage_entry WHERE operation_id=${`monitoring:${event.id}`}`;
      await writeFile(
        resolve(evidence, "result.json"),
        JSON.stringify(
          {
            observedAt: new Date().toISOString(),
            event,
            rows,
            observations,
            usage,
            sourceCalls: f.sourceCalls(),
            boundary:
              "Real configured Mastra inference, official MCP client transport and actual Input worker persistence. Owned synthetic research. No Build or Delivery was commissioned.",
          },
          null,
          2,
        ),
      );
      expect(event.state).toBe("prepared");
      expect(f.sourceCalls()).toBeGreaterThanOrEqual(2);
      for (const source of [f.source, second])
        expect(
          observations.some((item) => String(item["kind"]).startsWith(`mcp:${source.id}:`)),
        ).toBe(true);
      expect(JSON.stringify(rows)).toContain("CSV");
      expect(usage.some((item) => item["source"] === "step")).toBe(true);
      expect(await f.database.client`SELECT id FROM factory.requirement_approval`).toHaveLength(0);
      expect(await f.database.client`SELECT id FROM factory.change`).toHaveLength(0);
      const calls = f.sourceCalls();
      expect((await send())?.status).toBe(202);
      await worker.project(f.projectId);
      expect(f.sourceCalls()).toBe(calls);
      expect((await f.controller.view(f.projectId, f.userId)).incidents[0]?.occurrences).toBe(2);
      expect(
        await f.database.client`SELECT id FROM factory.ticket WHERE project_id=${f.projectId}`,
      ).toHaveLength(1);
    } finally {
      worker?.close();
      await f.dispose();
    }
  },
  180_000,
);
