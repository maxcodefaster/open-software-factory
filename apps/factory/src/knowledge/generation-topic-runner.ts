import { Mastra } from "@mastra/core";
import { noopLogger } from "@mastra/core/logger";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import {
  validateWikiGeneration,
  type WikiGenerationOutput,
  type WikiGenerationProgress,
  type WikiPageSnapshot,
  wikiGenerationOutput,
} from "#knowledge-domain/generation";
import type { WikiGenerationInput } from "./generation-contracts";
import {
  WikiSourceEvidenceError,
  WikiStructuredResultError,
  WikiTopicQualityError,
} from "./generation-failure";
import type { WikiMetrics } from "./generation-metrics";
import {
  type AskFn,
  createFailureRecorder,
  type FailureRecorder,
  type SourceFile,
  type SourceScope,
} from "./generation-planning";
import {
  advisoryRepairRound,
  loopSchema,
  maximumTopicConcurrency,
  maximumWriteRounds,
  mergedTopicPaths,
  overviewHardLimit,
  planSchema,
  researchSchema,
  reviewSchema,
  type Topic,
  type TopicResearch,
  wikiFinalReviewTask,
  wikiInvestigatorTask,
  wikiReviewTask,
  wikiWriterTask,
  writerSources,
} from "./generation-prompts";
import { stripSourcesFooter, unlinkUnavailableGuides } from "./page-tidy";
import type { repositoryMap } from "./repository-map";
import { pageExcerpt, promptSources } from "./source-excerpt";
import { wikiLinkIssues } from "./wiki-links";
import { wordingOnlyChange } from "./wording-change";

class ParentUnpublished extends Error {
  constructor(readonly origin: unknown) {
    super("The parent Wiki topic was not published");
  }
}

