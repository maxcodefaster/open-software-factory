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
} from "../../packages/conversation-domain/src/candidate-review";
import type { createForgejoClient } from "../../packages/forge/src/forge";
import { canonicalRequirementContent } from "../../packages/requirement-domain/src/requirement";
import {
  openCodeModelConfiguration,
  openCodeModelMetadata,
} from "../../packages/runtime-kubernetes/src/opencode-model";
import { candidateReviewFixture } from "../fixtures/candidate-review";
import { observe, pinnedOpenCode } from "../fixtures/pinned-opencode";

test.skipIf(process.env["FACTORY_REVIEW_SOL_LIVE"] !== "1")(
  "independent native Sol reviewer distinguishes a correct candidate from seeded behavioral defects",
  async () => {
    const apiKey = process.env["FACTORY_MODEL_API_KEY"];
    const baseURL = process.env["FACTORY_MODEL_BASE_URL"];
    const modelID = process.env["FACTORY_AGENT_MODEL_ID"];
    if (!apiKey || !baseURL || modelID !== "gpt-6.1-sol")
      throw new Error("Explicit Azure Sol connection required");
    const address = new URL(baseURL);
    if (address.protocol !== "https:" || !address.hostname.endsWith(".openai.azure.com"))
      throw new Error("This calibration requires the configured Azure endpoint");
    const capability = crypto.randomUUID();
    const requests: Array<{ model: string; effort: string }> = [];
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
    const cases = [
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
    ] as const;
    const results: unknown[] = [];
    const evidence = resolve(".factory/test-results/reviewer-sol", crypto.randomUUID());
    try {
      for (const control of cases) {
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
        expect(numeric && invalidRejected).toBe(control.name === "healthy");
        const f = await candidateReviewFixture(specification);
        let owned: Awaited<ReturnType<typeof pinnedOpenCode>> | undefined;
        let endpoint: ReturnType<typeof Bun.serve> | undefined;
        let renewal: ReturnType<typeof setInterval> | undefined;
        try {
          const turn = await f.activeReview();
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
            fetch: (request) => facade(request, session.id),
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
          const policy = candidateReviewInstructions({
            commitSHA: f.commit,
            baseSHA: "a".repeat(40),
            specification,
          });
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
            () => confirmSettledOpenCodeInput(owned!.client, turn.sessionID, promptID),
            Boolean,
            "Live independent review did not settle",
            240_000,
          );
          const report = candidateReviewResultInput.parse((await f.review())?.result);
          results.push({
            name: control.name,
            numeric,
            invalidRejected,
            expected: control.verdict,
            report,
            evidence: (await f.review())?.evidence,
          });
          expect(report.verdict).toBe(control.verdict);
          if (control.name !== "healthy")
            expect(report.findings.some((finding) => finding.severity === "blocking")).toBe(true);
        } finally {
          if (renewal) clearInterval(renewal);
          await owned?.dispose();
          await endpoint?.stop(true);
          await f.dispose();
        }
      }
      expect(requests.length).toBeGreaterThan(0);
    } finally {
      await proxy.stop(true);
      await Bun.write(
        resolve(evidence, "result.json"),
        JSON.stringify({ modelID, reasoning: "medium", requests, results }, null, 2),
      );
    }
  },
  900_000,
);
