import { expect, test } from "bun:test";
import { z } from "zod";
import {
  type LearningCase,
  type LearningResult,
  validateLearningResult,
} from "../../../../packages/conversation-domain/src/learning";
import {
  comparisonCases,
  learningComparisonPlan,
} from "../../../../packages/conversation-domain/src/learning-comparison";
import {
  comparisonAfter,
  comparisonBefore,
  comparisonExample,
} from "../../../../test/fixtures/learning-comparison";
import { fixtureValue } from "../../../../test/fixtures/value";
import { createWorkReviewOutput } from "./judge-output";

const cases: LearningCase[] = ["alpha", "beta", "empty"].map((id) => ({
  id: `case:${id}`,
  projectId: "10000000-0000-4000-8000-000000000001",
  ownerId: null,
  developerOnly: false,
  activity: "research",
  outcome: "completed",
  settledAt: "2026-11-01T12:00:00Z",
  evidence:
    id === "empty"
      ? []
      : [
          {
            id: `outer:${id}`,
            kind: "artifact",
            body: JSON.stringify({ sources: [{ id: `nested:${id}`, value: 7 }] }),
            truncated: false,
          },
        ],
  targets: [],
}));

type Verdict = Omit<LearningResult["cases"][number], "caseId">;
type Output = {
  cases: Record<string, Verdict>;
  findings: LearningResult["findings"];
  proposals: LearningResult["proposals"];
};
const unknownVerdict: Verdict = {
  fulfillment: "unknown",
  rework: "unknown",
  verification: "unknown",
  explanation: "The packet does not establish an outcome.",
  evidenceIds: [],
};
function modelOutput(packet: LearningCase[] = cases): Output {
  return {
    cases: Object.fromEntries(
      packet.map((_, index) => [`c${index}`, structuredClone(unknownVerdict)]),
    ),
    findings: [],
    proposals: [],
  };
}
function observedOutput(): Output {
  const output = modelOutput();
  output.cases["c0"] = {
    ...unknownVerdict,
    fulfillment: "problem",
    evidenceIds: ["e0"],
  };
  output.findings = [
    {
      caseIds: ["c0"],
      evidenceIds: ["e0"],
      dimension: "method",
      cause: "The answer used an unobserved value.",
      observation: "The retained artifact establishes a different value.",
    },
  ];
  output.proposals = [
    {
      title: "Use the retained value",
      target: "factory-defect",
      caseIds: ["c0"],
      evidenceIds: ["e0"],
      change: "Read the retained value instead of the default.",
      expectedEffect: "The answer matches its artifact.",
      validation: "Check the failing input and an unchanged healthy input.",
      edit: null,
    },
  ];
  return output;
}

test.each(["omitted", "substituted", "extra", "duplicate-array", "conflicting-caseId"])(
  "rejects %s case identities in the wire contract",
  (kind) => {
    const contract = createWorkReviewOutput(cases);
    const output = modelOutput();
    const raw: Record<string, unknown> = output;
    if (kind === "omitted") delete output.cases["c1"];
    if (kind === "substituted") {
      delete output.cases["c1"];
      output.cases["other"] = unknownVerdict;
    }
    if (kind === "extra") output.cases["c3"] = unknownVerdict;
    if (kind === "duplicate-array")
      raw["cases"] = cases.map(() => ({ caseId: "c0", ...unknownVerdict }));
    if (kind === "conflicting-caseId")
      raw["cases"] = { ...output.cases, c0: { ...unknownVerdict, caseId: "c1" } };
    expect(contract.schema.safeParse(raw).success).toBe(false);
    expect(() => contract.parse(raw)).toThrow();
  },
);

test.each(["nested:alpha", "e1", "outer:alpha", "invented"])(
  "rejects verdict evidence %s outside that case's outer evidence aliases",
  (id) => {
    const contract = createWorkReviewOutput(cases);
    const output = modelOutput();
    output.cases["c0"] = { ...unknownVerdict, evidenceIds: [id] };
    expect(contract.schema.safeParse(output).success).toBe(false);
    expect(() => contract.parse(output)).toThrow();
  },
);

test("accepts every unknown empty-evidence verdict, including an entirely empty-evidence packet", () => {
  for (const packet of [cases, [fixtureValue(cases[2], "empty case")]]) {
    const contract = createWorkReviewOutput(packet);
    const output = modelOutput(packet);
    expect(validateLearningResult(contract.parse(output), packet).cases).toEqual(
      packet.map((item) => ({ caseId: item.id, ...unknownVerdict })),
    );
    output.cases[`c${packet.length - 1}`] = { ...unknownVerdict, evidenceIds: ["e0"] };
    expect(contract.schema.safeParse(output).success).toBe(false);
    expect(JSON.stringify(z.toJSONSchema(contract.schema))).not.toContain('"not":');
  }
  const packet = [fixtureValue(cases[2], "empty case")];
  const contract = createWorkReviewOutput(packet);
  for (const kind of ["findings", "proposals"] as const) {
    const output = modelOutput(packet);
    Object.assign(output, { [kind]: observedOutput()[kind] });
    expect(contract.schema.safeParse(output).success).toBe(false);
  }
});

