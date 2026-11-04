import { expect, test } from "bun:test";
import type {
  WikiGenerationProgress,
  WikiPageSnapshot,
} from "../../../../packages/knowledge-domain/src/generation";
import { generateWiki } from "./generation-workflow";

type Role = "planner" | "coverage" | "additional" | "investigator" | "writer" | "checker";
type Seen = {
  role: Role;
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
  files?: number;
  pages?: WikiPageSnapshot[];
  changedPaths?: string[];
  sources?: Array<{ path: string; content: string }>;
  inventory?: Array<{ path: string; sha: string; size: number }>;
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
        prompt: JSON.parse(user.slice(user.indexOf("{"), user.lastIndexOf("}") + 1)),
        ...(incoming.tool_choice ? { toolChoice: incoming.tool_choice } : {}),
        ...((incoming.max_completion_tokens ?? incoming.max_tokens)
          ? { maxTokens: incoming.max_completion_tokens ?? incoming.max_tokens }
          : {}),
        index: seen.filter((candidate) => candidate.role === role).length,
        at: performance.now(),
      };
      seen.push(entry);
      const reply = await options.reply(entry);
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
      commit: "a".repeat(40),
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
      readFiles: async (paths) =>
        paths.map((path) => ({ path, content: `export const value = "${path}";` })),
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
            citations: page.sources.map((path) => ({ path, commitSha: "a".repeat(40) })),
          };
          if (index >= 0) pages[index] = next;
          else pages = [...pages, next];
        }
        return pages;
      },
    });
    return { outcome, seen, published, progress, requests };
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
    reply: async ({ role, prompt }) => {
      if (role === "planner") return { output: { topics: [topic("overview", paths, null)] } };
      if (role === "coverage") {
        await Bun.sleep(400);
        coverageAnswered = performance.now();
        return { output: { issues: ["Setup guidance is missing"] } };
      }
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
