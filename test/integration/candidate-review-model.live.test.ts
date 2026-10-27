import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createBuildBrowserEndpoint } from "../../apps/factory/src/agent/browser-endpoint";
import { createCandidateReviewController } from "../../apps/factory/src/agent/candidate-review";
import { connectOpenCodeBrowser } from "../../apps/factory/src/agent/opencode-browser";
import { confirmSettledOpenCodeInput } from "../../apps/factory/src/agent/opencode-client";
import {
  candidateReviewInstructions,
  candidateReviewPermissions,
  candidateReviewResultInput,
  findingCheckInstructions,
} from "../../packages/conversation-domain/src/candidate-review";
import type { createForgejoClient } from "../../packages/forge/src/forge";
import { canonicalRequirementContent } from "../../packages/requirement-domain/src/requirement";
import {
  openCodeModelConfiguration,
  openCodeModelMetadata,
} from "../../packages/runtime-kubernetes/src/opencode-model";
import { candidateReviewFixture } from "../fixtures/candidate-review";
import { observe, pinnedOpenCode } from "../fixtures/pinned-opencode";
import { ownedPostgresServer } from "../fixtures/postgres-server";
import { fixtureValue } from "../fixtures/value";

test.skipIf(process.env["FACTORY_REVIEW_MODEL_LIVE"] !== "1")(
  "independent native configured reviewer distinguishes a correct candidate from seeded behavioral defects",
  async () => {
    const apiKey = process.env["FACTORY_MODEL_API_KEY"];
    const baseURL = process.env["FACTORY_MODEL_BASE_URL"];
    const modelID = process.env["FACTORY_AGENT_MODEL_ID"];
    if (!apiKey || !baseURL || !modelID)
      throw new Error("Explicit configured Azure Coding connection required");
    const address = new URL(baseURL);
    if (address.protocol !== "https:" || !address.hostname.endsWith(".openai.azure.com"))
      throw new Error("This calibration requires the configured Azure endpoint");
    const capability = crypto.randomUUID();
    const requests: Array<{ model: string; effort: string; status?: number }> = [];
    const proxy = Bun.serve({
      hostname: "0.0.0.0",
      port: 0,
      async fetch(request) {
        if (
          new URL(request.url).pathname !== "/v1/responses" ||
          request.headers.get("authorization") !== `Bearer ${capability}`
        )
          return new Response(null, { status: 403 });
        const body = await request.json();
        if (body.model !== modelID || body.reasoning?.effort !== "medium" || body.store !== false)
          return new Response(null, { status: 403 });
        requests.push({ model: body.model, effort: body.reasoning.effort });
        const result = await fetch(`${baseURL.replace(/\/$/, "")}/responses`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: request.signal,
          redirect: "error",
        });
        fixtureValue(requests.at(-1), "requests.at(-1)").status = result.status;
        return new Response(result.body, {
          status: result.status,
          headers: {
            "content-type": result.headers.get("content-type") ?? "application/json",
          },
        });
      },
    });
    const specification = canonicalRequirementContent({
      summary: "Implement the exported pure sum(a,b) function for numeric addition.",
      acceptanceCriteria: [
        "sum(2,3) returns 5 and sum(-2,1) returns -1.",
        "Either non-number operand causes TypeError. Do not concatenate strings.",
      ],
      nonGoals: ["No UI, deployment, packaging or unrelated refactoring."],
    });
    const cases: Array<{
      name: string;
      expression: string;
      validate: boolean;
      verdict: "passed" | "changes-requested";
      finding?: string;
    }> = [
      { name: "healthy", expression: "a + b", validate: true, verdict: "passed" },
      {
        name: "subtraction-defect",
        expression: "a - b",
        validate: true,
        verdict: "changes-requested",
      },
      {
        name: "missing-validation",
        expression: "a + b",
        validate: false,
        verdict: "changes-requested",
      },
      {
        name: "false-alarm-check",
        expression: "a + b",
        validate: true,
        verdict: "passed",
        finding: "Non-number operands are accepted and strings concatenate",
      },
      {
        name: "subtraction-check",
        expression: "a - b",
        validate: true,
        verdict: "changes-requested",
        finding: "Numeric addition subtracts the second operand",
      },
      {
        name: "validation-check",
        expression: "a + b",
        validate: false,
        verdict: "changes-requested",
        finding: "Non-number operands are accepted and strings concatenate",
      },
    ];
    const results: unknown[] = [];
    const evidence = resolve(".factory/test-results/reviewer-model", crypto.randomUUID());
    let postgres: Awaited<ReturnType<typeof ownedPostgresServer>> | undefined;
    const previousPostgres = process.env["FACTORY_TEST_POSTGRES"];
    try {
      postgres = await ownedPostgresServer();
      process.env["FACTORY_TEST_POSTGRES"] = JSON.stringify(postgres.identity);
      const selectedCase = process.env["FACTORY_REVIEW_CASE"];
      if (selectedCase && !cases.some((control) => control.name === selectedCase))
        throw new Error("Unknown owned reviewer calibration case");
      for (const control of cases.filter(
        (control) => !selectedCase || control.name === selectedCase,
      )) {
        const source = [
          "export function sum(a, b) {",
          ...(control.validate
            ? [
                '  if (typeof a !== "number" || typeof b !== "number") throw new TypeError("Numbers required");',
              ]
            : []),
          `  return ${control.expression};`,
          "}",
          "",
        ].join("\n");
        // Execute the seeded behavior independently of the reviewer's judgment.
        const module = await import(
          `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
        );
        const numeric = module.sum(2, 3) === 5 && module.sum(-2, 1) === -1;
        let invalidRejected = false;
        try {
          module.sum("2", 3);
        } catch (cause) {
          invalidRejected = cause instanceof TypeError;
        }
        expect(numeric && invalidRejected).toBe(control.verdict === "passed");
        const f = await candidateReviewFixture(specification);
        let owned: Awaited<ReturnType<typeof pinnedOpenCode>> | undefined;
        let endpoint: ReturnType<typeof Bun.serve> | undefined;
        let renewal: ReturnType<typeof setInterval> | undefined;
        let nativeSessionID: string | undefined;
        try {
          let turn = await f.activeReview();
          let targetReviewID = f.reviewID;
          nativeSessionID = turn.sessionID;
          renewal = setInterval(() => void f.turns.renew(turn.id, turn.ownerToken), 10_000);
          const files = {
            "sum.mjs": source,
            "sum.test.mjs":
              'import { sum } from "./sum.mjs";\nif(sum(0,0)!==0) throw new Error("zero sum");\n',
          };
          const baseSource = "export function sum(a,b) { return 0; }\n";
          const forge = {
            listFiles: async (_repository: unknown, ref: string) =>
              Object.entries(files).map(([path, current]) => {
                const text = path === "sum.mjs" && ref === "a".repeat(40) ? baseSource : current;
                return {
                  path,
                  size: Buffer.byteLength(text),
                  sha: createHash("sha1").update(text).digest("hex"),
                };
              }),
            getFile: async (_repository: unknown, path: keyof typeof files, ref: string) =>
              path === "sum.mjs" && ref === "a".repeat(40) ? baseSource : files[path],
          } as unknown as ReturnType<typeof createForgejoClient>;
          const reviewer = createCandidateReviewController(f.database, forge);
          let proposal: ReturnType<typeof candidateReviewResultInput.parse> | undefined;
          if (control.finding) {
            // Seed a claim, not a reviewer judgment. The real fresh checker must
            // independently confirm the defect or reject the healthy false alarm.
            for (const [index, criterion] of [numeric, invalidRejected].entries()) {
              const id = `seed-${index}`;
              await reviewer.call(
                turn.id,
                turn.ownerToken,
                {
                  name: "review_scenario",
                  arguments: {
                    id,
                    title: index ? "Invalid operand" : "Numeric addition",
                    category: index ? "boundary" : "normal",
                    observationKind: "source",
                    criterion: index + 1,
                    expected: index ? "Non-numbers throw TypeError" : "Numbers are added",
                  },
                },
                `${id}-start`,
              );
              await reviewer.call(
                turn.id,
                turn.ownerToken,
                {
                  name: "review_read",
                  arguments: { path: "sum.mjs" },
                },
                `${id}-read`,
              );
              await reviewer.call(
                turn.id,
                turn.ownerToken,
                {
                  name: "review_scenario_result",
                  arguments: {
                    id,
                    status: criterion ? "passed" : "failed",
                    observed: `Independent fixture execution ${criterion ? "satisfied" : "violated"} this requirement; immutable source inspected.`,
                  },
                },
                `${id}-end`,
              );
            }
            proposal = candidateReviewResultInput.parse({
              verdict: "changes-requested",
              summary: "A proposed blocker requires independent investigation.",
              criteria: [numeric, invalidRejected].map((valid, index) => ({
                criterion: index + 1,
                status: valid ? "passed" : "failed",
                evidence: `Fixture control ${valid ? "passed" : "failed"}; do not trust the proposed finding without inspecting source.`,
              })),
              findings: [
                {
                  severity: "blocking",
                  title: control.finding,
                  explanation: control.finding,
                  reproduction: "Inspect sum(2,3), sum(-2,1) and sum('2',3).",
                },
              ],
              ui: "not-applicable",
            });
            await reviewer.call(
              turn.id,
              turn.ownerToken,
              {
                name: "review_report",
                arguments: proposal,
              },
              "seed-proposal",
            );
            await f.turns.settle(
              turn.id,
              turn.ownerToken,
              "completed",
              "Seeded claim",
              async (sql) => {
                await sql`UPDATE factory.candidate_review SET state='changes-requested',completed_at=now() WHERE id=${f.reviewID}`;
                await sql`UPDATE factory.change_agent_session SET state='committed' WHERE change_id=${f.changeID}`;
              },
            );
            targetReviewID = crypto.randomUUID();
            await f.database.client`INSERT INTO factory.candidate_review(
              id,verification_id,ordinal,change_id,commit_sha,base_sha,created_by,finding_source_id)
              VALUES(${targetReviewID},${f.verificationID},2,${f.changeID},${f.commit},${"a".repeat(40)},${f.userID},${f.reviewID})`;
            turn = await f.activeReview(targetReviewID);
            nativeSessionID = turn.sessionID;
          }
          const session = {
            id: crypto.randomUUID(),
            ordinal: 1,
            turnID: turn.id,
            changeID: f.changeID,
            attemptID: f.attemptID,
            generation: 1,
            agentSessionID: turn.sessionID,
            ownerID: "owned",
            state: "active" as const,
          };
          const facade = createBuildBrowserEndpoint(
            {
              authorize: async (_id, auth) =>
                auth === `Bearer ${capability}` ? { session, ownerToken: turn.ownerToken } : null,
              authorizeRuntime: async () => null,
              call: async () => {
                throw new Error("This pure-function control has no App");
              },
            },
            reviewer,
          );
          endpoint = Bun.serve({
            hostname: "0.0.0.0",
            port: 0,
            async fetch(request) {
              const input = await request
                .clone()
                .json()
                .catch(() => null);
              const result = await facade(request, session.id);
              if (input?.method === "tools/call") {
                const output = await result
                  .clone()
                  .json()
                  .catch(() => null);
                await Bun.write(
                  resolve(
                    evidence,
                    `${control.name}-tool-${String(input.id)
                      .replace(/[^a-zA-Z0-9-]/g, "")
                      .slice(0, 80)}.json`,
                  ),
                  JSON.stringify(
                    { name: input.params?.name, arguments: input.params?.arguments, output },
                    null,
                    2,
                  ),
                );
              }
              return result;
            },
          });
          const configuration = openCodeModelConfiguration({ modelID, reasoningEffort: "medium" });
          owned = await pinnedOpenCode(
            undefined,
            undefined,
            undefined,
            `http://host.orb.internal:${proxy.port}/v1`,
            undefined,
            undefined,
            undefined,
            {
              modelID,
              ...configuration,
              model: openCodeModelMetadata("openai", modelID),
              settings: { ...configuration.settings, apiKey: capability },
            },
          );
          await owned.client.session.create({
            id: turn.sessionID,
            title: "Owned independent behavioral review",
            location: { directory: "/workspace/project" },
            model: { id: modelID, providerID: "factory" },
            permissions: candidateReviewPermissions,
          });
          const policyInput = {
            commitSHA: f.commit,
            baseSHA: "a".repeat(40),
            verificationID: f.verificationID,
            specification,
          };
          const policy = proposal
            ? findingCheckInstructions({ ...policyInput, proposal })
            : candidateReviewInstructions(policyInput);
          await owned.client.session.instructions.entry.put({
            sessionID: turn.sessionID,
            key: "factory-review-policy",
            value: policy,
          });
          await connectOpenCodeBrowser(
            owned.client,
            `http://host.orb.internal:${endpoint.port}/mcp`,
            capability,
          );
          const promptID = `msg_owned_${crypto.randomUUID().replaceAll("-", "")}`;
          await owned.client.session.prompt({
            sessionID: turn.sessionID,
            id: promptID,
            text: policy,
            delivery: "queue",
            resume: true,
          });
          await observe(
            () =>
              confirmSettledOpenCodeInput(
                fixtureValue(owned, "owned").client,
                turn.sessionID,
                promptID,
              ),
            Boolean,
            "Live independent review did not settle",
            240_000,
          );
          const report = candidateReviewResultInput.parse((await f.review(targetReviewID))?.result);
          results.push({
            name: control.name,
            numeric,
            invalidRejected,
            expected: control.verdict,
            report,
            evidence: (await f.review(targetReviewID))?.evidence,
          });
          expect(report.verdict).toBe(control.verdict);
          if (control.verdict !== "passed")
            expect(report.findings.some((finding) => finding.severity === "blocking")).toBe(true);
        } finally {
          if (renewal) clearInterval(renewal);
          if (owned && nativeSessionID) {
            await Bun.write(
              resolve(evidence, `${control.name}-native.json`),
              JSON.stringify(
                await owned.client.message
                  .list(
                    { sessionID: nativeSessionID, limit: 100 },
                    { signal: AbortSignal.timeout(5_000) },
                  )
                  .catch(() => null),
                null,
                2,
              ),
            );
          }
          await owned?.dispose();
          await endpoint?.stop(true);
          await f.dispose();
        }
      }
      expect(requests.length).toBeGreaterThan(0);
    } finally {
      await proxy.stop(true);
      if (previousPostgres === undefined) delete process.env["FACTORY_TEST_POSTGRES"];
      else process.env["FACTORY_TEST_POSTGRES"] = previousPostgres;
      await postgres?.dispose();
      await Bun.write(
        resolve(evidence, "result.json"),
        JSON.stringify({ modelID, reasoning: "medium", requests, results }, null, 2),
      );
    }
  },
  900_000,
);
