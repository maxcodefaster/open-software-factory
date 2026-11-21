import {
  and,
  asc,
  desc,
  eq,
  exists,
  sql as expression,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { factorySigningSecret } from "../../../../packages/auth/src/signing-secret";
import { type createDatabase, drizzleTransaction } from "../../../../packages/db/src/client";
import {
  administrator,
  authUser,
  knowledgeGeneration,
  knowledgePage,
  knowledgeRevision,
  projectMembership,
  project as projectTable,
  usageOperation,
} from "../../../../packages/db/src/schema";
import { createForgejoClient } from "../../../../packages/forge/src/forge";
import {
  validateWikiGeneration,
  type WikiPageSnapshot,
} from "../../../../packages/knowledge-domain/src/generation";
import type { knowledgeEditInput } from "../../../../packages/knowledge-domain/src/knowledge";
import { createAccessController } from "../access/api";
import { projectAuthorityIn } from "../access/authority";
import { CommandError } from "../command-error";
import { reportFailure } from "../failure-log";
import {
  createModelConnections,
  createModelSettingsController,
  createOpenBaoModelSecrets,
} from "../models/api";
import { installationPlanningConnection } from "../models/resolver";
import { createUsageJournal } from "../usage/journal-api";
import { recordedMastraUsage } from "../usage/record-mastra";
import {
  findReadableCodePaths,
  maximumReadableCodeBytes,
  readableCodePath,
  readCodePage,
} from "./code-read";
import { codeReadInput, codeReadResult } from "./contracts";
import { createDocumentSearchCache } from "./document-search-cache";
import { editKnowledgeIn } from "./edit";
import { factoryForgeSource } from "./forge-source";
import { generateWiki } from "./generation-agent";
import { type WikiGenerationInput } from "./generation-contracts";
import { wikiGenerationFailureMessage } from "./generation-failure";
import {
  prepareWikiPublication,
  publishWikiPackage,
  WikiPublicationConflict,
  wikiPublicationSnapshotsIn,
} from "./publication";
import { createRepositoryKnowledgeCache } from "./repository-cache";
import { searchSnippet } from "./search-snippet";

type Database = ReturnType<typeof createDatabase>;
type KnowledgeEdit = typeof knowledgeEditInput._output;

const sourceExtensions = new Set([
  ".md",
  ".mdx",
  ".json",
  ".toml",
  ".yaml",
  ".yml",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".go",
  ".py",
  ".rs",
  ".mod",
  ".sql",
  ".css",
  ".html",
]);

function extension(path: string) {
  const file = path.split("/").at(-1) ?? "";
  const dot = file.lastIndexOf(".");
  return dot < 0 ? "" : file.slice(dot).toLowerCase();
}

function repositoryTitle(path: string) {
  return (
    path
      .split("/")
      .at(-1)
      ?.replace(/\.(md|mdx)$/i, "")
      .replaceAll(/[-_]+/g, " ") ?? path
  );
}

export function createKnowledgeController(
  database: Database,
  repositoryReader?: Pick<
    ReturnType<typeof createForgejoClient>,
    "getDefaultBranch" | "listFiles" | "getFileInfo"
  >,
  generationAgent: (input: WikiGenerationInput) => ReturnType<typeof generateWiki> = generateWiki,
) {
  const {
    FACTORY_FORGEJO_API_URL,
    FACTORY_FORGEJO_PUBLIC_URL,
    FACTORY_FORGEJO_TOKEN,
    FACTORY_FORGEJO_OWNER,
  } = process.env;
  if (!FACTORY_FORGEJO_API_URL || !FACTORY_FORGEJO_TOKEN || !FACTORY_FORGEJO_OWNER) {
    throw new Error("Forgejo configuration is required");
  }
  const forge = createForgejoClient({
    apiURL: FACTORY_FORGEJO_API_URL,
    token: FACTORY_FORGEJO_TOKEN,
  });
  const forgeOrigin = {
    apiURL: FACTORY_FORGEJO_API_URL,
    publicURL: FACTORY_FORGEJO_PUBLIC_URL,
    owner: FACTORY_FORGEJO_OWNER,
  };
  const running = new Set<string>();
  const executions = new Set<Promise<void>>();
  const lifetime = new AbortController();
  const repositoryCache = createRepositoryKnowledgeCache();
  const models = createModelSettingsController(database);
  const documentSearchCache = createDocumentSearchCache();

  async function project(projectID: string) {
    const rows = await database.db
      .select({
        id: projectTable.id,
        name: projectTable.name,
        repositoryURL: projectTable.repositoryUrl,
        defaultBranch: projectTable.defaultBranch,
      })
      .from(projectTable)
      .where(eq(projectTable.id, projectID));
    const value = rows[0];
    if (!value) throw new Error("Project not found");
    const repository = factoryForgeSource(
      value.repositoryURL,
      forgeOrigin.apiURL,
      forgeOrigin.owner,
      forgeOrigin.publicURL,
    );
    return { ...value, repository };
  }

  async function inventory(projectID: string, commitSha?: string) {
    const current = await project(projectID);
    const branch = commitSha
      ? { name: current.defaultBranch, headSha: commitSha }
      : await (repositoryReader ?? forge).getDefaultBranch(current.repository);
    if (branch.name !== current.defaultBranch)
      throw new Error("Project default branch does not match Forge");
    const files = await repositoryCache.inventory(current.repositoryURL, branch.headSha, () =>
      (repositoryReader ?? forge).listFiles(current.repository, branch.headSha),
    );
    return { project: current, commitSha: branch.headSha, files };
  }

  async function documentContent(current: Awaited<ReturnType<typeof inventory>>, path: string) {
    const entry = current.files.find((file) => file.path === path);
    if (!entry || !/\.mdx?$/i.test(path) || entry.size > 250_000)
      throw new CommandError("not-found", "Repository document is unavailable at this revision.");
    const body = await repositoryCache.content(
      current.project.repositoryURL,
      entry.sha,
      async () => {
        const file = await (repositoryReader ?? forge).getFileInfo(
          current.project.repository,
          path,
          current.commitSha,
        );
        if (file.sha !== entry.sha)
          throw new Error("Repository document blob does not match its inventory");
        return file.content;
      },
    );
    return { entry, body };
  }

  async function sourceBundle(projectID: string, commitSha: string, pages: WikiPageSnapshot[]) {
    const current = await inventory(projectID, commitSha);
    if (current.files.length > 8_000 || JSON.stringify(pages).length > 240_000)
      throw new Error("Project exceeds the bounded Wiki analysis size");
    const candidates = current.files.filter(
      (file) =>
        file.size <= 80_000 &&
        (sourceExtensions.has(extension(file.path)) ||
          (/(^|\/)readme$/i.test(file.path) && readableCodePath(file.path))) &&
        !file.path
          .split("/")
          .some((part) => ["node_modules", "vendor", "dist", "build", ".git"].includes(part)) &&
        !/(^|\/)\.env(?:$|\.)/i.test(file.path) &&
        !/(^|\/)(.*lock.*|.*\.min\.(?:[jt]s|css)|.*\.map|.*secret.*|.*credentials.*)$/i.test(
          file.path,
        ),
    );
    const [previous] = await database.db
      .select({ commit: knowledgeGeneration.sourceCommitSha })
      .from(knowledgeGeneration)
      .where(
        and(
          eq(knowledgeGeneration.projectId, projectID),
          eq(knowledgeGeneration.state, "succeeded"),
        ),
      )
      .orderBy(desc(knowledgeGeneration.completedAt))
      .limit(1);
    const previousFiles = previous ? (await inventory(projectID, previous.commit)).files : [];
    const old = new Map(previousFiles.map((file) => [file.path, file.sha]));
    const next = new Map(current.files.map((file) => [file.path, file.sha]));
    const changedPaths = [
      ...new Set([
        ...current.files.filter((file) => old.get(file.path) !== file.sha).map((file) => file.path),
        ...previousFiles.filter((file) => !next.has(file.path)).map((file) => file.path),
      ]),
    ];
    const read = new Map<string, { path: string; content: string }>();
    let bytes = 0;
    async function readFiles(paths: string[]) {
      const result: Array<{ path: string; content: string }> = [];
      for (const path of paths) {
        const cached = read.get(path);
        if (cached) {
          result.push(cached);
          continue;
        }
        const entry = candidates.find((file) => file.path === path);
        if (!entry || paths.length > 8 || read.size >= 384 || bytes + entry.size > 2_000_000)
          throw new Error("Wiki source read is unavailable or exceeds its analysis bound");
        const content = await repositoryCache.content(
          current.project.repositoryURL,
          entry.sha,
          async () => {
            const value = await (repositoryReader ?? forge).getFileInfo(
              current.project.repository,
              path,
              commitSha,
            );
            if (value.sha !== entry.sha) throw new Error("Wiki source blob changed unexpectedly");
            return value.content;
          },
        );
        bytes += new TextEncoder().encode(content).byteLength;
        if (bytes > 2_000_000) throw new Error("Wiki analysis exceeds its total source bound");
        const value = { path, content };
        read.set(path, value);
        result.push(value);
      }
      return result;
    }
    const initial = candidates
      .filter((file) =>
        /(^|\/)(readme(?:\.md)?|package\.json|go\.mod|pyproject\.toml|cargo\.toml|system\.json|main\.[a-z]+|index\.[jt]sx?)$/i.test(
          file.path,
        ),
      )
      .sort(
        (left, right) =>
          left.path.split("/").length - right.path.split("/").length ||
          left.path.localeCompare(right.path),
      )
      .slice(0, 6);
    const sources = await readFiles(initial.map((file) => file.path));
    return {
      ...current,
      candidates,
      changedPaths,
      sources,
      readFiles,
      readPaths: () => new Set(read.keys()),
    };
  }

  function runGeneration(generationID: string) {
    if (lifetime.signal.aborted) return Promise.resolve();
    const execution = executeGeneration(generationID);
    executions.add(execution);
    void execution
      .finally(() => executions.delete(execution))
      .catch(reportFailure("Wiki generation"));
    return execution;
  }

  async function completedPublications(
    generationID: string,
    attemptID: string,
    projectID: string,
    commitSha: string,
  ) {
    const db = database.db;
    const candidate = alias(knowledgeGeneration, "candidate");
    const previous = db
      .select({
        state: candidate.state,
        pageCount: candidate.pageCount,
        sourceCommitSha: candidate.sourceCommitSha,
      })
      .from(candidate)
      .where(
        and(
          eq(candidate.projectId, knowledgeGeneration.projectId),
          ne(candidate.id, knowledgeGeneration.id),
          lte(candidate.createdAt, knowledgeGeneration.createdAt),
        ),
      )
      .orderBy(desc(candidate.createdAt), desc(candidate.id))
      .limit(1)
      .as("previous");
    const [progress] = await db
      .select({
        pageCount: expression<number>`coalesce(${knowledgeGeneration.pageCount},0)`,
        previousState: previous.state,
        previousCount: previous.pageCount,
        previousCommit: previous.sourceCommitSha,
      })
      .from(knowledgeGeneration)
      .leftJoinLateral(previous, expression`true`)
      .where(
        and(
          eq(knowledgeGeneration.id, generationID),
          eq(knowledgeGeneration.attemptId, attemptID),
          eq(knowledgeGeneration.state, "running"),
          eq(knowledgeGeneration.projectId, projectID),
          eq(knowledgeGeneration.sourceCommitSha, commitSha),
        ),
      );
    if (!progress) throw new Error("Wiki execution no longer owns analysis");
    if (
      !progress.pageCount &&
      !(
        progress.previousState === "failed" &&
        progress.previousCommit === commitSha &&
        Number(progress.previousCount) > 0
      )
    )
      return [];
    const checked = await db
      .select({ id: knowledgePage.id })
      .from(knowledgePage)
      .where(
        and(
          eq(knowledgePage.projectId, projectID),
          eq(knowledgePage.state, "active"),
          eq(knowledgePage.sourceCommitSha, commitSha),
          exists(
            db
              .select({ id: knowledgeRevision.id })
              .from(knowledgeRevision)
              .where(
                and(
                  eq(knowledgeRevision.pageId, knowledgePage.id),
                  eq(knowledgeRevision.kind, "generated"),
                  isNotNull(knowledgeRevision.generationId),
                  eq(knowledgeRevision.sourceCommitSha, commitSha),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(knowledgePage.id));
    return checked.map((page) => page.id);
  }

  async function executeGeneration(generationID: string) {
    if (running.has(generationID) || running.size >= 2) return;
    running.add(generationID);
    const attemptId = crypto.randomUUID();
    let failureMessage = "Wiki model is unavailable. Check Project settings and retry.";
    try {
      const generations = await database.db
        .update(knowledgeGeneration)
        .set({
          state: "running",
          updatedAt: expression`now()`,
          failure: null,
          attemptId,
          progress: { phase: "planning", topicsTotal: 0, topicsDone: 0, currentTopic: null },
        })
        .where(
          and(
            eq(knowledgeGeneration.id, generationID),
            inArray(knowledgeGeneration.state, ["pending", "running"]),
          ),
        )
        .returning({
          projectID: knowledgeGeneration.projectId,
          commitSha: knowledgeGeneration.sourceCommitSha,
          userID: knowledgeGeneration.createdBy,
          modelId: knowledgeGeneration.modelId,
        });
      const generation = generations[0];
      if (!generation) return;
      const modelConnections = createModelConnections(
        database,
        createOpenBaoModelSecrets(),
        factorySigningSecret(),
        process.env["FACTORY_MODEL_ALLOWED_ORIGINS"]
          ?.split(",")
          .map((origin) => origin.trim())
          .filter(Boolean) ?? [],
      );
      const settings = await models.getInherited(generation.projectID, generation.userID);
      const modelId = generation.modelId ?? settings.projectEffective.planning.modelId;
      if (!settings.projectEffective.planning.models.includes(modelId))
        throw new Error("Wiki model is no longer approved");
      const reference = await database.client.begin(async (sql) => {
        const db = drizzleTransaction(sql);
        const [current] = await db
          .select({
            connectionID: knowledgeGeneration.modelConnectionId,
            version: knowledgeGeneration.modelConnectionVersion,
          })
          .from(knowledgeGeneration)
          .where(
            and(
              eq(knowledgeGeneration.id, generationID),
              eq(knowledgeGeneration.attemptId, attemptId),
            ),
          )
          .for("update");
        if (!current) throw new Error("Wiki execution changed");
        const reference =
          current.connectionID && current.version
            ? { connectionID: current.connectionID, version: current.version }
            : await modelConnections.reference("planning", sql);
        await db
          .update(knowledgeGeneration)
          .set({
            modelId,
            modelConnectionId: reference?.connectionID ?? null,
            modelConnectionVersion: reference?.version ?? null,
          })
          .where(
            and(
              eq(knowledgeGeneration.id, generationID),
              eq(knowledgeGeneration.attemptId, attemptId),
            ),
          );
        return reference;
      });
      const connection = reference
        ? await modelConnections.resolve(reference.connectionID, reference.version)
        : installationPlanningConnection();
      const signal = lifetime.signal;
      const authorize = async () => {
        signal.throwIfAborted();
        await database.client.begin(async (sql) => {
          await projectAuthorityIn(sql, generation.userID, generation.projectID);
          const [current] = await drizzleTransaction(sql)
            .select({ id: knowledgeGeneration.id })
            .from(knowledgeGeneration)
            .where(
              and(
                eq(knowledgeGeneration.id, generationID),
                eq(knowledgeGeneration.attemptId, attemptId),
                eq(knowledgeGeneration.state, "running"),
              ),
            );
          if (!current) throw new CommandError("conflict", "Wiki execution authority changed.");
        });
      };
      for (let retry = 0; retry < 3; retry++) {
        signal.throwIfAborted();
        failureMessage =
          "Wiki source could not be read at this revision. Saved pages are retained; retry the update.";
        const pages = await wikiPublicationSnapshotsIn(database.db, generation.projectID);
        // Generated baselines belong to publication, not model context or its input-size budget.
        const pageContext = () => pages.map(({ generatedBody: _, ...page }) => page);
        const completedPageIDs = await completedPublications(
          generationID,
          attemptId,
          generation.projectID,
          generation.commitSha,
        );
        const bundle = await sourceBundle(
          generation.projectID,
          generation.commitSha,
          pageContext(),
        );
        failureMessage =
          "The Wiki model could not finish a supported update. Saved pages are retained; retry the update.";
        try {
          const output = await generationAgent({
            name: bundle.project.name,
            commit: generation.commitSha,
            modelId,
            connection,
            pages: pageContext(),
            completedPageIDs,
            inventory: bundle.candidates,
            changedPaths: bundle.changedPaths,
            sources: bundle.sources,
            readFiles: bundle.readFiles,
            signal,
            authorize,
            progress: async (progress) => {
              // Progress is advisory; a lost write must never fail checked generation.
              try {
                await database.db
                  .update(knowledgeGeneration)
                  .set({ progress, updatedAt: expression`now()` })
                  .where(
                    and(
                      eq(knowledgeGeneration.id, generationID),
                      eq(knowledgeGeneration.attemptId, attemptId),
                      eq(knowledgeGeneration.state, "running"),
                    ),
                  );
              } catch {
                console.error("[factory] Wiki progress could not be recorded");
              }
            },
            usageSink: (callID) =>
              recordedMastraUsage(database, {
                id: `wiki:${generationID}:${attemptId}:${callID}`,
                projectID: generation.projectID,
                userID: generation.userID,
                purpose: "wiki",
                provider: connection.provider ?? "openai",
                model: modelId,
              }),
            preparePublication: (output) => prepareWikiPublication(pages, output),
            publish: async (output) => {
              await authorize();
              validateWikiGeneration(output, pages, bundle.readPaths());
              const head = await (repositoryReader ?? forge).getDefaultBranch(
                bundle.project.repository,
              );
              if (head.headSha !== generation.commitSha) throw new Error("Source head changed");
              // The workflow captures its read snapshot, not a later human draft.
              const published = await publishWikiPackage(database, {
                generationID,
                attemptID: attemptId,
                ...generation,
                pages,
                output,
                complete: false,
              });
              if (!published)
                throw new WikiPublicationConflict("Wiki changed during checked publication");
              pages.splice(0, pages.length, ...published);
              return pageContext();
            },
          });
          validateWikiGeneration(output, pages, bundle.readPaths());
          failureMessage =
            "Wiki source changed during the update. Saved pages are retained; a fresh update will follow.";
          const head = await (repositoryReader ?? forge).getDefaultBranch(
            bundle.project.repository,
          );
          if (head.headSha !== generation.commitSha)
            throw new Error(
              "Default branch changed during Wiki update. A fresh update will follow.",
            );
          failureMessage =
            "The Wiki update could not be saved. Current pages are retained; retry the update.";
          const published = await publishWikiPackage(database, {
            generationID,
            attemptID: attemptId,
            ...generation,
            pages,
            output,
            complete: true,
          });
          if (published) return;
        } catch (cause) {
          if (!(cause instanceof WikiPublicationConflict)) throw cause;
        }
      }
      failureMessage =
        "Wiki changed repeatedly during the update. Saved content is retained; retry when edits settle.";
      throw new Error(failureMessage);
    } catch (cause) {
      failureMessage = wikiGenerationFailureMessage(cause, failureMessage);
      await database.db
        .update(knowledgeGeneration)
        .set({
          state: "failed",
          failure: failureMessage,
          completedAt: expression`now()`,
          updatedAt: expression`now()`,
        })
        .where(
          and(
            eq(knowledgeGeneration.id, generationID),
            eq(knowledgeGeneration.attemptId, attemptId),
            inArray(knowledgeGeneration.state, ["pending", "running"]),
          ),
        );
    } finally {
      running.delete(generationID);
      const pendingRows = await database.db
        .select({ id: knowledgeGeneration.id })
        .from(knowledgeGeneration)
        .where(eq(knowledgeGeneration.state, "pending"))
        .orderBy(asc(knowledgeGeneration.createdAt), asc(knowledgeGeneration.id))
        .limit(2);
      for (const pending of pendingRows) void runGeneration(pending.id);
    }
  }

  const controller = {
    async codePaths(projectID: string, query: string, userID: string, commitSha?: string) {
      await createAccessController(database).requireDevelopment(userID, projectID);
      const current = await inventory(projectID, commitSha);
      const matches = findReadableCodePaths(current.files, query);
      await createAccessController(database).requireDevelopment(userID, projectID);
      return {
        commitSha: current.commitSha,
        ...matches,
      };
    },
    async code(projectID: string, value: unknown, userID: string) {
      await createAccessController(database).requireDevelopment(userID, projectID);
      const input = codeReadInput.parse(value);
      const current = await inventory(projectID, input.commitSha);
      const entry = current.files.find((file) => file.path === input.path);
      if (!entry || entry.size > maximumReadableCodeBytes || !readableCodePath(input.path))
        throw new CommandError("not-found", "Code source is unavailable");
      const content = await repositoryCache.content(
        current.project.repositoryURL,
        entry.sha,
        async () => {
          const file = await (repositoryReader ?? forge).getFileInfo(
            current.project.repository,
            input.path,
            input.commitSha,
          );
          if (file.sha !== entry.sha || file.content.includes("\0"))
            throw new Error("Code blob does not match its readable inventory");
          return file.content;
        },
        Math.max(250_000, entry.size),
      );
      await createAccessController(database).requireDevelopment(userID, projectID);
      return codeReadResult.parse({
        ...input,
        ...readCodePage(content, input),
        url: `${current.project.repositoryURL.replace(/\.git$/, "")}/src/commit/${input.commitSha}/${input.path.split("/").map(encodeURIComponent).join("/")}`,
      });
    },
    async settle() {
      while (executions.size) await Promise.allSettled([...executions]);
    },
    async close() {
      lifetime.abort(new Error("Factory is shutting down; Wiki work was cancelled."));
      while (executions.size) await Promise.allSettled([...executions]);
    },
    async recover() {
      const abandoned = await database.db
        .select({ id: usageOperation.id })
        .from(usageOperation)
        .innerJoin(
          knowledgeGeneration,
          eq(
            expression<string>`split_part(${usageOperation.id},':',2)`,
            expression`${knowledgeGeneration.id}::text`,
          ),
        )
        .where(
          and(
            eq(usageOperation.purpose, "wiki"),
            isNull(usageOperation.settledAt),
            eq(knowledgeGeneration.state, "running"),
          ),
        );
      for (const operation of abandoned) await createUsageJournal(database).abandon(operation.id);
      await database.db
        .update(knowledgeGeneration)
        .set({ state: "pending", attemptId: null })
        .where(eq(knowledgeGeneration.state, "running"));
      const generations = await database.db
        .select({ id: knowledgeGeneration.id })
        .from(knowledgeGeneration)
        .where(inArray(knowledgeGeneration.state, ["pending", "running"]));
      for (const generation of generations) void runGeneration(generation.id);
    },
    async generate(projectID: string, userID: string, automatic = false) {
      lifetime.signal.throwIfAborted();
      const settings = await models.getInherited(projectID, userID);
      if (!settings.projectEffective.planning.available)
        throw new CommandError("unavailable", "Project Wiki model is not approved.");
      const current = await inventory(projectID);
      const id = await database.client.begin(async (sql) => {
        await projectAuthorityIn(sql, userID, projectID);
        const db = drizzleTransaction(sql);
        await db
          .select({ id: projectTable.id })
          .from(projectTable)
          .where(eq(projectTable.id, projectID))
          .for("update");
        const [existing] = await db
          .select({ id: knowledgeGeneration.id })
          .from(knowledgeGeneration)
          .where(
            and(
              eq(knowledgeGeneration.projectId, projectID),
              inArray(knowledgeGeneration.state, ["pending", "running"]),
            ),
          );
        if (existing) return undefined;
        if (automatic) {
          const [handled] = await db
            .select({ id: knowledgeGeneration.id })
            .from(knowledgeGeneration)
            .where(
              and(
                eq(knowledgeGeneration.projectId, projectID),
                eq(knowledgeGeneration.sourceCommitSha, current.commitSha),
              ),
            )
            .limit(1);
          // Reconciliation observes an attempted source revision. It must not
          // keep commissioning paid generations after a definite failure.
          // A new source commit or an explicit human Retry can start new work.
          if (handled) return undefined;
        }
        const id = crypto.randomUUID();
        await db.insert(knowledgeGeneration).values({
          id,
          projectId: projectID,
          sourceCommitSha: current.commitSha,
          createdBy: userID,
          modelId: settings.projectEffective.planning.modelId,
        });
        return id;
      });
      if (id) void runGeneration(id);
      return this.generation(projectID);
    },
    async reconcile(projectID?: string) {
      const db = database.db;
      const member = db
        .select({ userId: projectMembership.userId })
        .from(projectMembership)
        .where(eq(projectMembership.projectId, projectTable.id))
        .orderBy(asc(projectMembership.userId))
        .limit(1);
      const admin = db
        .select({ userId: administrator.userId })
        .from(administrator)
        .orderBy(asc(administrator.userId))
        .limit(1);
      const projects = await db
        .select({
          id: projectTable.id,
          userId: expression<string | null>`coalesce((${member}),(${admin}))`,
        })
        .from(projectTable)
        .where(
          and(
            projectID === undefined || projectID === null
              ? undefined
              : eq(projectTable.id, projectID),
            exists(
              db
                .select({ id: knowledgeGeneration.id })
                .from(knowledgeGeneration)
                .where(eq(knowledgeGeneration.projectId, projectTable.id)),
            ),
          ),
        )
        .orderBy(asc(projectTable.id));
      for (const project of projects) {
        if (!project.userId) continue;
        try {
          await this.generate(project.id, project.userId, true);
        } catch {
          /* A repository/access failure is retried on the next bounded reconciliation. */
        }
      }
    },
    async generation(projectID: string) {
      const rows = await database.db
        .select({
          id: knowledgeGeneration.id,
          state: knowledgeGeneration.state,
          pageCount: knowledgeGeneration.pageCount,
          conflictCount: knowledgeGeneration.conflictCount,
          failure: knowledgeGeneration.failure,
          createdAt: expression<string>`${knowledgeGeneration.createdAt}::text`,
          completedAt: expression<string | null>`${knowledgeGeneration.completedAt}::text`,
          progress: knowledgeGeneration.progress,
        })
        .from(knowledgeGeneration)
        .where(eq(knowledgeGeneration.projectId, projectID))
        .orderBy(desc(knowledgeGeneration.createdAt))
        .limit(1);
      return rows[0] ?? null;
    },
    async edit(pageID: string, input: KnowledgeEdit, userID: string, restoring = false) {
      return database.client.begin((sql) => editKnowledgeIn(sql, pageID, input, userID, restoring));
    },
    async archive(pageID: string, expectedVersion: number, userID: string) {
      return database.client.begin(async (transaction) => {
        const db = drizzleTransaction(transaction);
        const [scope] = await db
          .select({ projectId: knowledgePage.projectId })
          .from(knowledgePage)
          .where(and(eq(knowledgePage.id, pageID), eq(knowledgePage.state, "active")));
        if (!scope) throw new CommandError("not-found", "Wiki page not found");
        await projectAuthorityIn(transaction, userID, scope.projectId);
        await db
          .select({ id: projectTable.id })
          .from(projectTable)
          .where(eq(projectTable.id, scope.projectId))
          .for("update");
        const [page] = await db
          .select({ parentId: knowledgePage.parentId })
          .from(knowledgePage)
          .where(
            and(
              eq(knowledgePage.id, pageID),
              eq(knowledgePage.version, expectedVersion),
              eq(knowledgePage.state, "active"),
            ),
          )
          .for("update");
        if (!page)
          throw new CommandError("conflict", "Wiki page changed. Refresh before archiving.");
        await db
          .update(knowledgePage)
          .set({
            parentId: page.parentId,
            metadataVersion: expression`${knowledgePage.metadataVersion}+1`,
          })
          .where(and(eq(knowledgePage.parentId, pageID), eq(knowledgePage.state, "active")));
        const rows = await db
          .update(knowledgePage)
          .set({
            state: "archived",
            version: expression`${knowledgePage.version}+1`,
            updatedAt: expression`now()`,
          })
          .where(
            and(
              eq(knowledgePage.id, pageID),
              eq(knowledgePage.version, expectedVersion),
              eq(knowledgePage.state, "active"),
            ),
          )
          .returning({ id: knowledgePage.id });
        if (!rows[0])
          throw new CommandError("conflict", "Wiki page changed. Refresh before archiving.");
        return rows[0];
      });
    },
    async restore(pageID: string, revisionID: string, expectedVersion: number, userID: string) {
      const [revision] = await database.db
        .select({ title: knowledgeRevision.title, body: knowledgeRevision.body })
        .from(knowledgeRevision)
        .where(
          and(
            eq(knowledgeRevision.id, revisionID),
            eq(knowledgeRevision.pageId, pageID),
            ne(knowledgeRevision.kind, "proposed"),
          ),
        );
      if (!revision) throw new CommandError("not-found", "Revision not found");
      return controller.edit(
        pageID,
        { expectedVersion, title: revision.title, body: revision.body },
        userID,
        true,
      );
    },
    async sources(pageID: string, userID: string) {
      const [page] = await database.db
        .select({ projectId: knowledgePage.projectId, citations: knowledgePage.citations })
        .from(knowledgePage)
        .where(eq(knowledgePage.id, pageID));
      if (!page) throw new CommandError("not-found", "Wiki page not found");
      await createAccessController(database).requireDevelopment(userID, page.projectId);
      return { citations: page.citations };
    },
    async history(pageID: string, userID: string) {
      const [page] = await database.db
        .select({ projectId: knowledgePage.projectId })
        .from(knowledgePage)
        .where(eq(knowledgePage.id, pageID));
      if (!page) throw new CommandError("not-found", "Wiki page not found");
      const develop = await createAccessController(database).canDevelop(userID, page.projectId);
      return database.db
        .select({
          id: knowledgeRevision.id,
          ordinal: knowledgeRevision.ordinal,
          kind: knowledgeRevision.kind,
          title: knowledgeRevision.title,
          body: knowledgeRevision.body,
          ...(develop ? { sourceCommitSha: knowledgeRevision.sourceCommitSha } : {}),
          createdAt: expression<string>`${knowledgeRevision.createdAt}::text`,
          author: authUser.name,
        })
        .from(knowledgeRevision)
        .leftJoin(authUser, eq(authUser.id, knowledgeRevision.createdBy))
        .where(eq(knowledgeRevision.pageId, pageID))
        .orderBy(desc(knowledgeRevision.ordinal));
    },
    async search(projectID: string, query: string, userID: string) {
      const develop = await createAccessController(database).canDevelop(userID, projectID);
      const text = query.trim();
      if (!text) return [];
      const vector = expression`to_tsvector('simple',${knowledgePage.title}||' '||${knowledgePage.currentBody})`;
      const rank = expression<number>`ts_rank(${vector},plainto_tsquery('simple',${text}))`.as(
        "rank",
      );
      const pages = await database.db
        .select({
          id: knowledgePage.id,
          slug: knowledgePage.slug,
          title: knowledgePage.title,
          currentBody: knowledgePage.currentBody,
          rank,
        })
        .from(knowledgePage)
        .where(
          and(
            eq(knowledgePage.projectId, projectID),
            eq(knowledgePage.state, "active"),
            expression`${vector} @@ plainto_tsquery('simple',${text})`,
          ),
        )
        .orderBy(desc(rank), asc(knowledgePage.title), asc(knowledgePage.id))
        .limit(30);
      const terms = text.toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const results = pages.map((page) => ({
        id: page.id,
        kind: "page" as const,
        title: page.title,
        path: page.slug,
        snippet: searchSnippet(page.currentBody, terms),
        rank: Number(page.rank),
      }));
      if (!develop) return results;
      const current = await inventory(projectID);
      const documents: Array<{
        id: string;
        kind: "document";
        title: string;
        path: string;
        snippet: string;
        rank: number;
      }> = [];
      const files = current.files.filter(
        (file) => /\.mdx?$/i.test(file.path) && file.size <= 250_000,
      );
      if (
        files.length > 2_000 ||
        files.reduce((total, file) => total + file.size, 0) > 16 * 1024 * 1024
      )
        throw new CommandError(
          "unavailable",
          "Repository documents exceed the full-text search size limit.",
        );
      const corpus = await documentSearchCache.get(
        `${current.project.repositoryURL}:${current.commitSha}`,
        async () => {
          const read: Array<{ path: string; sha: string; title: string; body: string }> = [];
          // Coalesce full-text indexing, bound concurrent reads and reuse unchanged blobs across commits.
          let cursor = 0;
          await Promise.all(
            Array.from({ length: Math.min(4, files.length) }, async () => {
              while (cursor < files.length) {
                const file = files[cursor++];
                if (!file) break;
                const { body } = await documentContent(current, file.path);
                const title = repositoryTitle(file.path);
                read.push({ path: file.path, sha: file.sha, title, body });
              }
            }),
          );
          return read.sort((left, right) => left.path.localeCompare(right.path));
        },
      );
      for (const { path, title, body } of corpus) {
        const heading = `${path} ${title}`.toLocaleLowerCase();
        const full = `${heading} ${body.toLocaleLowerCase()}`;
        if (!terms.every((term) => full.includes(term))) continue;
        documents.push({
          id: `document:${path}`,
          kind: "document",
          title,
          path,
          snippet: searchSnippet(body, terms),
          rank: terms.every((term) => heading.includes(term)) ? 2 : 0.5,
        });
      }
      // Wiki pages come first. Their ts_rank scale is far below the document scores,
      // so a shared rank sort would push every Wiki match behind the repository files.
      return [...results, ...documents]
        .sort(
          (left, right) =>
            Number(right.kind === "page") - Number(left.kind === "page") ||
            right.rank - left.rank ||
            left.title.localeCompare(right.title) ||
            left.id.localeCompare(right.id),
        )
        .slice(0, 50);
    },
    async documents(projectID: string) {
      const current = await inventory(projectID);
      return {
        commitSha: current.commitSha,
        documents: current.files
          .filter((file) => /\.mdx?$/i.test(file.path) && file.size <= 250_000)
          .map((file) => ({ ...file, title: repositoryTitle(file.path) }))
          .sort((left, right) => left.path.localeCompare(right.path)),
      };
    },
    async document(projectID: string, path: string) {
      if (!/\.mdx?$/i.test(path)) throw new Error("Repository Document must be Markdown");
      const current = await inventory(projectID);
      const { entry, body } = await documentContent(current, path);
      return {
        path,
        title: repositoryTitle(path),
        body,
        blobSha: entry.sha,
        commitSha: current.commitSha,
      };
    },
  };
  return controller;
}
