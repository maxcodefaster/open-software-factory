import {
  type SetupInspectionOutput,
  setupFeedbackKey,
  setupInspectionOutput,
} from "#project-domain/setup";
import { readableCodePath } from "../knowledge/code-read";
import {
  configurationPath,
  SetupConfigurationError,
  setupConfigurationFeedback,
} from "./configuration";
import { type InspectionDb, type InspectionRow, loadInspectionRow } from "./inspection-store";
import { setupQuestionRoundLimit } from "./limits";

export function readableSetupSource(path: string) {
  const parts = path.split("/");
  if (parts.some((part) => /^\.env(?:$|\.)/i.test(part))) return false;
  if (readableCodePath(path) || configurationPath(path)) return true;
  return (
    /^(?:Dockerfile(?:\.[A-Za-z0-9._-]+)?|[A-Za-z0-9][A-Za-z0-9._-]*\.Dockerfile)$/i.test(
      parts.at(-1) ?? "",
    ) &&
    !parts.some((part) => /secret|credential|private[-_]?key/i.test(part)) &&
    readableCodePath(`${path}.sh`)
  );
}

export function formatInspectionFailure(cause: unknown, signal: AbortSignal | undefined): string {
  const timedOut =
    (signal?.aborted && signal.reason instanceof Error && signal.reason.name === "TimeoutError") ||
    (cause instanceof Error && cause.name === "TimeoutError");
  if (timedOut)
    return "Inspection timed out. Previous answers and source are unchanged. Retry explicitly when ready.";
  if (cause instanceof Error && cause.message === "Inspection model was not admitted")
    return "No planning model is connected. Ask a Factory administrator to connect one in Settings, then retry.";
  if (cause instanceof SetupConfigurationError) return cause.recovery;
  return "Inspection could not finish. Previous answers and source are unchanged; retry when ready.";
}

export async function loadInspectionQuestionContext(
  db: InspectionDb,
  value: InspectionRow,
  signal: AbortSignal,
) {
  const rounds: { question: string; answer: string }[][] = [];
  const seen = new Set([value.id]);
  let configurationFeedback: string | undefined;
  let previousProposal: SetupInspectionOutput | undefined;
  let questionRounds = 0;
  let child = value;
  while (child.parentID) {
    signal.throwIfAborted();
    if (seen.has(child.parentID)) throw new Error("Question context is unavailable");
    seen.add(child.parentID);
    const parent = await loadInspectionRow(db, child.parentID);
    if (!parent || parent.projectID !== value.projectID)
      throw new Error("Question context is unavailable");
    if (child === value && parent.state === "failed")
      configurationFeedback = setupConfigurationFeedback(parent.failure);
    if (parent.state === "failed") {
      child = parent;
      continue;
    }
    const output = setupInspectionOutput.parse(parent.output);
    if (!previousProposal && output.files.length) previousProposal = output;
    if (output.questions.length && ++questionRounds > setupQuestionRoundLimit)
      throw new Error("Setup question round bound reached");
    const round =
      !output.questions.length && child.answers[setupFeedbackKey]
        ? [
            {
              question: "Requested configuration changes",
              answer: child.answers[setupFeedbackKey],
            },
          ]
        : output.questions.map((question) => ({
            question: question.question,
            answer: child.answers[question.id] ?? "",
          }));
    if (round.length) {
      // Explicit edits review a retained proposal; they are not another
      // discovery question round. The existing model-input bound still
      // covers all retained answers and the single latest draft.
      rounds.unshift(round);
    }
    child = parent;
  }
  return { confirmedAnswers: rounds.flat(), configurationFeedback, previousProposal };
}
