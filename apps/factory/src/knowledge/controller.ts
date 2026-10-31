import type { createDatabase } from "../../../../packages/db/src/client";
import { createForgejoClient } from "../../../../packages/forge/src/forge";
import {
  validateWikiGeneration,
  type WikiPageSnapshot,
} from "../../../../packages/knowledge-domain/src/generation";
import type { knowledgeEditInput } from "../../../../packages/knowledge-domain/src/knowledge";
import { createAccessController, projectAuthorityIn } from "../access/controller";
import { CommandError } from "../command-error";
import { createModelConnections } from "../models/connections";
import { createModelSettingsController } from "../models/controller";
import { createOpenBaoModelSecrets } from "../models/secrets";
import { projectModelConnection } from "../project-agent/adapter";
import { createUsageJournal } from "../usage/journal";
import { recordedMastraUsage } from "../usage/record-mastra";
import {
  codeReadInput,
  codeReadResult,
  findReadableCodePaths,
  maximumReadableCodeBytes,
  readableCodePath,
  readCodePage,
} from "./code-read";
import { createDocumentSearchCache } from "./document-search-cache";
import { editKnowledgeIn } from "./edit";
import { factoryForgeSource } from "./forge-source";
import { generateWiki, type WikiGenerationInput } from "./generation-agent";
import { wikiGenerationFailureMessage } from "./generation-failure";
import { publishWikiPackage, WikiPublicationConflict } from "./publication";
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
  const { FACTORY_FORGEJO_API_URL, FACTORY_FORGEJO_TOKEN, FACTORY_FORGEJO_OWNER } = process.env;
  if (!FACTORY_FORGEJO_API_URL || !FACTORY_FORGEJO_TOKEN || !FACTORY_FORGEJO_OWNER) {
    throw new Error("Forgejo configuration is required");
  }
  const forge = createForgejoClient({
    apiURL: FACTORY_FORGEJO_API_URL,
    token: FACTORY_FORGEJO_TOKEN,
  });
  const forgeOrigin = { apiURL: FACTORY_FORGEJO_API_URL, owner: FACTORY_FORGEJO_OWNER };
  const running = new Set<string>();
  const executions = new Set<Promise<void>>();
  const lifetime = new AbortController();
  const repositoryCache = createRepositoryKnowledgeCache();
  const models = createModelSettingsController(database);
  const documentSearchCache = createDocumentSearchCache();

  async function project(projectID: string) {
    const rows = await database.client<
      Array<{
        id: string;
        name: string;
        repositoryURL: string;
        defaultBranch: string;
      }>
    >`
      SELECT id, name, repository_url AS "repositoryURL", default_branch AS "defaultBranch"
      FROM factory.project WHERE id = ${projectID}
    `;
    const value = rows[0];
    if (!value) throw new Error("Project not found");
    const repository = factoryForgeSource(
      value.repositoryURL,
      forgeOrigin.apiURL,
      forgeOrigin.owner,
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

  async function snapshots(projectID: string) {
    return Array.from(
      await database.client<WikiPageSnapshot[]>`
      SELECT id,slug,title,current_body AS body,version::integer AS version,
        current_revision_id AS "revisionId",parent_id AS "parentId",state,citations
      FROM factory.knowledge_page WHERE project_id=${projectID} ORDER BY sort_order,id
    `,
    );
  }

  async function sourceBundle(projectID: string, commitSha: string, pages: WikiPageSnapshot[]) {
    const current = await inventory(projectID, commitSha);
    if (current.files.length > 8_000 || JSON.stringify(pages).length > 240_000)
      throw new Error("Project exceeds the bounded Wiki analysis size");
    const candidates = current.files.filter(
      (file) =>
        file.size <= 80_000 &&
        sourceExtensions.has(extension(file.path)) &&
        !file.path
          .split("/")
          .some((part) => ["node_modules", "vendor", "dist", "build", ".git"].includes(part)) &&
        !/(^|\/)\.env(?:$|\.)/i.test(file.path) &&
        !/(^|\/)(.*lock.*|.*\.min\.(?:[jt]s|css)|.*\.map|.*secret.*|.*credentials.*)$/i.test(
          file.path,
        ),
    );
    const [previous] = await database.client<Array<{ commit: string }>>`
      SELECT source_commit_sha AS commit FROM factory.knowledge_generation
      WHERE project_id=${projectID} AND state='succeeded' ORDER BY completed_at DESC LIMIT 1
    `;
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
        /(^|\/)(readme\.md|package\.json|go\.mod|pyproject\.toml|cargo\.toml|system\.json|main\.[a-z]+|index\.[jt]sx?)$/i.test(
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
    void execution.finally(() => executions.delete(execution)).catch(() => {});
    return execution;
  }

  async function completedPublications(
    generationID: string,
    attemptID: string,
    projectID: string,
    commitSha: string,
  ) {
    const [progress] = await database.client<
      Array<{
        pageCount: number;
        previousState: string | null;
        previousCount: number | null;
        previousCommit: string | null;
      }>
    >`
      SELECT COALESCE(current.page_count,0)::int AS "pageCount",
        previous.state::text AS "previousState",previous.page_count::int AS "previousCount",
        previous.source_commit_sha AS "previousCommit"
      FROM factory.knowledge_generation current
      LEFT JOIN LATERAL (
        SELECT state,page_count,source_commit_sha FROM factory.knowledge_generation candidate
        WHERE candidate.project_id=current.project_id AND candidate.id<>current.id
          AND candidate.created_at<=current.created_at
        ORDER BY candidate.created_at DESC,candidate.id DESC LIMIT 1
      ) previous ON true
      WHERE current.id=${generationID} AND current.attempt_id=${attemptID} AND current.state='running'
        AND current.project_id=${projectID} AND current.source_commit_sha=${commitSha}`;
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
    const checked = await database.client<Array<{ id: string }>>`
      SELECT page.id FROM factory.knowledge_page page
      WHERE page.project_id=${projectID} AND page.state='active' AND page.source_commit_sha=${commitSha}
        AND EXISTS (
          SELECT 1 FROM factory.knowledge_revision revision
          WHERE revision.page_id=page.id AND revision.kind='generated'
            AND revision.generation_id IS NOT NULL AND revision.source_commit_sha=${commitSha}
        ) ORDER BY page.id`;
    return checked.map((page) => page.id);
  }

  async function executeGeneration(generationID: string) {
    if (running.has(generationID) || running.size >= 2) return;
    running.add(generationID);
    const attemptId = crypto.randomUUID();
    let failureMessage = "Wiki model is unavailable. Check Project settings and retry.";
    try {
      const generations = await database.client<
        Array<{ projectID: string; commitSha: string; userID: string; modelId: string | null }>
      >`
        UPDATE factory.knowledge_generation SET state = 'running', updated_at = now(), failure = NULL, attempt_id=${attemptId}
        WHERE id = ${generationID} AND state IN ('pending', 'running')
        RETURNING project_id AS "projectID", source_commit_sha AS "commitSha",
          created_by AS "userID", model_id AS "modelId"
      `;
      const generation = generations[0];
      if (!generation) return;
      const modelConnections = createModelConnections(
        database,
        createOpenBaoModelSecrets(),
        process.env["FACTORY_AUTH_SECRET"] ?? "local-development-secret-change-before-production",
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
        const [current] = await sql<Array<{ connectionID: string | null; version: number | null }>>`
          SELECT model_connection_id AS "connectionID", model_connection_version::float8 AS version
          FROM factory.knowledge_generation WHERE id=${generationID} AND attempt_id=${attemptId} FOR UPDATE`;
        if (!current) throw new Error("Wiki execution changed");
        const reference =
          current.connectionID && current.version
            ? { connectionID: current.connectionID, version: current.version }
            : await modelConnections.reference("planning", sql);
        await sql`UPDATE factory.knowledge_generation SET model_id=${modelId}, model_connection_id=${reference?.connectionID ?? null},
          model_connection_version=${reference?.version ?? null} WHERE id=${generationID} AND attempt_id=${attemptId}`;
        return reference;
      });
      const connection = reference
        ? await modelConnections.resolve(reference.connectionID, reference.version)
        : projectModelConnection("knowledge");
      const signal = lifetime.signal;
      const authorize = async () => {
        signal.throwIfAborted();
        await database.client.begin(async (sql) => {
          await projectAuthorityIn(sql, generation.userID, generation.projectID);
          const [current] = await sql`SELECT id FROM factory.knowledge_generation
            WHERE id=${generationID} AND attempt_id=${attemptId} AND state='running'`;
          if (!current) throw new CommandError("conflict", "Wiki execution authority changed.");
        });
      };
      for (let retry = 0; retry < 3; retry++) {
        signal.throwIfAborted();
        failureMessage =
          "Wiki source could not be read at this revision. Saved pages are retained; retry the update.";
        const pages = await snapshots(generation.projectID);
        const completedPageIDs = await completedPublications(
          generationID,
          attemptId,
          generation.projectID,
          generation.commitSha,
        );
        const bundle = await sourceBundle(generation.projectID, generation.commitSha, pages);
        failureMessage =
          "The Wiki model could not finish a supported update. Saved pages are retained; retry the update.";
        try {
          const output = await generationAgent({
            name: bundle.project.name,
            commit: generation.commitSha,
            modelId,
            connection,
            pages,
            completedPageIDs,
            inventory: bundle.candidates,
            changedPaths: bundle.changedPaths,
            sources: bundle.sources,
            readFiles: bundle.readFiles,
            signal,
            authorize,
            usageSink: (callID) =>
              recordedMastraUsage(database, {
                id: `wiki:${generationID}:${attemptId}:${callID}`,
                projectID: generation.projectID,
                userID: generation.userID,
                purpose: "wiki",
                provider: connection.provider ?? "openai",
                model: modelId,
              }),
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
              return pages;
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
      await database.client`
        UPDATE factory.knowledge_generation SET state = 'failed',
          failure = ${failureMessage},
          completed_at = now(), updated_at = now()
        WHERE id = ${generationID} AND attempt_id=${attemptId} AND state IN ('pending', 'running')
      `;
    } finally {
      running.delete(generationID);
      const pendingRows = await database.client<
        Array<{ id: string }>
      >`SELECT id FROM factory.knowledge_generation WHERE state='pending' ORDER BY created_at,id LIMIT 2`;
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
      const abandoned = await database.client<
        Array<{ id: string }>
      >`SELECT operation.id FROM factory.usage_operation operation
        JOIN factory.knowledge_generation generation ON split_part(operation.id,':',2)=generation.id::text
        WHERE operation.purpose='wiki' AND operation.settled_at IS NULL AND generation.state='running'`;
      for (const operation of abandoned) await createUsageJournal(database).abandon(operation.id);
      await database.client`UPDATE factory.knowledge_generation SET state='pending',attempt_id=NULL WHERE state='running'`;
      const generations = await database.client<Array<{ id: string }>>`
        SELECT id FROM factory.knowledge_generation WHERE state IN ('pending', 'running')
      `;
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
        await sql`SELECT id FROM factory.project WHERE id=${projectID} FOR UPDATE`;
        const [existing] = await sql<
          Array<{ id: string }>
        >`SELECT id FROM factory.knowledge_generation WHERE project_id=${projectID} AND state IN ('pending','running')`;
        if (existing) return undefined;
        if (automatic) {
          const [handled] = await sql<
            Array<{ id: string }>
          >`SELECT id FROM factory.knowledge_generation WHERE project_id=${projectID} AND source_commit_sha=${current.commitSha} LIMIT 1`;
          // Reconciliation observes an attempted source revision. It must not
          // keep commissioning paid generations after a definite failure.
          // A new source commit or an explicit human Retry can start new work.
          if (handled) return undefined;
        }
        const id = crypto.randomUUID();
        await sql`INSERT INTO factory.knowledge_generation(id,project_id,source_commit_sha,created_by,model_id) VALUES(${id},${projectID},${current.commitSha},${userID},${settings.projectEffective.planning.modelId})`;
        return id;
      });
      if (id) void runGeneration(id);
      return this.generation(projectID);
    },
    async reconcile(projectID?: string) {
      const projects = await database.client<Array<{ id: string; userId: string }>>`
        SELECT project.id, COALESCE(
          (SELECT membership.user_id FROM factory.project_membership membership WHERE membership.project_id=project.id ORDER BY membership.user_id LIMIT 1),
          (SELECT user_id FROM factory.administrator ORDER BY user_id LIMIT 1)
        ) AS "userId" FROM factory.project project
        WHERE (${projectID ?? null}::uuid IS NULL OR project.id=${projectID ?? null}::uuid)
          AND EXISTS(SELECT 1 FROM factory.knowledge_generation WHERE project_id=project.id)
        ORDER BY project.id
      `;
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
      const rows = await database.client<Array<Record<string, unknown>>>`
        SELECT id, state, page_count AS "pageCount",
          conflict_count AS "conflictCount", failure, created_at AS "createdAt",
          completed_at AS "completedAt"
        FROM factory.knowledge_generation WHERE project_id = ${projectID}
        ORDER BY created_at DESC LIMIT 1
      `;
      return rows[0] ?? null;
    },
    async edit(pageID: string, input: KnowledgeEdit, userID: string, restoring = false) {
      return database.client.begin((sql) => editKnowledgeIn(sql, pageID, input, userID, restoring));
    },
    async archive(pageID: string, expectedVersion: number, userID: string) {
      return database.client.begin(async (transaction) => {
        const [scope] = await transaction<
          Array<{ projectId: string }>
        >`SELECT project_id AS "projectId" FROM factory.knowledge_page WHERE id=${pageID} AND state='active'`;
        if (!scope) throw new CommandError("not-found", "Wiki page not found");
        await projectAuthorityIn(transaction, userID, scope.projectId);
        await transaction`SELECT id FROM factory.project WHERE id=${scope.projectId} FOR UPDATE`;
        const [page] = await transaction<
          Array<{ parentId: string | null }>
        >`SELECT parent_id AS "parentId" FROM factory.knowledge_page WHERE id=${pageID} AND version=${expectedVersion} AND state='active' FOR UPDATE`;
        if (!page)
          throw new CommandError("conflict", "Wiki page changed. Refresh before archiving.");
        await transaction`UPDATE factory.knowledge_page SET parent_id=${page.parentId},metadata_version=metadata_version+1 WHERE parent_id=${pageID} AND state='active'`;
        const rows = await transaction<Array<{ id: string }>>`
        UPDATE factory.knowledge_page SET state = 'archived', version = version + 1,
          updated_at = now()
        WHERE id = ${pageID} AND version = ${expectedVersion} AND state = 'active'
        RETURNING id
      `;
        if (!rows[0])
          throw new CommandError("conflict", "Wiki page changed. Refresh before archiving.");
        return rows[0];
      });
    },
    async restore(pageID: string, revisionID: string, expectedVersion: number, userID: string) {
      const [revision] = await database.client<
        Array<{ title: string; body: string }>
      >`SELECT title,body FROM factory.knowledge_revision WHERE id=${revisionID} AND page_id=${pageID} AND kind<>'proposed'`;
      if (!revision) throw new CommandError("not-found", "Revision not found");
      return controller.edit(
        pageID,
        { expectedVersion, title: revision.title, body: revision.body },
        userID,
        true,
      );
    },
    async sources(pageID: string, userID: string) {
      const [page] = await database.client<Array<{ projectId: string; citations: unknown }>>`
        SELECT project_id AS "projectId",citations FROM factory.knowledge_page WHERE id=${pageID}
      `;
      if (!page) throw new CommandError("not-found", "Wiki page not found");
      await createAccessController(database).requireDevelopment(userID, page.projectId);
      return { citations: page.citations };
    },
    async history(pageID: string, userID: string) {
      const [page] = await database.client<Array<{ projectId: string }>>`
        SELECT project_id AS "projectId" FROM factory.knowledge_page WHERE id=${pageID}
      `;
      if (!page) throw new CommandError("not-found", "Wiki page not found");
      const develop = await createAccessController(database).canDevelop(userID, page.projectId);
      return database.client<Array<Record<string, unknown>>>`
        SELECT revision.id, revision.ordinal, revision.kind, revision.title, revision.body,
          ${develop ? database.client`revision.source_commit_sha AS "sourceCommitSha",` : database.client``}
          revision.created_at AS "createdAt", author.name AS author
        FROM factory.knowledge_revision revision
        LEFT JOIN auth."user" author ON author.id = revision.created_by
        WHERE revision.page_id = ${pageID}
        ORDER BY revision.ordinal DESC
      `;
    },
    async search(projectID: string, query: string, userID: string) {
      const develop = await createAccessController(database).canDevelop(userID, projectID);
      const text = query.trim();
      if (!text) return [];
      const pages = await database.client<
        Array<{ id: string; slug: string; title: string; currentBody: string; rank: number }>
      >`
        SELECT id, slug, title, current_body AS "currentBody",
          ts_rank(to_tsvector('simple', title || ' ' || current_body),
            plainto_tsquery('simple', ${text})) AS rank
        FROM factory.knowledge_page
        WHERE project_id = ${projectID} AND state = 'active'
          AND to_tsvector('simple', title || ' ' || current_body)
            @@ plainto_tsquery('simple', ${text})
        ORDER BY rank DESC, title, id LIMIT 30
      `;
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
      return [...results, ...documents]
        .sort(
          (left, right) =>
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
