import { Mastra } from "@mastra/core";
import { noopLogger } from "@mastra/core/logger";
import { createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import {
  type WikiGenerationOutput,
  type WikiGenerationProgress,
  wikiGenerationOutput,
} from "#knowledge-domain/generation";
import { modelProviderOptions } from "../models/native";
import { installationPlanningConnection } from "../models/resolver";
import type { WikiGenerationInput } from "./generation-contracts";
import { createWikiMetrics } from "./generation-metrics";
import {
  createAsk,
  createFailureRecorder,
  createFileCache,
  createPlanningStep,
  rateLimitStateFor,
  type SourceFile,
  sourceScope,
} from "./generation-planning";
import { createPackagesStep } from "./generation-topic-runner";
import { documentationLanguage } from "./language";
import { repositoryMap } from "./repository-map";

export {
  maximumTopicConcurrency,
  maximumWriteRounds,
  wikiFinalReviewTask,
  wikiInstructions,
  wikiPlanReviewSchema,
  wikiPlanReviewTask,
  wikiReviewTask,
} from "./generation-prompts";

export async function generateWiki(input: WikiGenerationInput): Promise<WikiGenerationOutput> {
  if (!input.publish) throw new Error("Wiki workflow requires checked publication");
  const publish: NonNullable<WikiGenerationInput["publish"]> = input.publish;
  const connection = input.connection ?? installationPlanningConnection();
  const providerOptions = modelProviderOptions(connection, input.modelId);
  const generationFailure = createFailureRecorder();
  // A fatal failure in one topic stops the others at their next provider step.
  const stop = new AbortController();
  const relayAbort = () => stop.abort(input.signal.reason);
  if (input.signal.aborted) relayAbort();
  else input.signal.addEventListener("abort", relayAbort, { once: true });
  const activeSignal = stop.signal;
  const rateLimit = rateLimitStateFor(connection, input.modelId);
  const progress = {
    phase: "planning",
    topicsTotal: 0,
    topicsDone: 0,
    currentTopic: null,
  } as WikiGenerationProgress;
  const metrics = createWikiMetrics();
  let progressWrites: Promise<unknown> = Promise.resolve();
  function report(patch: Partial<WikiGenerationProgress>) {
    Object.assign(progress, patch, { stats: metrics.totals() });
    const progressSink = input.progress;
    if (!progressSink) return;
    const snapshot = { ...progress };
    progressWrites = progressWrites.then(() => progressSink(snapshot)).catch(() => undefined);
  }
  let pages = input.pages.map((page) => ({ ...page }));
  const getPages = () => pages;
  const setPages = (next: typeof pages) => {
    pages = next;
  };
  const completedPageIDs = new Set(input.completedPageIDs ?? []);
  const known = new Set(input.inventory.map((file) => file.path));
  const repository = repositoryMap(input.inventory, input.actorTemplatePath);
  const language = documentationLanguage([
    ...input.sources.map((file) => file.content),
    ...pages.map((page) => page.body),
  ]);
  const emptyWiki = !pages.some((page) => page.state === "active");
  const cachedFiles = createFileCache(input.readFiles);
  const openSourceScope = (seed?: SourceFile[]) =>
    sourceScope({ input, activeSignal, known, cachedFiles }, seed);
  const ask = createAsk({
    input,
    connection,
    providerOptions,
    activeSignal,
    rateLimit,
    metrics,
  });
  const planning = createPlanningStep({
    input,
    repository,
    getPages,
    known,
    completedPageIDs,
    emptyWiki,
    metrics,
    recordFailure: generationFailure.record,
    openSourceScope,
    ask,
  });
  const packages = createPackagesStep({
    input,
    publish,
    repository,
    language,
    known,
    emptyWiki,
    stop,
    activeSignal,
    metrics,
    generationFailure,
    getPages,
    setPages,
    report,
    openSourceScope,
    ask,
  });
  const workflow = createWorkflow({
    id: "factory-wiki-generation",
    retryConfig: { attempts: 0 },
    inputSchema: z.object({}),
    outputSchema: wikiGenerationOutput,
  })
    .then(planning)
    .then(packages)
    .commit();
  const mastra = new Mastra({ workflows: { generation: workflow }, logger: noopLogger });
  try {
    const result = await (await mastra.getWorkflow("generation").createRun()).start({
      inputData: {},
    });
    if (result.status !== "success")
      throw generationFailure.error() ?? new Error("Wiki workflow did not complete");
    return result.result;
  } finally {
    input.signal.removeEventListener("abort", relayAbort);
    report({});
    const totals = metrics.totals();
    console.info(
      `[factory] Wiki generation elapsed=${(metrics.elapsedMs() / 1000).toFixed(1)}s modelSteps=${totals.modelSteps} toolRounds=${totals.toolRounds} paused=${(totals.pausedMs / 1000).toFixed(1)}s planner=${metrics.stageSeconds("plan", "planner")} ${metrics.roleLines().join(" | ")}`,
    );
    await progressWrites;
  }
}
