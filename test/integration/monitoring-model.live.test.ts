import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { codeReadInput } from "../../apps/factory/src/knowledge/code-read";
import { diagnoseMonitoringIncident } from "../../apps/factory/src/monitoring/diagnosis";
import { projectModelConnection } from "../../apps/factory/src/project-agent/adapter";
import { recordedMastraUsage } from "../../apps/factory/src/usage/record-mastra";
import { monitoringFixture } from "../fixtures/monitoring";

test.skipIf(process.env["FACTORY_MONITORING_MODEL_LIVE"] !== "1")(
  "configured Mastra diagnosis reads a reviewed MCP source and exact Git code, and refuses missing or operational context",
  async () => {
    const modelId = process.env["FACTORY_PROJECT_AGENT_MODEL"];
    if (!modelId) throw new Error("The configured Planning model is required");
    const connection = projectModelConnection();
    const capability = crypto.randomUUID();
    const exchanges: unknown[] = [];
    let proxy: ReturnType<typeof Bun.serve> | undefined;
    const evidence = resolve(".factory/test-results/monitoring/model", crypto.randomUUID());
    const repository = resolve(evidence, "repository");
    await mkdir(resolve(repository, "src"), { recursive: true });
    const source = [
      "export function invoiceTotal(invoices, id) {",
      "  const invoice = invoices.find((item) => item.id === id);",
      "  return invoice.total;",
      "}",
      "",
    ].join("\n");
    await writeFile(resolve(repository, "src/invoice.mjs"), source);
    async function git(...args: string[]) {
      const child = Bun.spawn(["git", ...args], {
        cwd: repository,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [output, error, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (status !== 0) throw new Error(`Owned Git fixture failed: ${error.slice(0, 1000)}`);
      return output.trim();
    }
    await git("init", "--initial-branch=main");
    await git("add", "src/invoice.mjs");
    await git(
      "-c",
      "user.name=Owned monitoring proof",
      "-c",
      "user.email=monitoring@factory.test",
      "commit",
      "-m",
      "Seed exact invoice defect",
    );
    const commitSha = await git("rev-parse", "HEAD");
    const executable = await import(resolve(repository, "src/invoice.mjs"));
    expect(executable.invoiceTotal([{ id: "known", total: 12 }], "known")).toBe(12);
    expect(() => executable.invoiceTotal([], "missing")).toThrow(TypeError);
    const f = await monitoringFixture({
      readIssue: (id) =>
        id === "operational"
          ? "Owned host capacity alert. CPU saturation on a Kubernetes worker. No application exception, stack or repository defect. Resolve capacity through operations, not an application change."
          : "Owned incident 42. Reproduction: invoiceTotal([], 'missing') throws TypeError reading total of undefined at src/invoice.mjs:3. A known invoice still returns its total. Missing invoices should return null.",
    });
    const results: unknown[] = [];
    try {
      proxy = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const path = new URL(request.url).pathname;
          if (
            request.headers.get("authorization") !== `Bearer ${capability}` ||
            !["/v1/responses", "/v1/chat/completions"].includes(path)
          )
            return new Response(null, { status: 403 });
          const body = await request.json();
          const response = await fetch(`${connection.baseURL}${path.slice(3)}`, {
            method: "POST",
            redirect: "error",
            signal: request.signal,
            headers: {
              authorization: `Bearer ${connection.apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          });
          const text = await response.text();
          const decoded = JSON.parse(text);
          exchanges.push({
            status: response.status,
            model: body.model,
            toolChoice: body.tool_choice,
            tools: body.tools?.map(
              (tool: { name?: string; function?: { name: string } }) =>
                tool.name ?? tool.function?.name,
            ),
            // Keep synthetic tool/result evidence, not repeated prompts or private reasoning.
            toolResults: body.input
              ?.filter((item: { type?: string }) => item.type === "function_call_output")
              .slice(-2),
            output: decoded.output?.filter(
              (item: { type?: string }) => item.type === "function_call" || item.type === "message",
            ),
            choices: decoded.choices,
          });
          return new Response(text, {
            status: response.status,
            headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
          });
        },
      });
      const controls = [
        { name: "application-defect", issue: "42", inventory: true, outcome: "fix" },
        { name: "missing-code", issue: "42", inventory: false, outcome: "insufficient-context" },
        {
          name: "operational",
          issue: "operational",
          inventory: true,
          outcome: "not-application-defect",
        },
      ] as const;
      const selected = process.env["FACTORY_MONITORING_CASE"];
      if (selected && !controls.some((control) => control.name === selected))
        throw new Error("Unknown owned monitoring calibration case");
      for (const control of controls.filter((control) => !selected || control.name === selected)) {
        const incidentId = await f.receive(control.name);
        const authority = await f.controller.authorize(incidentId);
        const observations: Array<{
          kind: string;
          digest: string;
          path?: string;
          commitSha?: string;
        }> = [];
        const callsBefore = f.sourceCalls();
        const usageId = `monitoring-model-proof:${incidentId}`;
        const inventoryQueries: string[] = [];
        const result = await diagnoseMonitoringIncident({
          ...authority,
          modelId,
          connection: {
            ...connection,
            baseURL: `http://127.0.0.1:${proxy.port}/v1`,
            apiKey: capability,
          },
          title:
            control.issue === "operational" ? "Worker CPU saturation" : "Invoice total exception",
          reference: `https://owned.example/issues/${control.issue}`,
          context: JSON.stringify({ issue_id: control.issue }),
          assignment: authority.assignments[0]!,
          mcp: f.mcp,
          code: {
            codePaths: async (projectId, query, userId) => {
              expect(projectId).toBe(f.projectId);
              expect(userId).toBe(f.userId);
              inventoryQueries.push(query);
              const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
              return {
                commitSha,
                paths:
                  control.inventory && terms.every((term) => "src/invoice.mjs".includes(term))
                    ? ["src/invoice.mjs"]
                    : [],
                truncated: false,
              };
            },
            code: async (projectId, value, userId) => {
              expect(projectId).toBe(f.projectId);
              expect(userId).toBe(f.userId);
              const input = codeReadInput.parse(value);
              expect(control.inventory).toBe(true);
              expect(input.commitSha).toBe(commitSha);
              expect(input.path).toBe("src/invoice.mjs");
              const content = await git("show", `${input.commitSha}:${input.path}`);
              return {
                ...input,
                body: content
                  .split("\n")
                  .slice(input.startLine - 1, input.startLine - 1 + input.lineCount)
                  .map((line, index) => `${input.startLine + index}: ${line}`)
                  .join("\n"),
                truncated: false,
                url: `https://owned.example/commit/${commitSha}/src/invoice.mjs`,
              };
            },
          },
          signal: AbortSignal.timeout(100_000),
          authorize: async () => {
            await f.controller.authorize(incidentId);
          },
          usage: recordedMastraUsage(f.database, {
            id: usageId,
            projectID: f.projectId,
            userID: f.userId,
            purpose: "research",
            engine: "mastra",
            provider: connection.provider ?? "openai",
            model: modelId,
          }),
          observe: async (value) => {
            observations.push(value);
          },
        }).catch(async (cause) => {
          await writeFile(
            resolve(evidence, "failure.json"),
            JSON.stringify(
              {
                case: control.name,
                observedAt: new Date().toISOString(),
                modelId,
                error:
                  cause instanceof Error
                    ? { name: cause.name, message: cause.message }
                    : "Unknown failure",
                observations,
                exchanges,
                inventoryQueries,
                sourceCalls: f.sourceCalls() - callsBefore,
                usage: await f.database
                  .client`SELECT outcome,source,counters FROM factory.usage_entry WHERE operation_id=${usageId}`,
              },
              null,
              2,
            ),
          );
          throw cause;
        });
        const usage = await f.database
          .client`SELECT outcome,source,counters FROM factory.usage_entry WHERE operation_id=${usageId}`;
        results.push({
          case: control.name,
          result,
          observations,
          inventoryQueries,
          sourceCalls: f.sourceCalls() - callsBefore,
          usage,
        });
        await writeFile(
          resolve(evidence, "result.json"),
          JSON.stringify(
            {
              observedAt: new Date().toISOString(),
              modelId,
              endpoint: new URL(connection.baseURL!).origin,
              boundary:
                "Real configured Mastra inference and official MCP transport. Synthetic owned incidents and immutable local Git fixture. No Build, review or Delivery is claimed by this proof.",
              commitSha,
              results,
            },
            null,
            2,
          ),
        );
        expect(result.outcome).toBe(control.outcome);
        expect(f.sourceCalls()).toBeGreaterThan(callsBefore);
        if (control.outcome === "fix") {
          expect(result.requirements?.acceptanceCriteria.length).toBeGreaterThan(0);
          expect(result.code).toContainEqual({ commitSha, path: "src/invoice.mjs" });
          expect(
            observations.some((item) => item.kind === "code" && item.commitSha === commitSha),
          ).toBe(true);
        } else {
          expect(result.requirements).toBeNull();
          expect(result.code).toEqual([]);
        }
        expect(usage.length).toBeGreaterThan(0);
        expect(usage.some((entry) => entry["source"] === "step")).toBe(true);
      }
      const [tickets] = await f.database.client<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM factory.ticket`;
      expect(tickets?.count).toBe(0);
    } finally {
      await proxy?.stop(true);
      await f.dispose();
    }
  },
  360_000,
);
