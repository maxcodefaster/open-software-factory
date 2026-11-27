import { z } from "zod";
import {
  type LearningCase,
  learningEdit,
  learningFinding,
  learningProposal,
  learningResult,
} from "#conversation-domain/learning";

function evidenceReferences(ids: string[]) {
  // An empty enum becomes JSON Schema `not`, which structured-output providers
  // do not support. A zero-length array admits no evidence references either.
  return ids.length ? z.array(z.enum(ids)).max(16) : z.array(z.string()).max(0);
}

function originalIds(ids: string[], originals: Map<string, string>) {
  return ids.map((id) => {
    const original = originals.get(id);
    if (original === undefined) throw new Error("Unknown work review reference");
    return original;
  });
}

// Factory-private wire format. Short aliases bound schema size even when every
// admitted identity is 400 characters; retained/domain identities never change.
export function createWorkReviewOutput(cases: LearningCase[]) {
  const caseIds = new Map(cases.map((item, index) => [`c${index}`, item.id]));
  const evidenceAliases = new Map<string, string>();
  for (const item of cases)
    for (const source of item.evidence)
      if (!evidenceAliases.has(source.id))
        evidenceAliases.set(source.id, `e${evidenceAliases.size}`);
  const evidenceIds = new Map([...evidenceAliases].map(([id, alias]) => [alias, id]));
  const packet = cases.map((item, index) => ({
    ...item,
    id: `c${index}`,
    evidence: item.evidence.map((source) => ({
      ...source,
      id: evidenceAliases.get(source.id) ?? source.id,
    })),
    targets: item.targets.map((source) => ({
      ...source,
      evidenceId: evidenceAliases.get(source.evidenceId) ?? source.evidenceId,
    })),
  }));
  const verdict = learningResult.shape.cases.element.omit({ caseId: true });
  const references = {
    caseIds: z
      .array(z.enum([...caseIds.keys()]))
      .min(1)
      .max(8),
    evidenceIds: evidenceIds.size
      ? evidenceReferences([...evidenceIds.keys()]).min(1)
      : evidenceReferences([]),
  };
  const schema = z.strictObject({
    cases: z.strictObject(
      Object.fromEntries(
        packet.map((item) => [
          item.id,
          verdict
            .extend({ evidenceIds: evidenceReferences(item.evidence.map((source) => source.id)) })
            .strict(),
        ]),
      ),
    ),
    findings: z
      .array(
        learningFinding.extend({ ...references, relatedProposalId: z.uuid().nullable() }).strict(),
      )
      .max(evidenceIds.size ? 12 : 0),
    proposals: z
      .array(learningProposal.extend({ ...references, edit: learningEdit.nullable() }).strict())
      .max(evidenceIds.size ? 4 : 0),
  });

  return {
    cases: packet,
    schema,
    parse(input: unknown) {
      const output = schema.parse(input);
      return learningResult.parse({
        cases: [...caseIds].map(([alias, caseId]) => {
          const item = output.cases[alias];
          if (!item) throw new Error("Missing work review verdict");
          return { ...item, caseId, evidenceIds: originalIds(item.evidenceIds, evidenceIds) };
        }),
        findings: output.findings.map((item) => ({
          ...item,
          relatedProposalId: item.relatedProposalId ?? undefined,
          caseIds: originalIds(item.caseIds, caseIds),
          evidenceIds: originalIds(item.evidenceIds, evidenceIds),
        })),
        proposals: output.proposals.map((item) => ({
          ...item,
          caseIds: originalIds(item.caseIds, caseIds),
          evidenceIds: originalIds(item.evidenceIds, evidenceIds),
        })),
      });
    },
  };
}
