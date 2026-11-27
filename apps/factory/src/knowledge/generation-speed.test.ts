import { expect, spyOn, test } from "bun:test";
import { mergeGeneratedDocument } from "#knowledge-domain/document-merge";
import type {
  WikiGenerationOutput,
  WikiGenerationProgress,
  WikiPageSnapshot,
} from "#knowledge-domain/generation";
import { generateWiki, maximumTopicConcurrency } from "./generation-workflow";
import { prepareWikiPublication } from "./publication";

type Role = "planner" | "coverage" | "repair" | "investigator" | "writer" | "checker";
type Seen = {
  role: Role;
  system: string;
  prompt: Record<string, unknown> & { input?: Record<string, unknown>; correction?: string };
  toolChoice?: string;
  maxTokens?: number;
  index: number;
  at: number;
};
type Reply =
  | { output: unknown; delay?: number }
  | { tool: string[] }
  | { raw: string; finish?: "length" | "stop" };

const topic = (
  slug: string,
  paths: string[],
  parentSlug: string | null,
  pageIDs: string[] = [],
) => ({
  slug,
  title: `Title ${slug}`,
  purpose: "Explain a reader task",
  paths,
  pageIDs,
  parentSlug,
});
const fileList = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    path: `src/file-${index}.ts`,
    sha: "a".repeat(40),
    size: 30,
  }));