test("maps normal verdict, finding and proposal references back to exact admitted identities", () => {
  const contract = createWorkReviewOutput(cases);
  const result = validateLearningResult(contract.parse(observedOutput()), cases);
  expect(result.cases.map((item) => item.caseId)).toEqual(cases.map((item) => item.id));
  expect(result.cases[0]?.evidenceIds).toEqual(["outer:alpha"]);
  for (const item of [...result.findings, ...result.proposals]) {
    expect(item.caseIds).toEqual(["case:alpha"]);
    expect(item.evidenceIds).toEqual(["outer:alpha"]);
  }
});

for (const kind of ["findings", "proposals"] as const) {
  test.each([
    ["caseIds", "c8"],
    ["caseIds", "case:alpha"],
    ["evidenceIds", "nested:alpha"],
    ["evidenceIds", "e99"],
  ] as const)(`${kind} rejects unadmitted %s reference %s`, (field, id) => {
    const contract = createWorkReviewOutput(cases);
    const output = observedOutput();
    fixtureValue(output[kind][0], kind)[field] = [id];
    expect(contract.schema.safeParse(output).success).toBe(false);
    expect(() => contract.parse(output)).toThrow();
  });

  test(`${kind} still needs evidence from its listed cases after decoding`, () => {
    const contract = createWorkReviewOutput(cases);
    const output = observedOutput();
    fixtureValue(output[kind][0], kind).evidenceIds = ["e1"];
    expect(contract.schema.safeParse(output).success).toBe(true);
    expect(() => validateLearningResult(contract.parse(output), cases)).toThrow(
      "unobserved evidence",
    );
  });
}

test("decoded verdicts still need observed work, not just a schema-valid task or empty reference", () => {
  const packet = structuredClone(cases);
  fixtureValue(packet[0]?.evidence[0], "task-only evidence").kind = "task";
  const contract = createWorkReviewOutput(packet);
  const output = modelOutput();
  output.cases["c0"] = { ...unknownVerdict, fulfillment: "supported", evidenceIds: ["e0"] };
  expect(contract.schema.safeParse(output).success).toBe(true);
  expect(() => validateLearningResult(contract.parse(output), packet)).toThrow(
    "Missing work evidence",
  );
  output.cases["c0"] = { ...unknownVerdict, fulfillment: "supported" };
  expect(() => validateLearningResult(contract.parse(output), packet)).toThrow(
    "Missing work evidence",
  );
});

const target = {
  kind: "skill",
  id: "10000000-0000-4000-8000-000000000002",
  revisionId: "10000000-0000-4000-8000-000000000003",
  version: 1,
  field: "instructions",
} as const;
function editableOutput() {
  const packet = structuredClone(cases);
  const item = fixtureValue(packet[0], "editable case");
  item.evidence.push({
    id: "outer:configuration",
    kind: "configuration",
    body: "Start\n  old rule\nEnd",
    truncated: false,
  });
  item.targets = [
    { target, evidenceId: "outer:configuration", text: "Start\n  old rule\nEnd", truncated: false },
  ];
  const contract = createWorkReviewOutput(packet);
  const output = observedOutput();
  const proposal = fixtureValue(output.proposals[0], "editable proposal");
  const edit = { target: { ...target }, before: "  old rule", after: "  new rule" };
  proposal.target = "skill";
  proposal.evidenceIds = ["e0", "e1"];
  proposal.edit = edit;
  return { packet, contract, output, proposal, edit };
}

test("aliases target evidence while preserving immutable edit identity and exact passages", () => {
  const { packet, contract, output, edit } = editableOutput();
  expect(contract.cases[0]?.targets[0]).toEqual({
    ...fixtureValue(packet[0]?.targets[0], "target evidence"),
    evidenceId: "e1",
  });
  const result = validateLearningResult(contract.parse(output), packet);
  expect(result.proposals[0]?.edit).toEqual(edit);
  expect(result.proposals[0]?.evidenceIds).toEqual(["outer:alpha", "outer:configuration"]);
});