function deferred() {
  let resolve: () => void = () => undefined;
  let reject: (cause: unknown) => void = () => undefined;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

const topicFailure = (cause: unknown) =>
  cause instanceof WikiTopicQualityError ||
  cause instanceof WikiStructuredResultError ||
  cause instanceof WikiSourceEvidenceError;

export type TopicRunnerContext = {
  input: WikiGenerationInput;
  publish: NonNullable<WikiGenerationInput["publish"]>;
  repository: ReturnType<typeof repositoryMap>;
  language: string | undefined;
  known: ReadonlySet<string>;
  emptyWiki: boolean;
  stop: AbortController;
  activeSignal: AbortSignal;
  metrics: WikiMetrics;
  generationFailure: FailureRecorder;
  getPages: () => readonly WikiPageSnapshot[];
  setPages: (pages: WikiPageSnapshot[]) => void;
  report: (patch: Partial<WikiGenerationProgress>) => void;
  openSourceScope: (seed?: SourceFile[]) => SourceScope;
  ask: AskFn;
};

type PublishPackageFn = (topic: Topic, output: WikiGenerationOutput) => Promise<void>;

export async function runTopic(
  context: TopicRunnerContext,
  publishPackage: PublishPackageFn,
  topic: Topic,
  plannedTopics: Topic[],
  awaitParent?: () => Promise<void>,
) {
  const { input, repository, language, known, emptyWiki, metrics, getPages, openSourceScope, ask } =
    context;
  const providerRequests = input.providerRequests;
  const sources = openSourceScope();
  const topicFailureRecorder = createFailureRecorder();
  const recordFailure = topicFailureRecorder.record;
  const ownPages = () => getPages().filter((page) => topic.pageIDs.includes(page.id));
  const otherPages = () =>
    getPages()
      .filter((page) => page.state === "active" && !topic.pageIDs.includes(page.id))
      .map((page) => ({
        slug: page.slug,
        title: page.title,
        excerpt: pageExcerpt(page.body, 600),
      }));
  const readFiles = (paths: Iterable<string>) => {
    const wanted = new Set(paths);
    return [...sources.read.values()].filter((file) => wanted.has(file.path));
  };
  // A small topic with no unpublished parent is researched and written by one agent run.
  // A child under an unpublished parent still researches early, while its parent is written.
  const merged = !awaitParent && topic.paths.length <= mergedTopicPaths;
  let checksSkipped = 0;
  let rounds = 0;
  const timed = async <T>(stage: string, work: () => Promise<T>) => {
    const began = performance.now();
    try {
      return await work();
    } finally {
      metrics.stage(topic.slug, stage, performance.now() - began);
    }
  };
  const research = createStep({
    id: "investigate-topic",
    inputSchema: z.object({}),
    outputSchema: researchSchema,
    execute: async () =>
      recordFailure(async () => {
        const preload = timed("read", async () => {
          for (let offset = 0; offset < topic.paths.length; offset += 8)
            await sources.readFiles(topic.paths.slice(offset, offset + 8));
        });
        if (merged) {
          await preload;
          return { findings: [], uncertainties: [] };
        }
        await preload;
        const findings = await timed("investigate", () =>
          ask(
            "investigator",
            researchSchema,
            {
              topic,
              repository,
              currentPages: ownPages(),
              sources: promptSources(sources.read.values(), writerSources),
            },
            sources,
            wikiInvestigatorTask,
            (result) => {
              const unread = [
                ...new Set(
                  result.findings.flatMap((finding) =>
                    finding.paths.filter((path) => !sources.read.has(path)),
                  ),
                ),
              ];
              if (unread.length) throw new WikiSourceEvidenceError(unread);
            },
          ),
        );
        return findings;
      }),
  });
  let findings: TopicResearch = { findings: [], uncertainties: [] };
  const prepare = createStep({
    id: "prepare-writing",
    inputSchema: researchSchema,
    outputSchema: loopSchema,
    execute: async ({ inputData }) =>
      recordFailure(async () => {
        findings = inputData;
        await timed("wait-parent", async () => awaitParent?.());
        return { round: 0, issues: [], output: { pages: [] } };
      }),
  });
  const repair = createStep({
    id: "write-and-check",
    inputSchema: loopSchema,
    outputSchema: loopSchema,
    execute: async ({ inputData }) =>
      recordFailure(async () => {
        // A fresh object schema: picking from the strict output page would stay strict.
        const content = z.object(
          wikiGenerationOutput.shape.pages.element.pick({ body: true, sources: true }).shape,
        );
        // An existing page keeps its Factory-owned identity, so any extra key is refused. A new
        // topic's identity comes from the plan, so a stray title or slug is dropped, not fatal.
        const writingSchema = topic.pageIDs.length
          ? z
              .object({
                pages: z
                  .array(
                    content
                      .extend({
                        id: z.enum(topic.pageIDs as [string, ...string[]]),
                        title: wikiGenerationOutput.shape.pages.element.shape.title,
                      })
                      .strict(),
                  )
                  .max(2),
              })
              .strict()
          : z.object({ pages: z.array(content).length(1) });
        // The writer needs the evidence behind its findings, not every file the research read.
        rounds = inputData.round + 1;
        // A merged run has no findings and may have read more files than the seeds.
        const evidence = merged
          ? [...sources.read.values()]
          : readFiles(
              findings.findings.length
                ? findings.findings.flatMap((item) => item.paths)
                : topic.paths,
            );
        const draft = await timed("write", () =>
          ask(
            "writer",
            writingSchema,
            {
              topic,
              plannedTopics,
              ...(language ? { language } : {}),
              ...(merged ? {} : { findings }),
              currentPages: ownPages(),
              otherPages: otherPages(),
              sources: promptSources(evidence, writerSources),
              readPaths: [...sources.read.keys()],
              // An empty first draft in the prompt invites an empty answer, so only a repair has one.
              ...(inputData.round
                ? {
                    previousDraft: {
                      pages: (inputData.publication ?? inputData.output).pages.map((page) =>
                        topic.pageIDs.length
                          ? {
                              id: page.id,
                              title: page.title,
                              body: page.body,
                              sources: page.sources,
                            }
                          : { body: page.body, sources: page.sources },
                      ),
                    },
                  }
                : {}),
              issues: inputData.issues,
              ...(inputData.advisory?.length ? { advisory: inputData.advisory } : {}),
            },
            sources,
            wikiWriterTask(merged, inputData.round >= maximumWriteRounds - 1),
            undefined,
            merged ? { toolRounds: 3 } : {},
          ),
        );
        const pages = getPages();
        // Only published pages can be linked: a guide planned for later or a mistyped slug
        // becomes plain text, and a stray footer is Factory's to supply.
        const published = new Set(
          pages.filter((page) => page.state === "active").map((page) => page.slug),
        );
        const tidy = (body: string) => unlinkUnavailableGuides(stripSourcesFooter(body), published);
        const output: WikiGenerationOutput = {
          pages: draft.pages.map((page) => {
            if ("id" in page && "title" in page) {
              if (typeof page.id !== "string" || typeof page.title !== "string")
                throw new Error("Writer returned an invalid existing page");
              const current = pages.find((candidate) => candidate.id === page.id);
              if (!current || !topic.pageIDs.includes(current.id))
                throw new Error("Writer referenced an unavailable topic page");
              return {
                id: page.id,
                title: page.title,
                body: tidy(page.body),
                sources: page.sources,
                slug: current.slug,
                parentSlug: null,
              };
            }
            return {
              ...page,
              body: tidy(page.body),
              id: null,
              slug: topic.slug,
              title: topic.title,
              parentSlug: topic.parentSlug,
            };
          }),
        };
        // Check the exact human-preserving publication body. Keep the generated input separate:
        // publication must derive its baseline from it, not merge the human edit twice.
        const publication = input.preparePublication?.(output) ?? output;
        const issues: string[] = [];
        if (!topic.pageIDs.length && !output.pages.length)
          issues.push("A planned new topic must publish a useful checked page");
        try {
          validateWikiGeneration(publication, pages, new Set(sources.read.keys()));
        } catch (cause) {
          issues.push(cause instanceof Error ? cause.message : "Invalid Wiki output");
        }
        if (
          output.pages.length > 2 ||
          output.pages.some((page) =>
            page.id
              ? !topic.pageIDs.includes(page.id)
              : page.slug !== topic.slug || page.parentSlug !== topic.parentSlug,
          )
        )
          issues.push("Writer escaped planned topic package");
        for (const page of publication.pages) {
          if (
            !page.id &&
            page.parentSlug === null &&
            emptyWiki &&
            topic.slug === plannedTopics[0]?.slug &&
            page.body.length > overviewHardLimit
          )
            issues.push(
              `Shorten the new root overview from ${page.body.length} to at most 2400 characters; put interfaces/tests in child guides`,
            );
          if (/^(?:#{1,6}\s+)?sources\s*:?\s*$/im.test(page.body))
            issues.push("Source footer belongs in Factory");
          issues.push(...wikiLinkIssues(page.body, pages));
        }
        if (issues.length) {
          // Count occurrences, including duplicates across pages. The writing schema bounds
          // these at two empty lists and 128 citations; never include the rejected strings.
          const sourceRejections = {
            emptySourceLists: 0,
            knownUnreadCitations: 0,
            unknownCitationPaths: 0,
          };
          for (const page of output.pages) {
            if (!page.sources.length) sourceRejections.emptySourceLists++;
            for (const path of page.sources) {
              if (!known.has(path)) sourceRejections.unknownCitationPaths++;
              else if (!sources.read.has(path)) sourceRejections.knownUnreadCitations++;
            }
          }
          // Factory-authored messages only; a checker's issues are model prose and stay out.
          console.error(
            `[factory] Wiki topic ${topic.slug} round ${inputData.round + 1} rejected before the check: ${[...new Set(issues)].join(" | ").slice(0, 600)} | sourceRejections emptySourceLists=${sourceRejections.emptySourceLists} knownUnreadCitations=${sourceRejections.knownUnreadCitations} unknownCitationPaths=${sourceRejections.unknownCitationPaths}`,
          );
          return { round: inputData.round + 1, issues, output, publication };
        }
        // Nothing to publish, or only rewording of checked pages whose cited files are unchanged:
        // the independent check is for new facts, so a wording pass does not pay two more calls.
        if (
          topic.pageIDs.length &&
          publication.pages.every((page) => {
            const current = pages.find((candidate) => candidate.id === page.id);
            return (
              current &&
              wordingOnlyChange({
                current: current.body,
                draft: page.body,
                cited: page.sources,
                changedPaths: input.changedPaths,
              })
            );
          })
        ) {
          checksSkipped++;
          return { round: inputData.round + 1, issues: [], output, publication };
        }
        if (providerRequests?.remaining === 0)
          return {
            round: inputData.round + 1,
            issues: [
              "The draft remains unpublished because its independent page check needs another admitted provider request",
            ],
            output,
            publication,
          };
        const finalCheck = inputData.round > 0;
        const review = await timed("check", () =>
          ask(
            "checker",
            reviewSchema,
            {
              topic,
              plannedTopics,
              ...(language ? { language } : {}),
              currentPages: ownPages(),
              otherPages: otherPages(),
              draft: publication,
              ...(finalCheck ? { previousIssues: inputData.issues } : {}),
              // Only the files the draft cites; readSource covers anything else it must verify.
              sources: promptSources(
                readFiles(output.pages.flatMap((page) => page.sources)),
                writerSources,
              ),
            },
            sources,
            finalCheck ? `${wikiReviewTask} ${wikiFinalReviewTask}` : wikiReviewTask,
          ),
        );
        return {
          round: inputData.round + 1,
          issues: [...issues, ...review.issues],
          advisory: review.advisory ?? [],
          output,
          publication,
        };
      }),
  });
  const workflow = createWorkflow({
    id: "factory-wiki-topic",
    retryConfig: { attempts: 0 },
    inputSchema: z.object({}),
    outputSchema: loopSchema,
  })
    .then(research)
    .then(prepare)
    .dountil(
      repair,
      async ({ inputData }) =>
        (inputData.issues.length === 0 &&
          !(inputData.advisory?.length && inputData.round < advisoryRepairRound)) ||
        inputData.round >= maximumWriteRounds ||
        providerRequests?.remaining === 0,
    )
    .commit();
  const mastra = new Mastra({ workflows: { topic: workflow }, logger: noopLogger });
  let outcome = "failed";
  try {
    const result = await (await mastra.getWorkflow("topic").createRun()).start({ inputData: {} });
    if (result.status !== "success")
      throw topicFailureRecorder.error() ?? new Error("Wiki topic workflow did not complete");
    if (result.result.issues.length)
      throw new WikiTopicQualityError(topic.slug, result.result.issues);
    await timed("publish", () => publishPackage(topic, result.result.output));
    outcome = "published";
  } finally {
    console.info(
      `[factory] Wiki ${metrics.topicLine(
        topic.slug,
        `${outcome} merged=${merged} rounds=${rounds} checksSkipped=${checksSkipped}`,
      )}`,
    );
  }
}

export function createPackagesStep(context: TopicRunnerContext) {
  const { input, publish, stop, activeSignal, generationFailure, setPages, report } = context;
  const activeTopics: Topic[] = [];
  let publishQueue: Promise<unknown> = Promise.resolve();
  // Checked publication is one ordered, atomic write at a time. The controller's page snapshot
  // and the database revision checks assume that no other package is in flight.
  function publishPackage(topic: Topic, output: WikiGenerationOutput) {
    const run = publishQueue.then(async () => {
      activeSignal.throwIfAborted();
      report({ phase: "publishing", currentTopic: topic.title });
      setPages((await publish(output)).map((page) => ({ ...page })));
      report({ phase: "writing", currentTopic: activeTopics[0]?.title ?? null });
    });
    publishQueue = run.catch(() => undefined);
    return run;
  }

  return createStep({
    id: "investigate-write-check-publish",
    inputSchema: planSchema,
    outputSchema: wikiGenerationOutput,
    execute: async ({ inputData }) => {
      // A topic whose own writing fails its checks must not discard the others. Other topics
      // still run, except those under an unpublished parent; the update then reports the first
      // failure so a retry continues with only what remains (published pages are completed).
      // Topics start in plan order, up to maximumTopicConcurrency at once. A child researches
      // while its parent is written, then waits for the parent's publication before writing.
      const topics = [...inputData.topics];
      const failed = new Map<string, unknown>();
      let fatal: { cause: unknown } | undefined;
      const outcomes = new Map<string, ReturnType<typeof deferred>>(
        topics.map((topic) => [topic.slug, deferred()]),
      );
      let settled = 0;
      report({
        phase: "writing",
        topicsTotal: topics.length,
        topicsDone: 0,
        currentTopic: topics[0]?.title ?? null,
      });
      const finish = (topic: Topic) => {
        const index = activeTopics.indexOf(topic);
        if (index >= 0) activeTopics.splice(index, 1);
        settled++;
        report({ topicsDone: settled, currentTopic: activeTopics[0]?.title ?? null });
      };
      const noteFatal = (cause: unknown) => {
        if (fatal) return;
        fatal = { cause };
        stop.abort(cause);
      };
      async function settle(topic: Topic) {
        const outcome = outcomes.get(topic.slug);
        if (!outcome) throw new Error("Wiki topic outcome is missing");
        if (topic.parentSlug && failed.has(topic.parentSlug)) {
          const parentFailure = failed.get(topic.parentSlug);
          failed.set(topic.slug, parentFailure);
          outcome.reject(parentFailure);
          finish(topic);
          return;
        }
        activeTopics.push(topic);
        report({ currentTopic: activeTopics[0]?.title ?? null });
        const parent = topic.parentSlug ? outcomes.get(topic.parentSlug) : undefined;
        try {
          await runTopic(
            context,
            publishPackage,
            topic,
            topics,
            parent &&
              (async () => {
                try {
                  await parent.promise;
                } catch (cause) {
                  throw new ParentUnpublished(cause);
                }
              }),
          );
          outcome.resolve();
        } catch (cause) {
          const origin = cause instanceof ParentUnpublished ? cause.origin : cause;
          if (activeSignal.aborted || !(cause instanceof ParentUnpublished || topicFailure(cause)))
            noteFatal(origin);
          else failed.set(topic.slug, origin);
          outcome.reject(origin);
        }
        finish(topic);
      }
      let next = 0;
      async function worker() {
        while (!fatal) {
          const topic = topics[next];
          if (topic) {
            next++;
            await settle(topic);
          } else return;
        }
      }
      await Promise.all(
        Array.from(
          {
            length: Math.min(maximumTopicConcurrency, topics.length),
          },
          worker,
        ),
      );
      const [firstFailure] = failed.values();
      if (fatal) {
        // A provider or budget failure after an earlier topic failed reports that first failure.
        const reported =
          failed.size && !input.signal.aborted ? firstFailure : (fatal as { cause: unknown }).cause;
        generationFailure.set(reported);
        throw reported;
      }
      if (failed.size) {
        generationFailure.set(firstFailure);
        throw firstFailure;
      }
      report({ phase: "publishing", topicsDone: topics.length, currentTopic: null });
      return { pages: [] };
    },
  });
}
