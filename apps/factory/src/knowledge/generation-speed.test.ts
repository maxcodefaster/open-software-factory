import { expect, spyOn, test } from "bun:test";
import type {
  WikiGenerationOutput,
  WikiGenerationProgress,
  WikiPageSnapshot,
} from "../../../../packages/knowledge-domain/src/generation";
import { generateWiki } from "./generation-workflow";

type Role = "planner" | "coverage" | "additional" | "investigator" | "writer" | "checker";
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
  changedPaths?: string[];
  commit?: string;
  sources?: Array<{ path: string; content: string }>;
  inventory?: Array<{ path: string; sha: string; size: number }>;
  readFiles?(paths: string[]): Promise<Array<{ path: string; content: string }>>;
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
        : system.includes("Return only the additional topics")
          ? "additional"
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
      modelId: "controlled-wiki",
      connection: {
        provider: "openai",
        baseURL: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "owned-test-not-a-secret",
      },
      pages,
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

test("the first topic starts while the coverage review runs and its extra guides follow", async () => {
  const paths = ["src/file-0.ts"];
  let coverageAnswered = 0;
  let writerStarted = 0;
  const result = await scenario({
    sources: [{ path: "src/file-0.ts", content: "Setup guidance." }],
    coverage: async () => {
      await Bun.sleep(400);
      coverageAnswered = performance.now();
      return {
        output: {
          findings: [
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
      if (role === "planner") return { output: { topics: [topic("overview", paths, null)] } };
      if (role === "additional") return { output: { topics: [topic("setup", paths, "overview")] } };
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
  expect(writerStarted).toBeLessThan(coverageAnswered);
  expect(result.published.map((entry) => entry.slug)).toEqual(["overview", "setup"]);
  expect(result.progress.at(-1)).toMatchObject({ topicsTotal: 2, topicsDone: 2 });
});

test.each(["valid root update", "repeated duplicate"] as const)(
  "coverage planning refreshes its existing repair after progressive publication: %s",
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
      topic("account-walkthrough", paths, root.slug),
      topic("pre-demo-checklist", paths, root.slug),
    ] as const;
    const deltaStarted = Promise.withResolvers<void>();
    const twoPublished = Promise.withResolvers<void>();
    const deltaInputs: WikiPageSnapshot[][] = [];
    let publications = 0;
    let currentPages: readonly WikiPageSnapshot[] = pages;
    const run = scenario({
      pages,
      sources: [{ path: paths[0], content: "Current project orientation and demo guidance." }],
      coverage: () => ({
        output: {
          findings: [
            {
              kind: "actionable",
              readerTask: "Project orientation",
              requiredChange: "Update the old orientation while preserving the human handover.",
              sourcePaths: paths,
            },
          ],
        },
      }),
      reply: async ({ role, prompt, index }) => {
        if (role === "planner") return { output: { topics } };
        if (role === "additional") {
          const input = prompt.input ?? prompt;
          const current = input["currentPages"] as WikiPageSnapshot[];
          deltaInputs.push(current);
          if (index === 0) {
            deltaStarted.resolve();
            await twoPublished.promise;
          } else {
            expect(prompt.correction).toContain("Repeated topic slug: account-walkthrough");
            expect(prompt["rejectedResult"]).toEqual({ topics: [topics[0]] });
          }
          return {
            output: {
              topics:
                index === 1 && repair === "valid root update" && current.length === 5
                  ? [topic(root.slug, paths, null, [root.id])]
                  : [topics[0]],
            },
          };
        }
        if (role === "writer") {
          await deltaStarted.promise;
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
        if (++publications === 2) twoPublished.resolve();
      },
    });
    if (repair === "repeated duplicate") {
      await expect(run).rejects.toThrow("Repeated topic slug: account-walkthrough");
      expect(publications).toBe(2);
      expect(currentPages).toContainEqual(root);
    } else {
      const result = await run;
      expect(result.published.map((entry) => entry.slug)).toEqual([
        topics[0].slug,
        topics[1].slug,
        root.slug,
      ]);
      expect(result.pages.find((page) => page.id === root.id)?.body).toBe(
        `Current project orientation.\n\n${human}`,
      );
      expect(deltaInputs.map((pages) => pages.length)).toEqual([3, 5]);
      expect(count(result.seen, "planner")).toBe(1);
      expect(count(result.seen, "coverage")).toBe(1);
      expect(result.progress.at(-1)).toMatchObject({ topicsTotal: 3, topicsDone: 3 });
    }
    expect(deltaInputs).toHaveLength(2);
    expect(currentPages).toHaveLength(5);
    expect(pages.every((page) => currentPages.some((current) => current.id === page.id))).toBe(
      true,
    );
    expect(root.body).toBe(`Previous project orientation.\n\n${human}`);
  },
);

test("an empty coverage repair fails even when another topic is already planned", async () => {
  const paths = ["src/file-0.ts"];
  let repairs = 0;
  await expect(
    scenario({
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
        if (role === "planner") return { output: { topics: [topic("overview", paths, null)] } };
        if (role === "additional") {
          repairs++;
          return { output: { topics: [] } };
        }
        if (role === "writer") return { output: page("Short orientation.", paths) };
        return { output: { issues: [] } };
      },
    }),
  ).rejects.toThrow("Wiki topic plan omits essential reader coverage");
  expect(repairs).toBe(1);
});

test("a new Wiki with several documented areas and a single topic gets one more planning request", async () => {
  const readme = {
    path: "README.md",
    content: [
      "# Product",
      "## Installation",
      "## Usage",
      "## Architecture",
      "## Verification",
    ].join("\n\nText.\n\n"),
  };
  const inventory = [...fileList(4), { path: "README.md", sha: "b".repeat(40), size: 100 }];
  const result = await scenario({
    inventory,
    sources: [readme],
    reply: ({ role, prompt }) => {
      if (role === "planner")
        return { output: { topics: [topic("overview", ["README.md"], null)] } };
      if (role === "additional") {
        expect(JSON.stringify(prompt)).toContain("documents 4 reader areas");
        return { output: { topics: [topic("usage", ["README.md"], "overview")] } };
      }
      if (role === "investigator")
        return {
          output: { findings: [{ claim: "Verified", paths: ["README.md"] }], uncertainties: [] },
        };
      if (role === "writer") return { output: page("Body.", ["README.md"]) };
      return { output: { issues: [] } };
    },
  });
  expect(count(result.seen, "additional")).toBe(1);
  expect(result.published.map((entry) => entry.slug)).toEqual(["overview", "usage"]);
});

test("a single topic is accepted when the documentation names fewer than three areas", async () => {
  const readme = { path: "README.md", content: "# Product\n\n## Usage\n\nText.\n" };
  const result = await scenario({
    inventory: [...fileList(2), { path: "README.md", sha: "b".repeat(40), size: 30 }],
    sources: [readme],
    reply: ({ role }) => {
      if (role === "planner")
        return { output: { topics: [topic("overview", ["README.md"], null)] } };
      if (role === "writer") return { output: page("Body.", ["README.md"]) };
      return { output: { issues: [] } };
    },
  });
  expect(count(result.seen, "additional")).toBe(0);
  expect(result.published).toHaveLength(1);
});

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
