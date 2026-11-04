import type { KnowledgeGeneration } from "./api-contracts";

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function wikiElapsed(milliseconds: number) {
  const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
  if (minutes < 1) return "under a minute";
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

// Describes only what Factory has recorded. Elapsed time is measured by the viewer.
export function wikiGenerationProgress(
  generation: Pick<KnowledgeGeneration, "state" | "pageCount" | "progress">,
  elapsedMilliseconds?: number,
) {
  const published = generation.pageCount ?? 0;
  const progress = generation.progress;
  const parts: string[] = [];
  if (generation.state === "pending") parts.push("Queued. Waiting for a free Wiki worker.");
  else if (progress?.phase === "planning")
    parts.push("Planning: reading the repository and choosing guides.");
  else if (progress?.phase === "writing" && progress.topicsTotal > 0) {
    const position = Math.min(progress.topicsDone + 1, progress.topicsTotal);
    parts.push(
      `Writing guide ${position} of ${progress.topicsTotal}${
        progress.currentTopic ? `: ${progress.currentTopic}` : ""
      }. Each guide is investigated, written and checked before it is published.`,
    );
  } else if (progress?.phase === "publishing")
    parts.push(
      progress.topicsTotal > 0
        ? `Publishing guide ${Math.min(progress.topicsDone + 1, progress.topicsTotal)} of ${progress.topicsTotal}.`
        : "Publishing the Wiki pages.",
    );
  else if (progress?.phase === "done") parts.push("Finishing the update.");
  else if (published === 0)
    parts.push("Reading the repository and planning guides. No pages are published yet.");
  else parts.push("Writing and checking the remaining guides.");
  if (generation.state === "running" && published > 0)
    parts.push(`${plural(published, "page")} published so far.`);
  if (generation.state === "running" && elapsedMilliseconds !== undefined)
    parts.push(`Running for ${wikiElapsed(elapsedMilliseconds)}.`);
  parts.push("A full update can take about five minutes. Saved pages stay readable.");
  return parts.join(" ");
}