test.each([
  "kind",
  "id",
  "revisionId",
  "version",
  "field",
  "before",
  "unchanged",
  "target",
  "evidence",
])("preserves the final %s edit check after alias decoding", (field) => {
  const { packet, contract, output, proposal, edit } = editableOutput();
  const changes: Record<string, unknown> = {
    kind: "input",
    id: "10000000-0000-4000-8000-000000000004",
    revisionId: "10000000-0000-4000-8000-000000000005",
    version: 2,
    field: "description",
  };
  if (field in changes) Object.assign(edit.target, { [field]: changes[field] });
  if (field === "before") edit.before = "unobserved passage";
  if (field === "unchanged") edit.after = edit.before;
  if (field === "target") proposal.target = "input";
  if (field === "evidence") proposal.evidenceIds = ["e0"];
  expect(() => validateLearningResult(contract.parse(output), packet)).toThrow(
    /observed exact revision|declared target/,
  );
});

function comparisonPacket() {
  const edit = { target, before: comparisonBefore, after: comparisonAfter };
  const example = comparisonExample("10000000-0000-4000-8000-000000000001", edit);
  const plan = learningComparisonPlan.parse({
    edit,
    baselineTarget: target,
    before: comparisonBefore,
    after: comparisonAfter,
    cases: example.cases,
    problemIds: example.content.caseIds,
    controlId: fixtureValue(example.cases[2], "comparison control").id,
    candidateFirst: false,
    activationVersion: 1,
  });
  const answers = {
    answers: example.cases.map((item) => ({ caseId: item.id, body: "An observed replay answer." })),
  };
  return comparisonCases(plan, [answers, answers]);
}

test("maps an existing six-case comparison in input order, including shared evidence identities", () => {
  const packet = comparisonPacket();
  const contract = createWorkReviewOutput(packet);
  const output = modelOutput(packet);
  for (const [index, item] of contract.cases.entries())
    output.cases[item.id] = {
      ...unknownVerdict,
      fulfillment: "supported",
      explanation: `Observed replay ${index}.`,
      evidenceIds: [fixtureValue(item.evidence.at(-1), "replay evidence").id],
    };
  output.cases = Object.fromEntries(Object.entries(output.cases).reverse());
  expect(contract.cases[0]?.evidence[0]?.id).toBe(contract.cases[3]?.evidence[0]?.id);
  expect(validateLearningResult(contract.parse(output), packet).cases).toEqual(
    packet.map((item, index) => ({
      ...unknownVerdict,
      caseId: item.id,
      fulfillment: "supported",
      explanation: `Observed replay ${index}.`,
      evidenceIds: [fixtureValue(item.evidence.at(-1), "original replay evidence").id],
    })),
  );
});

test("maximal admitted identities use required objects within provider enum and string limits", () => {
  const packet: LearningCase[] = Array.from({ length: 8 }, (_, index) => ({
    ...fixtureValue(cases[0], "base case"),
    id: `case:${index}:`.padEnd(400, "c"),
    evidence: Array.from({ length: 24 }, (_, source) => ({
      id: `outer:${index}:${source}:`.padEnd(400, "e"),
      kind: "artifact",
      body: "An observed result.",
      truncated: false,
    })),
  }));
  const contract = createWorkReviewOutput(packet);
  const json = z.toJSONSchema(contract.schema);
  let enums = 0;
  let characters = 0;
  function count(value: unknown) {
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    for (const key of ["properties", "$defs"]) {
      const entries = node[key];
      if (entries && typeof entries === "object")
        for (const name of Object.keys(entries)) characters += name.length;
    }
    if (Array.isArray(node["enum"])) {
      enums += node["enum"].length;
      for (const item of node["enum"]) if (typeof item === "string") characters += item.length;
    }
    if (typeof node["const"] === "string") characters += node["const"].length;
    if (node["type"] === "object") {
      expect(node["additionalProperties"]).toBe(false);
      expect(node["required"]).toEqual(Object.keys(node["properties"] as object));
    }
    for (const child of Object.values(value)) count(child);
  }
  count(json);
  expect(enums).toBeLessThanOrEqual(1_000);
  expect(characters).toBeLessThanOrEqual(120_000);
  expect(JSON.stringify(json)).not.toContain('"prefixItems":');
  const output = modelOutput(packet);
  for (const item of contract.cases)
    output.cases[item.id] = {
      ...unknownVerdict,
      evidenceIds: [fixtureValue(item.evidence[0], "maximal packet evidence").id],
    };
  expect(validateLearningResult(contract.parse(output), packet).cases).toHaveLength(8);
});

