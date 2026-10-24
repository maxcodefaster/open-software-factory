import type { VisualReview } from "../../../../packages/conversation-domain/src/visual-review";

type Scenario = VisualReview["scenarios"][number];

export function reviewTime(seconds: number, precise = false) {
  const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value / 60) % 60;
  const time = `${String(minutes).padStart(hours ? 2 : 1, "0")}:${String(value % 60).padStart(2, "0")}`;
  const clock = hours ? `${hours}:${time}` : time;
  return precise
    ? `${clock}.${Math.floor(Math.max(0, Number.isFinite(seconds) ? seconds : 0) * 10) % 10}`
    : clock;
}

export function timedScenarios(scenarios: readonly Scenario[]) {
  return scenarios
    .filter((item) => item.observationKind !== "source" && item.hasRecordingPosition !== false)
    .toSorted((a, b) => a.startedMs - b.startedMs);
}

export function scenarioAt(scenarios: readonly Scenario[], seconds: number) {
  return timedScenarios(scenarios).findLast((item) => item.startedMs <= seconds * 1000);
}

export function adjacentScenario(
  scenarios: readonly Scenario[],
  seconds: number,
  direction: -1 | 1,
) {
  const chapters = timedScenarios(scenarios);
  const milliseconds = seconds * 1000;
  return direction === 1
    ? chapters.find((item) => item.startedMs > milliseconds + 50)
    : chapters.findLast((item) => item.startedMs < milliseconds - 50);
}