async function scenario(options: {
  reply(seen: Seen): Reply | Promise<Reply>;
  coverage?(seen: Seen): Reply | Promise<Reply>;
  files?: number;
  pages?: WikiPageSnapshot[];
  completedPageIDs?: readonly string[];
  changedPaths?: string[];
  commit?: string;
  actorTemplatePath?: string;
  sources?: Array<{ path: string; content: string }>;
  inventory?: Array<{ path: string; sha: string; size: number }>;
  readFiles?(paths: string[]): Promise<Array<{ path: string; content: string }>>;
  preparePublication?(output: WikiGenerationOutput): WikiGenerationOutput;
  onPublish?(output: WikiGenerationOutput, pages: readonly WikiPageSnapshot[]): void;
}) {
  const seen: Seen[] = [];
  const published: Array<{
    slug: string;
    title: string;
    body: string;
    id: string | null;
    parentSlug: string | null;
  }> = [];
  const progress: WikiGenerationProgress[] = [];
  const reads: string[][] = [];
  const commit = options.commit ?? "a".repeat(40);
  let pages = options.pages ? [...options.pages] : [];
  const files = options.inventory ?? fileList(options.files ?? 12);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const incoming = (await request.json()) as {
        tool_choice?: string;
        max_completion_tokens?: number;
        max_tokens?: number;
        messages: Array<{ role: string; content: string | Array<{ text?: string }> | null }>;
      };
      const text = (content: string | Array<{ text?: string }> | null) =>
        typeof content === "string" ? content : (content?.[0]?.text ?? "");
      const system = incoming.messages
        .filter((message) => message.role === "system")
        .map((message) => text(message.content))
        .join("\n");
      const user = text(
        incoming.messages.find((message) => message.role === "user")?.content ?? "",
      );
      const role: Role = system.includes("Review the whole proposed Wiki topic plan")
        ? "coverage"
        : system.includes("Return the complete corrected topic plan")
          ? "repair"
          : system.includes("Research manifests")
            ? "planner"
            : system.includes("Follow relationships")
              ? "investigator"
              : system.includes("Write only this topic")
                ? "writer"
                : "checker";
      const entry: Seen = {
        role,
        system,
        prompt: JSON.parse(user.slice(user.indexOf("{"), user.lastIndexOf("}") + 1)),
        ...(incoming.tool_choice ? { toolChoice: incoming.tool_choice } : {}),
        ...((incoming.max_completion_tokens ?? incoming.max_tokens)
          ? { maxTokens: incoming.max_completion_tokens ?? incoming.max_tokens }
          : {}),
        index: seen.filter((candidate) => candidate.role === role).length,
        at: performance.now(),
      };
      seen.push(entry);
      const reply =
        role === "coverage"
          ? await (options.coverage?.(entry) ?? { output: { findings: [] } })
          : await options.reply(entry);
      if ("output" in reply && reply.delay) await Bun.sleep(reply.delay);
      const done = (content: string, finish = "stop") =>
        Response.json({
          id: "owned-wiki-speed",
          object: "chat.completion",
          created: 1,
          model: "controlled-wiki",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finish }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      if ("tool" in reply)
        return Response.json({
          id: "owned-wiki-speed",
          object: "chat.completion",
          created: 1,
          model: "controlled-wiki",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: `read-${seen.length}`,
                    type: "function",
                    function: {
                      name: "readSource",
                      arguments: JSON.stringify({ paths: reply.tool }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      if ("raw" in reply) return done(reply.raw, reply.finish);
      return done(JSON.stringify(reply.output));
    },
  });
  const requests = { remaining: 60 };
  try {
    const outcome = await generateWiki({
      name: "Speed fixture",
      commit,
      ...(options.actorTemplatePath ? { actorTemplatePath: options.actorTemplatePath } : {}),
      modelId: "controlled-wiki",
      connection: {
        provider: "openai",
        baseURL: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "owned-test-not-a-secret",
      },
      pages,
      ...(options.completedPageIDs ? { completedPageIDs: options.completedPageIDs } : {}),
      inventory: files,
      changedPaths: options.changedPaths ?? files.map((file) => file.path),
      sources: options.sources ?? [],
      providerRequests: requests,
      signal: AbortSignal.timeout(20_000),
      progress: async (value) => {
        progress.push(value);
      },
      readFiles: async (paths) => {
        reads.push([...paths]);
        return options.readFiles
          ? options.readFiles(paths)
          : paths.map((path) => ({ path, content: `export const value = "${path}";` }));
      },
      ...(options.preparePublication ? { preparePublication: options.preparePublication } : {}),
      publish: async (output) => {
        for (const page of output.pages) {
          published.push({
            slug: page.slug,
            title: page.title,
            body: page.body,
            id: page.id,
            parentSlug: page.parentSlug,
          });
          const index = pages.findIndex((current) => current.slug === page.slug);
          const next: WikiPageSnapshot = {
            id: page.id ?? crypto.randomUUID(),
            slug: page.slug,
            title: page.title,
            body: page.body,
            version: 1,
            revisionId: crypto.randomUUID(),
            parentId: null,
            state: "active",
            citations: page.sources.map((path) => ({ path, commitSha: commit })),
          };
          if (index >= 0) pages[index] = next;
          else pages = [...pages, next];
        }
        options.onPublish?.(output, pages);
        return pages;
      },
    });
    return { outcome, seen, published, progress, requests, reads, pages };
  } finally {
    await server.stop(true);
  }
}

const count = (seen: Seen[], role: Role) => seen.filter((entry) => entry.role === role).length;
const page = (body: string, sources: string[] = ["src/file-0.ts"]) => ({
  pages: [{ body, sources }],
});

test("the actual Wiki planner receives the configured native ActorTemplate in its bounded map", async () => {
  const actorTemplatePath = "ops/native/project-runtime.json";
  const result = await scenario({
    actorTemplatePath,
    inventory: [
      ...fileList(60).map((file, index) => ({
        ...file,
        path: `packages/package-${index}/package.json`,
      })),
      { path: actorTemplatePath, sha: "b".repeat(40), size: 50 },
      { path: ".factory/system.json", sha: "c".repeat(40), size: 50 },
    ],
    reply: ({ role }) =>
      role === "planner"
        ? { output: { topics: [topic("overview", [actorTemplatePath], null)] } }
        : role === "writer"
          ? {
              output: page("Use the configured native Project environment.", [actorTemplatePath]),
            }
          : { output: { issues: [], advisory: [] } },
  });
  const planner = result.seen.find((entry) => entry.role === "planner");
  expect(planner?.prompt["repository"]).toMatchObject({
    manifests: [
      actorTemplatePath,
      ".factory/system.json",
      ...Array.from({ length: 60 }, (_, index) => `packages/package-${index}/package.json`)
        .sort()
        .slice(0, 38),
    ],
  });
  expect(result.published).toHaveLength(1);
});

test("the checker reviews the human-merged material overview before publication", async () => {
  const base = "Factory Starter is an application.";
  const reference = "Human handover reference: KNO-4C-20261119.";
  const human = `${reference} The demo owner is the release team; arrange the review with them.`;
  const introduction =
    "Final flight is the release team's account-and-session demonstration. Review the account journey with the demo owner before handover.";
  const current: WikiPageSnapshot = {
    id: "cc0a77f4-466c-4a9b-a3cb-5fcc967f8e8a",
    slug: "overview",
    title: "Final flight",
    body: `${base}\n\n${human}`,
    version: 3,
    revisionId: "f1b31ecb-7bb7-498a-ba20-563a9903f797",
    parentId: null,
    state: "active",
    citations: [{ path: "README.md", commitSha: "b".repeat(40) }],
  };
  const source = { path: "README.md", content: `# Final flight\n\n${introduction}` };
  const checked: string[] = [];
  let generatedBody = base;
  let publishedBody = current.body;
  const result = await scenario({
    pages: [current],
    commit: "3e221e212b256976b9835629693c2a07b4c9396e",
    inventory: [{ path: source.path, sha: "a".repeat(40), size: source.content.length }],
    changedPaths: [source.path],
    sources: [source],
    readFiles: async () => [source],
    preparePublication: (output) => prepareWikiPublication([{ ...current, generatedBody }], output),
    reply: ({ role, prompt, index }) => {
      if (role === "planner")
        return {
          output: {
            topics: [topic(current.slug, [source.path], null, [current.id])],
          },
        };
      if (role === "writer") {
        expect(JSON.stringify(prompt)).not.toContain('"generatedBody"');
        if (index === 1) {
          expect(prompt["previousDraft"]).toMatchObject({
            pages: [{ body: `${introduction}\n\n${reference}\n\n${human}` }],
          });
          expect(prompt["advisory"]).toEqual([
            "The handover reference is repeated. Keep its full original note exactly once.",
          ]);
        }
        return {
          output: {
            pages: [
              {
                id: current.id,
                title: current.title,
                body: index === 0 ? `${introduction}\n\n${reference}` : introduction,
                sources: [source.path],
              },
            ],
          },
        };
      }
      if (role !== "checker") throw new Error(`Unexpected role: ${role}`);
      const body = (prompt["draft"] as WikiGenerationOutput).pages[0]?.body ?? "";
      checked.push(body);
      expect(body).toContain(human);
      expect(body.split(reference).length - 1).toBe(index === 0 ? 2 : 1);
      return {
        output: {
          issues: [],
          advisory:
            index === 0
              ? ["The handover reference is repeated. Keep its full original note exactly once."]
              : [],
        },
      };
    },
    onPublish: (output, pages) => {
      const next = pages.find((page) => page.id === current.id);
      if (!next || output.pages.length !== 1) throw new Error("Missing overview publication");
      // Publication still receives the generated input, not a second human-merged body.
      expect(output.pages[0]?.body).toBe(introduction);
      const merged = mergeGeneratedDocument(generatedBody, publishedBody, next.body);
      expect(merged.conflict).toBe(false);
      generatedBody = merged.generatedBody;
      publishedBody = merged.body;
      next.body = merged.body;
    },
  });
  expect(result.published).toHaveLength(1);
  expect(publishedBody).toBe(`${introduction}\n\n${human}`);
  expect(generatedBody).toBe(introduction);
  expect(checked).toHaveLength(2);
  expect(checked.at(-1)).toBe(publishedBody);
  expect(count(result.seen, "planner")).toBe(1);
  expect(count(result.seen, "coverage")).toBe(1);
  expect(count(result.seen, "repair")).toBe(0);
  expect(count(result.seen, "writer")).toBe(2);
  expect(count(result.seen, "checker")).toBe(2);
  expect(result.seen).toHaveLength(6);
  expect(result.requests.remaining).toBe(54);
  expect(current.body).toBe(`${base}\n\n${human}`);
});

test("publication preparation keeps restored human references behind the same link gate", async () => {
  const current: WikiPageSnapshot = {
    id: crypto.randomUUID(),
    slug: "guide",
    title: "Guide",
    body: "Old guidance.\n\nHuman note: see #wiki/missing.",
    version: 2,
    revisionId: crypto.randomUUID(),
    parentId: null,
    state: "active",
    citations: [],
  };
  let writers = 0;
  let checkers = 0;
  let publications = 0;
  await expect(
    scenario({
      pages: [current],
      preparePublication: (output) =>
        prepareWikiPublication([{ ...current, generatedBody: "Old guidance." }], output),
      reply: ({ role }) => {
        if (role === "planner")
          return { output: { topics: [topic("guide", ["src/file-0.ts"], null, [current.id])] } };
        if (role === "writer") {
          writers++;
          return {
            output: {
              pages: [
                {
                  id: current.id,
                  title: current.title,
                  body: "Current verified guidance.",
                  sources: ["src/file-0.ts"],
                },
              ],
            },
          };
        }
        checkers++;
        return { output: { issues: [] } };
      },
      onPublish: () => {
        publications++;
      },
    }),
  ).rejects.toThrow("Wiki topic failed bounded quality checks");
  expect(writers).toBe(3);
  expect(checkers).toBe(0);
  expect(publications).toBe(0);
});

test("a small topic without a parent is investigated and written by one agent run", async () => {
  const paths = ["src/file-0.ts", "src/file-1.ts", "src/file-2.ts"];
  const result = await scenario({
    reply: ({ role }) => {
      if (role === "planner") return { output: { topics: [topic("overview", paths, null)] } };
      if (role === "writer") return { output: page("Verified overview.", paths) };
      return { output: { issues: [] } };
    },
  });
  expect(count(result.seen, "investigator")).toBe(0);
  expect(count(result.seen, "writer")).toBe(1);
  // The independent checker still reviews the draft.
  expect(count(result.seen, "checker")).toBe(1);
  const writer = result.seen.find((entry) => entry.role === "writer");
  expect(writer?.prompt["findings"]).toBeUndefined();
  const seeded = (writer?.prompt["sources"] ?? []) as Array<{ path: string }>;
  expect(seeded.map((file) => file.path)).toEqual(paths);
  expect(result.published.map((entry) => entry.slug)).toEqual(["overview"]);
});

test.each(["seeded", "cached tool read"] as const)(
  "a merged existing Wiki update accepts %s evidence, preserves human context and checks the pinned candidate",
  async (mode) => {
    const commit = "8689987fd9f9d05fe8485a41e3e52cca069a9c3e";
    const id = crypto.randomUUID();
    const human = "Human note: ask the team before changing the release window.";
    const current: WikiPageSnapshot = {
      id,
      slug: "application-and-tests",
      title: "Application and tests",
      body: `Existing application guidance.\n\n${human}`,
      version: 3,
      revisionId: crypto.randomUUID(),
      parentId: null,
      state: "active",
      citations: [{ path: "src/file-0.ts", commitSha: "b".repeat(40) }],
    };
    const cited = mode === "seeded" ? "src/file-0.ts" : "src/file-1.ts";
    const source = { path: cited, content: `export const deliveredBehavior = "${commit}";` };
    const body = `The application exposes deliveredBehavior.\n\n${human}`;
    const result = await scenario({
      pages: [current],
      commit,
      sources: mode === "seeded" ? [source] : [],
      readFiles: async (paths) =>
        paths.map((path) =>
          path === cited ? source : { path, content: "export const entrypoint = true;" },
        ),
      reply: ({ role, prompt, index }) => {
        if (role === "planner") {
          if (mode === "cached tool read" && index === 0) return { tool: [cited] };
          return {
            output: {
              topics: [topic("application-and-tests", ["src/file-0.ts"], null, [id])],
            },
          };
        }
        if (role === "writer") {
          expect(prompt["findings"]).toBeUndefined();
          expect(prompt["currentPages"]).toMatchObject([{ id, body: current.body }]);
          if (mode === "cached tool read" && index === 0) return { tool: [cited] };
          if (mode === "seeded") expect(prompt["sources"]).toMatchObject([source]);
          return {
            output: { pages: [{ id, title: current.title, body, sources: [cited] }] },
          };
        }
        if (role === "checker") {
          expect(prompt["sources"]).toEqual([source]);
          expect(prompt["draft"]).toMatchObject({
            pages: [{ id, slug: current.slug, body, sources: [cited] }],
          });
        }
        return { output: { issues: [] } };
      },
    });
    expect(count(result.seen, "investigator")).toBe(0);
    expect(count(result.seen, "writer")).toBe(mode === "seeded" ? 1 : 2);
    expect(count(result.seen, "checker")).toBe(1);
    expect(result.reads.flat().filter((path) => path === cited)).toHaveLength(1);
    expect(result.pages).toMatchObject([
      { id, slug: current.slug, body, citations: [{ path: cited, commitSha: commit }] },
    ]);
    expect(current.body).toBe(`Existing application guidance.\n\n${human}`);
  },
);

test.each([
  ["empty", []],
  ["known but not read in this topic", ["src/file-1.ts"]],
  ["unknown", ["src/not-in-the-inventory.ts"]],
  ["noncanonical", ["./src/file-0.ts"]],
  ["mixed read and unread", ["src/file-0.ts", "src/file-1.ts"]],
] as const)(
  "a merged existing Wiki update still rejects %s citations after three rounds",
  async (_name, citations) => {
    const id = crypto.randomUUID();
    const human = "Human release-window note.";
    const seen: Seen[] = [];
    let published = 0;
    await expect(
      scenario({
        pages: [
          {
            id,
            slug: "application-and-tests",
            title: "Application and tests",
            body: human,
            version: 3,
            revisionId: crypto.randomUUID(),
            parentId: null,
            state: "active",
            citations: [],
          },
        ],
        // Planner evidence and the generation content cache are not permission
        // for a writer to cite a file it never received or read in this topic.
        reply: (entry) => {
          seen.push(entry);
          if (entry.role === "planner") {
            if (entry.index === 0) return { tool: ["src/file-1.ts"] };
            return {
              output: { topics: [topic("application-and-tests", ["src/file-0.ts"], null, [id])] },
            };
          }
          if (entry.role === "writer")
            return {
              output: {
                pages: [
                  {
                    id,
                    title: "Application and tests",
                    body: `${human}\n\nNew behavior.`,
                    sources: [...citations],
                  },
                ],
              },
            };
          return { output: { issues: [] } };
        },
        onPublish: () => {
          published++;
        },
      }),
    ).rejects.toThrow("Wiki topic failed bounded quality checks");
    expect(count(seen, "writer")).toBe(3);
    expect(count(seen, "checker")).toBe(0);
    expect(published).toBe(0);
  },
);

test("a source repair gives exact citation choices and admits a new successful readSource result", async () => {
  const id = crypto.randomUUID();
  const seed = "src/file-0.ts";
  const added = "src/file-1.ts";
  const commit = "8689987fd9f9d05fe8485a41e3e52cca069a9c3e";
  const human = "Human note: coordinate release windows with the team.";
  const current: WikiPageSnapshot = {
    id,
    slug: "application-and-tests",
    title: "Application and tests",
    body: `Existing guidance.\n\n${human}`,
    version: 3,
    revisionId: crypto.randomUUID(),
    parentId: null,
    state: "active",
    citations: [{ path: seed, commitSha: "b".repeat(40) }],
  };
  const source = { path: added, content: "export const submittedBehavior = true;" };
  const body = `The application exposes submittedBehavior.\n\n${human}`;
  const result = await scenario({
    pages: [current],
    commit,
    readFiles: async (paths) =>
      paths.map((path) =>
        path === added ? source : { path, content: "export const entrypoint = true;" },
      ),
    reply: ({ role, index }) => {
      if (role === "planner")
        return { output: { topics: [topic(current.slug, [seed], null, [id])] } };
      if (role === "writer") {
        if (index === 1) return { tool: [added] };
        return {
          output: {
            pages: [
              {
                id,
                title: current.title,
                body: index === 2 ? `${body}\n\nAn unsupported claim.` : body,
                sources: index === 0 ? [] : [added],
              },
            ],
          },
        };
      }
      if (role === "checker")
        return {
          output: { issues: index === 0 ? ["Remove the unsupported claim."] : [] },
        };
      return { output: { issues: [] } };
    },
  });
  const writers = result.seen.filter((entry) => entry.role === "writer");
  expect(writers).toHaveLength(4);
  expect(writers[1]?.system).toContain("Every page.sources must be a nonempty array");
  expect(writers[1]?.prompt).toMatchObject({
    readPaths: [seed],
    issues: ["Wiki update must cite sources actually read"],
    previousDraft: { pages: [{ id, sources: [] }] },
  });
  for (const writer of writers) {
    expect(writer.system).toContain("repository-relative path strings copied exactly");
    expect(writer.system).toContain("readPaths");
    expect(writer.system).toContain("sources[].path");
    expect(writer.system).toContain("successful readSource result");
    expect(writer.system).toContain("Do not use Wiki page IDs, URLs or line suffixes.");
    expect(writer.system).toContain("listDirectory and findFiles");
  }
  // The repair may read outside its starting inventory. The next round lists that read,
  // while unrelated repository paths never become citation evidence automatically.
  expect(writers[0]?.prompt["readPaths"]).toEqual([seed]);
  expect(writers[2]?.prompt["readPaths"]).toEqual([seed]);
  expect(writers[3]?.prompt["readPaths"]).toEqual([seed, added]);
  expect(result.reads).toEqual([[seed], [added]]);
  const checkers = result.seen.filter((entry) => entry.role === "checker");
  expect(checkers).toHaveLength(2);
  for (const checker of checkers) expect(checker.prompt["sources"]).toEqual([source]);
  expect(checkers[1]?.prompt["previousIssues"]).toEqual(["Remove the unsupported claim."]);
  expect(result.published).toMatchObject([{ id, body }]);
  expect(result.pages).toMatchObject([
    { id, body, citations: [{ path: added, commitSha: commit }] },
  ]);
  expect(current.body).toBe(`Existing guidance.\n\n${human}`);
  expect(count(result.seen, "investigator")).toBe(0);
  expect(result.progress.at(-1)?.stats).toMatchObject({ modelSteps: 8, toolRounds: 1 });
});

test.each(["empty", "mixed", "source limit"] as const)(
  "source rejection diagnostics contain bounded safe counts: %s",
  async (mode) => {
    const seed = "src/file-0.ts";
    const unread = "src/file-1.ts";
    const unknown = "src/not-in-the-inventory.ts";
    const malicious = "https://invalid.example/private?token=fixture-only\n[factory] forged log";
    const human = "Human note that must not enter diagnostics.";
    const sourceContent = "Private source content that must not enter diagnostics.";
    const citations =
      mode === "empty"
        ? [[], []]
        : mode === "mixed"
          ? [[], [seed, unread, unread, unknown, malicious]]
          : [Array<string>(64).fill(unread), Array<string>(64).fill(malicious)];
    const counts =
      mode === "empty"
        ? { emptySourceLists: 2, knownUnreadCitations: 0, unknownCitationPaths: 0 }
        : mode === "mixed"
          ? { emptySourceLists: 1, knownUnreadCitations: 2, unknownCitationPaths: 2 }
          : { emptySourceLists: 0, knownUnreadCitations: 64, unknownCitationPaths: 64 };
    const pages: WikiPageSnapshot[] = ["application-and-tests", "test-guide"].map((slug) => ({
      id: crypto.randomUUID(),
      slug,
      title: slug,
      body: human,
      version: 3,
      revisionId: crypto.randomUUID(),
      parentId: null,
      state: "active",
      citations: [],
    }));
    const seen: Seen[] = [];
    const fetched: string[] = [];
    const messages: string[] = [];
    let publications = 0;
    const spies = (["error", "info", "warn", "log", "debug"] as const).map((method) =>
      spyOn(console, method).mockImplementation((...values: unknown[]) => {
        messages.push(values.map(String).join(" "));
      }),
    );
    try {
      await expect(
        scenario({
          pages,
          readFiles: async (paths) => {
            fetched.push(...paths);
            return paths.map((path) => ({ path, content: sourceContent }));
          },
          reply: (entry) => {
            seen.push(entry);
            if (entry.role === "planner") {
              // Globally cached source is still unread in this topic.
              if (entry.index === 0) return { tool: [unread] };
              return {
                output: {
                  topics: [
                    topic(
                      "application-and-tests",
                      [seed],
                      null,
                      pages.map((page) => page.id),
                    ),
                  ],
                },
              };
            }
            if (entry.role === "writer")
              return {
                output: {
                  pages: pages.map((page, index) => ({
                    id: page.id,
                    title: page.title,
                    body: `${human}\n\nUpdated guidance.`,
                    sources: citations[index],
                  })),
                },
              };
            return { output: { issues: [] } };
          },
          onPublish: () => {
            publications++;
          },
        }),
      ).rejects.toThrow("Wiki topic failed bounded quality checks");
      const diagnostics = messages.filter((message) =>
        message.includes("rejected before the check:"),
      );
      expect(diagnostics).toEqual(
        [1, 2, 3].map(
          (round) =>
            `[factory] Wiki topic application-and-tests round ${round} rejected before the check: Wiki update must cite sources actually read | sourceRejections emptySourceLists=${counts.emptySourceLists} knownUnreadCitations=${counts.knownUnreadCitations} unknownCitationPaths=${counts.unknownCitationPaths}`,
        ),
      );
      expect(diagnostics.every((message) => message.length < 400)).toBe(true);
      for (const value of [
        seed,
        unread,
        unknown,
        malicious,
        "fixture-only",
        "forged log",
        human,
        sourceContent,
      ])
        expect(messages.join("\n")).not.toContain(value);
      expect(count(seen, "writer")).toBe(3);
      expect(count(seen, "checker")).toBe(0);
      expect(publications).toBe(0);
      expect(fetched).toEqual([unread, seed]);
      expect(pages.every((page) => page.body === human && page.version === 3)).toBe(true);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  },
);

test("a larger topic keeps its own investigator and a child researches under its unpublished parent", async () => {
  const many = fileList(9).map((file) => file.path);
  const result = await scenario({
    reply: ({ role, prompt }) => {
      const slug = (prompt["topic"] as { slug?: string } | undefined)?.slug;
      if (role === "planner")
        return {
          output: {
            topics: [topic("overview", many, null), topic("guide", ["src/file-0.ts"], "overview")],
          },
        };
      if (role === "investigator")
        return {
          output: { findings: [{ claim: "Verified", paths: [many[0]] }], uncertainties: [] },
        };
      if (role === "writer") return { output: page(`Body of ${slug}.`, [many[0] ?? ""]) };
      return { output: { issues: [] } };
    },
  });
  expect(count(result.seen, "investigator")).toBe(2);
  expect(result.published.map((entry) => entry.slug)).toEqual(["overview", "guide"]);
});

test.each(["investigator", "writer"] as const)(
  "the %s may read for a bounded number of rounds and is then told to answer",
  async (role) => {
    const paths = role === "writer" ? ["src/file-0.ts"] : fileList(9).map((file) => file.path);
    const readers: Role[] = [];
    const result = await scenario({
      reply: ({ role: current, toolChoice }) => {
        if (current === "planner") return { output: { topics: [topic("overview", paths, null)] } };
        if (current === role) {
          readers.push(current);
          // Left to itself the agent would read forever.
          if (toolChoice !== "none") return { tool: ["src/file-5.ts"] };
          if (role === "investigator")
            return {
              output: { findings: [{ claim: "Verified", paths: [paths[0]] }], uncertainties: [] },
            };
          return { output: page("Verified overview.", ["src/file-0.ts"]) };
        }
        if (current === "writer") return { output: page("Verified overview.", [paths[0] ?? ""]) };
        return { output: { issues: [] } };
      },
    });
    // Three tool rounds, then one answer with tools switched off.
    expect(readers).toHaveLength(4);
    expect(result.published).toHaveLength(1);
    const stats = result.progress.at(-1)?.stats;
    expect(stats?.toolRounds).toBeGreaterThanOrEqual(3);
  },
);

test.each([
  ["rewording only", ["src/other.ts"], "Run `npm test` to verify the editor within 5 minutes.", 0],
  [
    "cited file changed",
    ["src/file-0.ts"],
    "Run `npm test` to verify the editor within 5 minutes.",
    1,
  ],
  [
    "new fact added",
    ["src/other.ts"],
    "Run `npm run build` to verify the editor within 5 minutes.",
    1,
  ],
] as const)(
  "the independent checker is skipped only when a checked page is merely reworded: %s",
  async (_name, changedPaths, body, checks) => {
    const id = crypto.randomUUID();
    const existing: WikiPageSnapshot = {
      id,
      slug: "guide",
      title: "Guide",
      body: "To verify the editor run `npm test`. It finishes within 5 minutes.",
      version: 2,
      revisionId: crypto.randomUUID(),
      parentId: null,
      state: "active",
      citations: [],
    };
    const result = await scenario({
      pages: [existing],
      changedPaths: [...changedPaths],
      reply: ({ role }) => {
        if (role === "planner")
          return { output: { topics: [topic("guide-update", ["src/file-0.ts"], null, [id])] } };
        if (role === "writer")
          return { output: { pages: [{ id, title: "Guide", body, sources: ["src/file-0.ts"] }] } };
        return { output: { issues: [] } };
      },
    });
    expect(count(result.seen, "checker")).toBe(checks);
    expect(result.published).toHaveLength(1);
  },
);

test("a rejected draft is repaired once, then the topic fails its quality check", async () => {
  const run = scenario({
    reply: ({ role }) => {
      if (role === "planner")
        return { output: { topics: [topic("overview", ["src/file-0.ts"], null)] } };
      if (role === "writer") return { output: page("Draft.") };
      if (role === "checker") return { output: { issues: ["Invented claim"] } };
      return { output: { issues: [] } };
    },
  });
  await expect(run).rejects.toThrow("Wiki topic failed bounded quality checks");
});

test("style-only findings earn one repair and never fail the topic", async () => {
  const seen: Seen[] = [];
  let checks = 0;
  const result = await scenario({
    reply: (entry) => {
      seen.push(entry);
      if (entry.role === "planner")
        return { output: { topics: [topic("overview", ["src/file-0.ts"], null)] } };
      if (entry.role === "writer") return { output: page("Draft.") };
      if (entry.role === "checker")
        return {
          output: {
            issues: [],
            advisory: [checks++ === 0 ? "Move one sentence" : "Still unhappy"],
          },
        };
      return { output: { issues: [] } };
    },
  });
  expect([count(seen, "writer"), count(seen, "checker")]).toEqual([2, 2]);
  expect(result.published.map((entry) => entry.slug)).toEqual(["overview"]);
});

test("the writer and checker run exactly three times for a draft that never passes", async () => {
  const seen: Seen[] = [];
  await scenario({
    reply: (entry) => {
      seen.push(entry);
      if (entry.role === "planner")
        return { output: { topics: [topic("overview", ["src/file-0.ts"], null)] } };
      if (entry.role === "writer") return { output: page("Draft.") };
      if (entry.role === "checker") return { output: { issues: ["Invented claim"] } };
      return { output: { issues: [] } };
    },
  }).catch(() => undefined);
  expect([count(seen, "writer"), count(seen, "checker")]).toEqual([3, 3]);
});

test("coverage repair finishes before topics start and its new guide follows the checked parent", async () => {
  const paths = ["src/file-0.ts"];
  const overview = topic("overview", paths, null);
  const setup = topic("setup", paths, "overview");
  let coverageAnswered = 0;
  let writerStarted = 0;
  const result = await scenario({
    sources: [{ path: "src/file-0.ts", content: "Setup guidance." }],
    coverage: async ({ prompt }) => {
      await Bun.sleep(50);
      coverageAnswered = performance.now();
      return {
        output: {
          findings: prompt["previousFindings"]
            ? []
            : [
                {
                  kind: "actionable",
                  readerTask: "Setup",
                  requiredChange: "Add missing setup guidance.",
                  sourcePaths: paths,
                },
              ],
        },
      };
    },
    reply: async ({ role, prompt }) => {
      if (role === "planner") return { output: { topics: [overview] } };
      if (role === "repair") {
        expect(prompt["plannedTopics"]).toEqual([overview]);
        return { output: { topics: [overview, setup] } };
      }
      if (role === "investigator")
        return { output: { findings: [{ claim: "Verified", paths }], uncertainties: [] } };
      if (role === "writer") {
        writerStarted ||= performance.now();
        return {
          output: page(`Body of ${(prompt["topic"] as { slug: string }).slug}.`, paths),
        };
      }
      return { output: { issues: [] } };
    },
  });
  expect(writerStarted).toBeGreaterThan(0);
  expect(writerStarted).toBeGreaterThan(coverageAnswered);
  expect(count(result.seen, "repair")).toBe(1);
  expect(count(result.seen, "coverage")).toBe(2);
  expect(result.published.map((entry) => entry.slug)).toEqual(["overview", "setup"]);
  expect(result.progress.at(-1)).toMatchObject({ topicsTotal: 2, topicsDone: 2 });
});

test.each(["valid root update", "unresolved duplicate", "dropped useful task"] as const)(
  "coverage can correct a full plan before any topic claims its pages: %s",
  async (repair) => {
    const paths: [string] = ["src/file-0.ts"];
    const human = "Human release-team handover note.";
    const root: WikiPageSnapshot = {
      id: crypto.randomUUID(),
      slug: "overview",
      title: "Project",
      body: `Previous project orientation.\n\n${human}`,
      version: 3,
      revisionId: crypto.randomUUID(),
      parentId: null,
      state: "active",
      citations: [],
    };
    const pages = [
      root,
      ...["application-and-tests", "production"].map((slug) => ({
        ...root,
        id: crypto.randomUUID(),
        slug,
        body: `Existing ${slug} guidance.`,
        parentId: root.id,
      })),
    ];
    const topics = [
      topic(root.slug, paths, null, [root.id]),
      topic("orientation-copy", paths, root.slug),
      ...["account-walkthrough", "pre-demo-checklist", "demo-accounts", "session-workflow"].map(
        (slug) => topic(slug, paths, root.slug),
      ),
    ];
    const repairInputs: WikiPageSnapshot[][] = [];
    let publications = 0;
    let writing = 0;
    let maximumWriting = 0;
    let currentPages: readonly WikiPageSnapshot[] = pages;
    const run = scenario({
      pages,
      sources: [{ path: paths[0], content: "Current project orientation and demo guidance." }],
      coverage: ({ prompt }) => {
        if (prompt["previousFindings"]) {
          expect(prompt["previousTopics"]).toEqual(topics);
          expect(publications).toBe(0);
        }
        return {
          output: {
            findings:
              prompt["previousFindings"] && repair === "valid root update"
                ? []
                : [
                    {
                      kind: "actionable",
                      readerTask:
                        prompt["previousFindings"] && repair === "dropped useful task"
                          ? "Account walkthrough"
                          : "Project orientation",
                      requiredChange:
                        prompt["previousFindings"] && repair === "dropped useful task"
                          ? "Restore the account-walkthrough task lost by this repair."
                          : "Remove orientation-copy and correct the planned overview update, preserving its human handover.",
                      sourcePaths: paths,
                    },
                  ],
          },
        };
      },
      reply: async ({ role, prompt }) => {
        if (role === "planner") return { output: { topics } };
        if (role === "repair") {
          expect(publications).toBe(0);
          expect(prompt["plannedTopics"]).toEqual(topics);
          repairInputs.push(prompt["currentPages"] as WikiPageSnapshot[]);
          return {
            output: {
              topics:
                repair === "valid root update"
                  ? topics
                      .filter((topic) => topic.slug !== "orientation-copy")
                      .map((topic) =>
                        topic.slug === root.slug
                          ? { ...topic, purpose: "Correct project orientation; preserve handover." }
                          : topic,
                      )
                  : repair === "dropped useful task"
                    ? [topics[0]]
                    : topics,
            },
          };
        }
        if (role === "investigator")
          return { output: { findings: [{ claim: "Demo guidance.", paths }], uncertainties: [] } };
        if (role === "writer") {
          maximumWriting = Math.max(maximumWriting, ++writing);
          await Bun.sleep(20);
          writing--;
          const current = prompt["topic"] as ReturnType<typeof topic>;
          return {
            output:
              current.pageIDs.length > 0
                ? {
                    pages: [
                      {
                        id: root.id,
                        title: root.title,
                        body: `Current project orientation.\n\n${human}`,
                        sources: paths,
                      },
                    ],
                  }
                : page(`Use the ${current.slug} for its reader task.`, paths),
          };
        }
        return { output: { issues: [] } };
      },
      onPublish: (_output, pages) => {
        currentPages = pages;
        publications++;
      },
    });
    if (repair !== "valid root update") {
      await expect(run).rejects.toThrow("Wiki topic plan omits essential reader coverage");
      expect(publications).toBe(0);
      expect(currentPages).toContainEqual(root);
    } else {
      const result = await run;
      expect(result.published.map((entry) => entry.slug).sort()).toEqual(
        topics
          .filter((topic) => topic.slug !== "orientation-copy")
          .map((topic) => topic.slug)
          .sort(),
      );
      expect(result.pages.find((page) => page.id === root.id)?.body).toBe(
        `Current project orientation.\n\n${human}`,
      );
      expect(count(result.seen, "planner")).toBe(1);
      expect(count(result.seen, "coverage")).toBe(2);
      expect(count(result.seen, "repair")).toBe(1);
      expect(maximumWriting).toBeGreaterThan(1);
      expect(maximumWriting).toBeLessThanOrEqual(maximumTopicConcurrency);
      expect(result.pages.filter((page) => page.id !== root.id)).toEqual(
        expect.arrayContaining(pages.slice(1)),
      );
      expect(result.progress.at(-1)).toMatchObject({ topicsTotal: 5, topicsDone: 5 });
    }
    expect(repairInputs).toEqual([pages]);
    expect(currentPages).toHaveLength(repair === "valid root update" ? 7 : 3);
    expect(pages.every((page) => currentPages.some((current) => current.id === page.id))).toBe(
      true,
    );
    expect(root.body).toBe(`Previous project orientation.\n\n${human}`);
  },
);

test("an empty coverage repair fails even when another topic is already planned", async () => {
  const paths = ["src/file-0.ts"];
  let repairs = 0;
  let publications = 0;
  await expect(
    scenario({
      pages: [
        {
          id: crypto.randomUUID(),
          slug: "overview",
          title: "Project",
          body: "Short orientation.",
          version: 1,
          revisionId: crypto.randomUUID(),
          parentId: null,
          state: "active",
          citations: [],
        },
      ],
      sources: [{ path: "src/file-0.ts", content: "Run the local verification checks." }],
      coverage: () => ({
        output: {
          findings: [
            {
              kind: "actionable",
              readerTask: "Verification",
              requiredChange: "Add the missing verification guide beyond the short overview.",
              sourcePaths: paths,
            },
          ],
        },
      }),
      reply: ({ role }) => {
        if (role === "planner")
          return { output: { topics: [topic("local-workflow", paths, "overview")] } };
        if (role === "repair") {
          repairs++;
          return { output: { topics: [] } };
        }
        if (role === "writer") return { output: page("Short orientation.", paths) };
        return { output: { issues: [] } };
      },
      onPublish: () => {
        publications++;
      },
    }),
  ).rejects.toThrow("Wiki topic plan omits essential reader coverage");
  expect(repairs).toBe(1);
  expect(publications).toBe(0);
});

test.each(["no findings", "checked nonissue"] as const)(
  "a sufficient single guide needs no extra planning despite several README headings: %s",
  async (review) => {
    const body =
      "Install with npm ci. Start the Forms editor with npm run dev. " +
      "The editor stores local drafts. Verify changes with npm test.";
    const readme = {
      path: "README.md",
      content: [
        "# Forms",
        "## Installation\nInstall with npm ci.",
        "## Usage\nStart the Forms editor with npm run dev.",
        "## Architecture\nThe editor stores local drafts.",
        "## Verification\nVerify changes with npm test.",
      ].join("\n\n"),
    };
    const result = await scenario({
      inventory: [{ path: readme.path, sha: "b".repeat(40), size: readme.content.length }],
      sources: [readme],
      readFiles: async () => [readme],
      coverage: () => ({
        output: {
          findings:
            review === "no findings"
              ? []
              : [
                  {
                    kind: "nonissue",
                    reason: "One Forms guide covers the supported setup, editor and checks.",
                  },
                ],
        },
      }),
      reply: ({ role }) => {
        if (role === "planner")
          return { output: { topics: [topic("overview", [readme.path], null)] } };
        if (role === "writer") return { output: page(body, [readme.path]) };
        return { output: { topics: [], issues: [] } };
      },
    });
    expect(count(result.seen, "repair")).toBe(0);
    expect(count(result.seen, "coverage")).toBe(1);
    expect(result.published.map((entry) => entry.slug)).toEqual(["overview"]);
    expect(result.published[0]?.body).toBe(body);
    expect(result.seen).toHaveLength(4);
    expect(result.requests.remaining).toBe(56);
  },
);

test.each(["reject duplicate", "reject completed duplicate", "update owner"] as const)(
  "coverage resolves a redundant unstarted topic before publication: %s",
  async (repair) => {
    const human = "Human handover: arrange the demo with the release team.";
    const owner: WikiPageSnapshot = {
      id: crypto.randomUUID(),
      slug: "forms-development",
      title: "Forms development",
      body: `Run npm run dev. Verify with npm test.\n\n${human}`,
      version: 3,
      revisionId: crypto.randomUUID(),
      parentId: null,
      state: "active",
      citations: [],
    };
    const source = {
      path: "docs/forms.md",
      content:
        repair === "update owner"
          ? "Run npm run dev. Verify with npm run check."
          : "Run npm run dev. Verify with npm test.",
    };
    const duplicate = topic("local-setup-copy", [source.path], null);
    let coverageAnswered = false;
    const writing: Array<{ reviewed: boolean; topic: unknown; pages: unknown }> = [];
    const preparePublication = (output: WikiGenerationOutput) =>
      prepareWikiPublication(
        [{ ...owner, generatedBody: "Run npm run dev. Verify with npm test." }],
        output,
      );
    const result = await scenario({
      pages: [owner],
      ...(repair === "reject completed duplicate" ? { completedPageIDs: [owner.id] } : {}),
      inventory: [{ path: source.path, sha: "b".repeat(40), size: source.content.length }],
      sources: [source],
      readFiles: async () => [source],
      preparePublication,
      coverage: async ({ prompt }) => {
        await Bun.sleep(50);
        coverageAnswered = true;
        if (prompt["previousFindings"]) return { output: { findings: [] } };
        return {
          output: {
            findings: [
              {
                kind: "actionable",
                readerTask: "Local setup and verification",
                requiredChange:
                  repair === "update owner"
                    ? `Replace local-setup-copy with an update to ${owner.slug}, which owns this task. Correct npm test to npm run check and preserve the human handover.`
                    : `Reject local-setup-copy because ${owner.slug} already covers its task. No current page needs changing.`,
                sourcePaths: [source.path],
              },
            ],
          },
        };
      },
      reply: ({ role, prompt }) => {
        if (role === "planner") return { output: { topics: [duplicate] } };
        if (role === "repair")
          return {
            output: {
              topics:
                repair === "update owner"
                  ? [topic(owner.slug, [source.path], null, [owner.id])]
                  : [],
            },
          };
        if (role === "writer") {
          writing.push({
            reviewed: coverageAnswered,
            topic: prompt["topic"],
            pages: prompt["currentPages"],
          });
          if (!(prompt["topic"] as ReturnType<typeof topic>).pageIDs.length)
            return { output: page(source.content, [source.path]) };
          return {
            output: {
              pages: [
                { id: owner.id, title: owner.title, body: source.content, sources: [source.path] },
              ],
            },
          };
        }
        if (
          role === "checker" &&
          (prompt["draft"] as WikiGenerationOutput).pages[0]?.id === owner.id
        )
          expect((prompt["draft"] as WikiGenerationOutput).pages[0]?.body).toContain(human);
        return { output: { issues: [] } };
      },
      onPublish: (output, pages) => {
        const published = preparePublication(output).pages[0];
        const current = pages.find((page) => page.id === owner.id);
        if (published?.id === owner.id && current) current.body = published.body;
      },
    });
    expect(count(result.seen, "repair")).toBe(1);
    expect(count(result.seen, "coverage")).toBe(2);
    expect(writing).toEqual(
      repair === "update owner"
        ? [
            {
              reviewed: true,
              topic: topic(owner.slug, [source.path], null, [owner.id]),
              pages: [owner],
            },
          ]
        : [],
    );
    expect(result.published.map((entry) => entry.slug)).toEqual(
      repair === "update owner" ? [owner.slug] : [],
    );
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.id).toBe(owner.id);
    if (repair === "update owner")
      expect(result.pages[0]?.body).toBe(`${source.content}\n\n${human}`);
    else expect(result.pages[0]).toEqual(owner);
    expect(owner.body).toBe(`Run npm run dev. Verify with npm test.\n\n${human}`);
  },
);

test.each(["repeated owner", "completed owner", "removed parent"] as const)(
  "a repaired plan cannot claim a %s before any writer starts",
  async (fault) => {
    const owner: WikiPageSnapshot = {
      id: crypto.randomUUID(),
      slug: "overview",
      title: "Forms",
      body: "Forms development guidance.\n\nHuman release-team handover.",
      version: 3,
      revisionId: crypto.randomUUID(),
      parentId: null,
      state: "active",
      citations: [],
    };
    const source = { path: "docs/forms.md", content: "Current Forms development guidance." };
    const paths = [source.path];
    const duplicate = topic("forms-copy", paths, owner.slug);
    const update = topic(owner.slug, paths, null, [owner.id]);
    const badTopics =
      fault === "repeated owner"
        ? [update, topic("second-owner", paths, null, [owner.id])]
        : fault === "completed owner"
          ? [update]
          : [topic("child", paths, duplicate.slug)];
    const seen: Seen[] = [];
    let publications = 0;
    await expect(
      scenario({
        pages: [owner],
        ...(fault === "completed owner" ? { completedPageIDs: [owner.id] } : {}),
        inventory: [{ path: source.path, sha: "b".repeat(40), size: source.content.length }],
        sources: [source],
        coverage: () => ({
          output: {
            findings: [
              {
                kind: "actionable",
                readerTask: "Forms development",
                requiredChange: "Remove forms-copy, which repeats the existing overview task.",
                sourcePaths: paths,
              },
            ],
          },
        }),
        reply: (entry) => {
          seen.push(entry);
          if (entry.role === "planner") return { output: { topics: [duplicate] } };
          if (entry.role === "repair") return { output: { topics: badTopics } };
          return { output: { issues: [] } };
        },
        onPublish: () => {
          publications++;
        },
      }),
    ).rejects.toThrow(
      fault === "removed parent"
        ? "Every parent must name an earlier planned topic"
        : "Unavailable or repeated pageIDs",
    );
    expect(count(seen, "planner")).toBe(1);
    expect(count(seen, "repair")).toBe(2);
    expect(count(seen, "writer")).toBe(0);
    expect(count(seen, "investigator")).toBe(0);
    expect(publications).toBe(0);
    expect(owner).toMatchObject({
      body: "Forms development guidance.\n\nHuman release-team handover.",
      version: 3,
    });
  },
);

test("a write that ends before its JSON is retried with a larger budget and a request for less", async () => {
  const writers: Seen[] = [];
  const result = await scenario({
    reply: (entry) => {
      if (entry.role === "planner")
        return { output: { topics: [topic("overview", ["src/file-0.ts"], null)] } };
      if (entry.role === "writer") {
        writers.push(entry);
        if (writers.length === 1)
          return { raw: '{"pages":[{"body":"A page that stops mid', finish: "length" };
        return { output: page("Short verified page.") };
      }
      return { output: { issues: [] } };
    },
  });
  expect(writers).toHaveLength(2);
  expect(writers[1]?.maxTokens).toBe((writers[0]?.maxTokens ?? 0) * 2);
  expect(writers[1]?.prompt.correction).toContain("Return a shorter result");
  expect(result.published).toHaveLength(1);
});

test("a failed repair gets one last minimal JSON-only request before the result is refused", async () => {
  const writers: Seen[] = [];
  const result = await scenario({
    reply: (entry) => {
      if (entry.role === "planner")
        return { output: { topics: [topic("overview", ["src/file-0.ts"], null)] } };
      if (entry.role === "writer") {
        writers.push(entry);
        // Two pages for a new topic break its schema twice.
        if (writers.length < 3)
          return { output: { pages: [...page("One.").pages, ...page("Two.").pages] } };
        return { output: page("Valid page.") };
      }
      return { output: { issues: [] } };
    },
  });
  expect(writers).toHaveLength(3);
  expect(writers[2]?.prompt.correction).toContain("Return only the JSON for this schema");
  expect(writers[2]?.toolChoice).toBe("none");
  expect(result.published).toHaveLength(1);
});

test("a result that stays invalid through every attempt fails with the format error", async () => {
  const writers: Seen[] = [];
  const run = scenario({
    reply: (entry) => {
      if (entry.role === "planner")
        return { output: { topics: [topic("overview", ["src/file-0.ts"], null)] } };
      if (entry.role === "writer") {
        writers.push(entry);
        return { output: { pages: [] } };
      }
      return { output: { issues: [] } };
    },
  });
  await expect(run).rejects.toThrow("Structured output validation failed");
  expect(writers).toHaveLength(3);
});

test("a stray title or slug from the writer of a new topic is dropped instead of refusing the page", async () => {
  const writers: Seen[] = [];
  const result = await scenario({
    reply: (entry) => {
      if (entry.role === "planner")
        return { output: { topics: [topic("overview", ["src/file-0.ts"], null)] } };
      if (entry.role === "writer") {
        writers.push(entry);
        return {
          output: {
            pages: [
              {
                title: "Own title",
                slug: "own-slug",
                body: "Verified.",
                sources: ["src/file-0.ts"],
              },
            ],
          },
        };
      }
      return { output: { issues: [] } };
    },
  });
  expect(writers).toHaveLength(1);
  expect(result.published[0]).toMatchObject({ slug: "overview", title: "Title overview" });
});

test("a footer and a link to a guide planned for later need no repair round", async () => {
  const paths = ["src/file-0.ts"];
  const writers: Seen[] = [];
  const result = await scenario({
    reply: (entry) => {
      if (entry.role === "planner")
        return {
          output: { topics: [topic("overview", paths, null), topic("setup", paths, "overview")] },
        };
      if (entry.role === "investigator")
        return { output: { findings: [{ claim: "Verified", paths }], uncertainties: [] } };
      if (entry.role === "writer") {
        writers.push(entry);
        return {
          output: page("See [Setup](#wiki/setup) next.\n\n## Sources\n\n- src/file-0.ts", paths),
        };
      }
      return { output: { issues: [] } };
    },
  });
  expect(writers).toHaveLength(2);
  expect(result.published[0]?.body).toBe("See Setup next.");
});

test("in a new Wiki a guide the planner left without parent goes under the overview and may be long", async () => {
  const paths = ["src/file-0.ts"];
  const result = await scenario({
    reply: ({ role, prompt }) => {
      if (role === "planner")
        return {
          output: { topics: [topic("overview", paths, null), topic("guide", paths, null)] },
        };
      if (role === "investigator")
        return { output: { findings: [{ claim: "Verified", paths }], uncertainties: [] } };
      if (role === "writer") {
        const slug = (prompt["topic"] as { slug: string }).slug;
        return { output: page(slug === "guide" ? "Long guide. ".repeat(200) : "Short.", paths) };
      }
      return { output: { issues: [] } };
    },
  });
  expect(result.published.map((entry) => [entry.slug, entry.parentSlug])).toEqual([
    ["overview", null],
    ["guide", "overview"],
  ]);
});

test("an empty pages list for a new topic is refused and repaired, not published", async () => {
  const writers: Seen[] = [];
  const result = await scenario({
    reply: (entry) => {
      if (entry.role === "planner")
        return { output: { topics: [topic("overview", ["src/file-0.ts"], null)] } };
      if (entry.role === "writer") {
        writers.push(entry);
        return writers.length === 1 ? { output: { pages: [] } } : { output: page("Overview.") };
      }
      return { output: { issues: [] } };
    },
  });
  expect(writers).toHaveLength(2);
  expect(result.published).toHaveLength(1);
});

test("the repair sees the previous draft and issues, and the final check is judged against them", async () => {
  const seen: Seen[] = [];
  const result = await scenario({
    reply: (entry) => {
      seen.push(entry);
      if (entry.role === "planner")
        return { output: { topics: [topic("overview", ["src/file-0.ts"], null)] } };
      if (entry.role === "writer") return { output: page(`Draft ${entry.index}.`) };
      if (entry.role === "checker")
        return { output: { issues: entry.index === 0 ? ["Unsupported claim in the draft"] : [] } };
      return { output: { issues: [] } };
    },
  });
  const writers = seen.filter((entry) => entry.role === "writer");
  const checkers = seen.filter((entry) => entry.role === "checker");
  // A first draft carries no empty previousDraft that would invite an empty answer.
  expect(writers[0]?.prompt["previousDraft"]).toBeUndefined();
  expect(writers[1]?.prompt["previousDraft"]).toBeDefined();
  expect(writers[1]?.prompt["issues"]).toEqual(["Unsupported claim in the draft"]);
  expect(checkers[0]?.prompt["previousIssues"]).toBeUndefined();
  expect(checkers[1]?.prompt["previousIssues"]).toEqual(["Unsupported claim in the draft"]);
  expect(result.published).toHaveLength(1);
});