test("the model generation schema requires every admitted case and maps verdicts in input order", async () => {
  // judge.test.ts replaces judge-engine globally. Keep this real-engine check in
  // its own process and stub only generation, with no provider requests.
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `
import { expect, spyOn } from "bun:test";
import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import { reviewWorkWithModel } from ${JSON.stringify(new URL("./judge-engine.ts", import.meta.url).href)};
import { reviewWork } from ${JSON.stringify(new URL("./judge.ts", import.meta.url).href)};
const cases = ${JSON.stringify(cases)};
const output = ${JSON.stringify(modelOutput())};
output.cases = Object.fromEntries(Object.entries(output.cases).reverse());
let responseOutput = output;
let generations = 0, authorizations = 0, admissions = 0;
const settlements = [];
const generate = spyOn(Agent.prototype, "generate").mockImplementation(async (prompt, options) => {
  generations++;
  const packet = JSON.parse(prompt).cases;
  expect(packet.map(item => item.id)).toEqual(["c0", "c1", "c2"]);
  expect(packet[0].evidence[0].id).toBe("e0");
  expect(packet[1].evidence[0].id).toBe("e1");
  expect(packet[0].evidence[0].body).toBe(cases[0].evidence[0].body);
  const schema = options.structuredOutput.schema;
  expect(z.toJSONSchema(schema).properties.cases).toMatchObject({
    type: "object",
    required: packet.map(item => item.id),
    additionalProperties: false,
  });
  expect(schema.safeParse(output).success).toBe(true);
  const omitted = structuredClone(output);
  delete omitted.cases.c1;
  expect(schema.safeParse(omitted).success).toBe(false);
  const substituted = structuredClone(output);
  substituted.cases.other = substituted.cases.c1;
  delete substituted.cases.c1;
  expect(schema.safeParse(substituted).success).toBe(false);
  for (const id of ["nested:alpha", "e1"]) {
    const invalid = structuredClone(output);
    invalid.cases.c0.evidenceIds = [id];
    expect(schema.safeParse(invalid).success).toBe(false);
  }
  expect(options.maxSteps).toBe(1);
  expect(options.modelSettings.maxRetries).toBe(0);
  await options.prepareStep({ messages: [], systemMessages: [] });
  return { object: responseOutput };
});
try {
  const input = {
    cases, modelId: "test-model", connection: { provider: "openai", apiKey: "unused-test-key" },
    signal: new AbortController().signal,
    authorize: async () => { authorizations++; },
    usage: {
      begin: async () => { admissions++; },
      record: async () => {},
      settle: async outcome => { settlements.push(outcome); },
    },
  };
  const result = await reviewWorkWithModel(input);
  console.log(JSON.stringify({ result, generations, authorizations, admissions, settlements }));

  responseOutput = structuredClone(output);
  delete responseOutput.cases.c1;
  await expect(reviewWorkWithModel(input)).rejects.toThrow();
  expect(generations).toBe(2);
  expect(settlements).toEqual(["completed", "failed"]);

  const comparison = ${JSON.stringify(comparisonPacket())};
  generate.mockImplementation(async (prompt, options) => {
    generations++;
    const packet = JSON.parse(prompt).cases;
    expect(z.toJSONSchema(options.structuredOutput.schema).properties.cases.required)
      .toEqual(["c0", "c1", "c2", "c3", "c4", "c5"]);
    const replayOutput = {
      cases: Object.fromEntries(packet.map(item => [item.id, {
        ...${JSON.stringify(unknownVerdict)}, fulfillment: "supported",
        evidenceIds: [item.evidence.at(-1).id],
      }]).reverse()),
      findings: [{
        caseIds: ["c0"],
        evidenceIds: [packet[0].evidence.at(-1).id, packet[3].evidence.at(-1).id],
        dimension: "method", cause: "The replay arms differ.", observation: "Both responses were observed.",
      }],
      proposals: [],
    };
    expect(options.structuredOutput.schema.safeParse(replayOutput).success).toBe(true);
    return { object: replayOutput };
  });
  const replayResult = await reviewWork({ ...input, cases: comparison, comparison: true });
  expect(replayResult.cases.map(item => item.caseId)).toEqual(comparison.map(item => item.id));
  expect(replayResult.cases.map(item => item.evidenceIds))
    .toEqual(comparison.map(item => [item.evidence.at(-1).id]));
  expect(replayResult.findings).toEqual([]);
  expect(replayResult.proposals).toEqual([]);
  expect(generations).toBe(3);
} finally {
  generate.mockRestore();
}
`,
    ],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status) throw new Error(stderr);
  const observed = JSON.parse(stdout) as { result: LearningResult };
  expect(observed).toMatchObject({
    result: {
      cases: cases.map((item) => ({ caseId: item.id, ...unknownVerdict })),
      findings: [],
      proposals: [],
    },
    generations: 1,
    authorizations: 3,
    admissions: 1,
    settlements: ["completed"],
  });
});
