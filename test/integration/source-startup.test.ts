import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { sourceStartupContract } from "../../apps/factory/src/workspace/source-startup";
import type { SubstrateSourceLease } from "../../apps/factory/src/workspace/substrate-source";
import {
  project,
  projectSetupConfirmation,
  projectSetupInspection,
  substrateSource,
  workspaceSharedDocument,
} from "../../packages/db/src/schema";
import type { SetupInspectionOutput } from "../../packages/project-domain/src/setup";
import { substrateFixture } from "../fixtures/substrate";

const revision = "a".repeat(40);
const systemPath = ".factory/system.json";
const contract = {
  version: 1 as const,
  primaryApp: "web",
  apps: [
    { id: "web", label: "Owned app", command: ["node", "server.mjs"], port: 4300, healthPath: "/" },
  ],
};
const proposal: SetupInspectionOutput = {
  purpose: "Owned Source startup fixture",
  services: [],
  uncertainty: [],
  questions: [],
  files: [
    {
      path: ".devcontainer/devcontainer.json",
      content: JSON.stringify({
        image: "example.invalid/owned-development:fixture",
        workspaceFolder: "/workspace/project",
      }),
    },
    { path: systemPath, content: JSON.stringify(contract) },
    {
      path: ".forgejo/workflows/factory-verification.yml",
      content:
        "on: pull_request\njobs:\n  verify:\n    runs-on: factory-verification\n    steps:\n      - run: bun test\n",
    },
  ],
};

// Controlled Go Source protocol only: no Actor, Forge, shell or checkout replacement.
function canonicalSource() {
  const files = new Map([
    ["README.md", "Original imported README\n"],
    ["src/server.mjs", "export const originalSource = true;\n"],
    [".git/HEAD", "ref: refs/heads/main\n"],
    [".git/refs/heads/main", `${revision}\n`],
    [".git/objects/owned-history", "Original Git history sentinel\n"],
  ]);
  const directories = new Set([
    "",
    ".",
    "src",
    ".git",
    ".git/refs",
    ".git/refs/heads",
    ".git/objects",
  ]);
  const calls: { operation: string; body: Record<string, unknown> }[] = [];
  const mutations = () => calls.filter(({ operation }) => ["mkdir", "write"].includes(operation));
  const forward = async (operation: string, body: Record<string, unknown>): Promise<Response> => {
    calls.push({ operation, body: { ...body } });
    const path = body["path"];
    if (typeof path !== "string") throw Error("Source requires a repository-relative path");
    const content = files.get(path);
    if (operation === "read")
      return content === undefined
        ? new Response(null, { status: 404 })
        : Response.json({
            content: Buffer.from(content).toString("base64"),
            version: createHash("sha256").update(content).digest("hex"),
          });
    if (operation === "stat")
      return directories.has(path)
        ? Response.json({ kind: "directory" })
        : content !== undefined
          ? Response.json({ kind: "file" })
          : new Response(null, { status: 404 });
    if (operation === "mkdir") {
      directories.add(path);
      return new Response(null);
    }
    if (operation === "write") {
      expect(body["version"]).toBe("");
      if (files.has(path)) return new Response(null, { status: 409 });
      if (!directories.has(path.split("/").slice(0, -1).join("/")))
        return new Response(null, { status: 404 });
      const encoded = body["content"];
      if (typeof encoded !== "string") throw Error("Source writes require base64 content");
      const text = Buffer.from(encoded, "base64").toString();
      files.set(path, text);
      return Response.json({
        content: encoded,
        version: createHash("sha256").update(text).digest("hex"),
      });
    }
    throw Error(`Unexpected Source operation: ${operation}`);
  };
  return { files, calls, mutations, forward };
}

async function fixture() {
  const f = await substrateFixture(revision);
  try {
    const seed = {
      version: 1 as const,
      id: crypto.randomUUID(),
      workspaceID: f.workspaceID,
      projectID: f.projectID,
      repositoryURL: "https://example.invalid/fixture.git",
      revision,
      branch: "main",
    };
    const seedConfirmedAt = new Date();
    await f.database.db.insert(substrateSource).values({
      workspaceId: f.workspaceID,
      actorUid: null,
      owner: "service",
      seed,
      serviceBase: seed.id,
    });
    await f.database.db
      .update(substrateSource)
      .set({ seedConfirmedAt })
      .where(eq(substrateSource.workspaceId, f.workspaceID));
    const lease: SubstrateSourceLease = {
      workspaceID: f.workspaceID,
      actorUID: null,
      owner: "service",
      writerEpoch: 1,
      writable: true,
      generation: 0,
      checkpointID: null,
      checkpoint: null,
      serviceBase: seed.id,
      seed,
      seedConfirmedAt,
    };
    return { ...f, seed, lease, source: canonicalSource() };
  } catch (cause) {
    await f.dispose();
    throw cause;
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function inspection(
  f: Fixture,
  changes: Partial<typeof projectSetupInspection.$inferInsert> = {},
  confirmed = true,
) {
  const id = crypto.randomUUID();
  await f.database.db.insert(projectSetupInspection).values({
    id,
    projectId: f.projectID,
    sourceCommit: revision,
    state: "confirmed",
    output: proposal,
    createdBy: f.userID,
    ...changes,
  });
  if (confirmed)
    await f.database.db
      .insert(projectSetupConfirmation)
      .values({ inspectionId: id, createdBy: f.userID });
  return id;
}

test.each(["initial", "after Stop"] as const)(
  "devcontainer-only Source %s returns explicit contract absence without setup confirmation",
  async (phase) => {
    const f = await fixture();
    try {
      f.source.files.set(
        ".devcontainer/devcontainer.json",
        JSON.stringify({ image: "example.invalid/owned-development:fixture" }),
      );
      const before = new Map(f.source.files);
      const lease = phase === "initial" ? f.lease : { ...f.lease, actorUID: crypto.randomUUID() };
      expect(await sourceStartupContract(f.database.client, lease, f.source.forward)).toBeNull();
      expect(f.source.files).toEqual(before);
      expect(f.source.mutations()).toEqual([]);
      expect(f.source.calls).toEqual([{ operation: "read", body: { path: systemPath } }]);
      expect(await f.database.client`SELECT id FROM factory.runtime_attempt`).toHaveLength(0);
    } finally {
      await f.dispose();
    }
  },
  60_000,
);

test("Source seeded before setup confirmation gains only missing approved files and retains README edits", async () => {
  const f = await fixture();
  try {
    const before = await f.database.db.select().from(substrateSource);
    const id = await inspection(f, { state: "proposal" }, false);
    f.source.files.set("README.md", "Human edit saved after Source was seeded — keep me.\n");
    await f.database.db.insert(workspaceSharedDocument).values({
      workspaceId: f.workspaceID,
      path: "README.md",
      yState: Buffer.alloc(0),
      diskVersion: "owned-readme-version",
      dirty: true,
    });
    const original = new Map(f.source.files);
    await f.database.db
      .insert(projectSetupConfirmation)
      .values({ inspectionId: id, createdBy: f.userID });
    await f.database.db
      .update(projectSetupInspection)
      .set({ state: "confirmed" })
      .where(eq(projectSetupInspection.id, id));

    expect(await sourceStartupContract(f.database.client, f.lease, f.source.forward)).toEqual(
      contract,
    );
    expect(f.source.files).toEqual(
      new Map([
        ...original,
        ...proposal.files.map(({ path, content }) => [path, content] as const),
      ]),
    );
    expect(
      f.source.calls
        .filter(({ operation }) => operation === "write")
        .map(({ body }) => body["path"])
        .sort(),
    ).toEqual(proposal.files.map(({ path }) => path).sort());
    expect(f.source.calls.at(-1)).toEqual({ operation: "read", body: { path: systemPath } });
    expect(await f.database.db.select().from(substrateSource)).toEqual(before);
    expect(await f.database.client`SELECT id FROM factory.runtime_attempt`).toHaveLength(0);
  } finally {
    await f.dispose();
  }
}, 60_000);

test("an interrupted partial setup copy recovers identical bytes through a transaction without rewriting", async () => {
  const f = await fixture();
  try {
    await inspection(f);
    const original = new Map(f.source.files);
    let interrupted = false;
    await expect(
      f.database.client.begin((sql) =>
        sourceStartupContract(sql, f.lease, async (operation, body) => {
          const response = await f.source.forward(operation, body);
          if (operation === "write" && response.ok && !interrupted) {
            interrupted = true;
            throw Error("Owned setup write acknowledgement lost");
          }
          return response;
        }),
      ),
    ).rejects.toThrow("Owned setup write acknowledgement lost");
    expect(interrupted).toBe(true);
    expect(f.source.files.size).toBe(original.size + 1);
    expect(
      await f.database.client.begin((sql) => sourceStartupContract(sql, f.lease, f.source.forward)),
    ).toEqual(contract);
    expect(f.source.files).toEqual(
      new Map([
        ...original,
        ...proposal.files.map(({ path, content }) => [path, content] as const),
      ]),
    );
    const writes = f.source.calls.filter(({ operation }) => operation === "write");
    expect(writes).toHaveLength(proposal.files.length);
    expect(new Set(writes.map(({ body }) => body["path"])).size).toBe(proposal.files.length);
    const mutations = f.source.mutations().length;
    expect(await sourceStartupContract(f.database.client, f.lease, f.source.forward)).toEqual(
      contract,
    );
    expect(f.source.mutations()).toHaveLength(mutations);
  } finally {
    await f.dispose();
  }
}, 60_000);

test.each([
  "proposal",
  "confirming",
  "missing confirmation",
  "other Project",
  "other revision",
  "seed Workspace mismatch",
  "open questions",
  "non-setup file",
] as const)(
  "initial startup never applies unapproved or invalid %s setup",
  async (scenario) => {
    const f = await fixture();
    try {
      const changes: Partial<typeof projectSetupInspection.$inferInsert> = {};
      if (scenario === "proposal" || scenario === "confirming") changes.state = scenario;
      if (scenario === "other revision") changes.sourceCommit = "b".repeat(40);
      if (scenario === "other Project") {
        changes.projectId = crypto.randomUUID();
        await f.database.db.insert(project).values({
          id: changes.projectId,
          slug: `other-${changes.projectId}`,
          name: "Other Project",
          repositoryUrl: f.seed.repositoryURL,
          defaultBranch: "main",
          devcontainerPath: ".devcontainer/devcontainer.json",
          createdBy: f.userID,
        });
      }
      if (scenario === "open questions")
        changes.output = { ...proposal, questions: [{ id: "port", question: "Which port?" }] };
      if (scenario === "non-setup file")
        changes.output = {
          ...proposal,
          files: [...proposal.files, { path: "README.md", content: "Unapproved replacement\n" }],
        };
      await inspection(f, changes, scenario !== "missing confirmation");
      const lease =
        scenario === "seed Workspace mismatch"
          ? { ...f.lease, seed: { ...f.seed, workspaceID: crypto.randomUUID() } }
          : f.lease;
      const before = new Map(f.source.files);
      const start = sourceStartupContract(f.database.client, lease, f.source.forward);
      if (["seed Workspace mismatch", "open questions", "non-setup file"].includes(scenario))
        await expect(start).rejects.toThrow();
      else expect(await start).toBeNull();
      expect(f.source.files).toEqual(before);
      expect(f.source.mutations()).toEqual([]);
    } finally {
      await f.dispose();
    }
  },
  60_000,
);

test.each(proposal.files)(
  "initial setup refuses changed existing $path before copying any file",
  async ({ path, content }) => {
    const f = await fixture();
    try {
      await inspection(f);
      // Even semantically identical JSON with different bytes is not the approved file.
      f.source.files.set(path, `${content}\n`);
      const before = new Map(f.source.files);
      await expect(
        sourceStartupContract(f.database.client, f.lease, f.source.forward),
      ).rejects.toThrow();
      expect(f.source.files).toEqual(before);
      expect(f.source.mutations()).toEqual([]);
    } finally {
      await f.dispose();
    }
  },
  60_000,
);

test.each(
  proposal.files.flatMap(({ path }) => [
    { path, dirty: true, conflict: false },
    { path, dirty: false, conflict: true },
  ]),
)(
  "initial setup preserves shared config $path (dirty=$dirty, conflict=$conflict)",
  async (document) => {
    const f = await fixture();
    try {
      await inspection(f);
      await f.database.db.insert(workspaceSharedDocument).values({
        workspaceId: f.workspaceID,
        ...document,
        yState: Buffer.alloc(0),
        diskVersion: "",
      });
      const documents = await f.database.db.select().from(workspaceSharedDocument);
      const before = new Map(f.source.files);
      await expect(
        sourceStartupContract(f.database.client, f.lease, f.source.forward),
      ).rejects.toThrow();
      expect(f.source.files).toEqual(before);
      expect(f.source.mutations()).toEqual([]);
      expect(await f.database.db.select().from(workspaceSharedDocument)).toEqual(documents);
    } finally {
      await f.dispose();
    }
  },
  60_000,
);

test("Source after Stop reads the actual canonical contract without replaying initial setup", async () => {
  const f = await fixture();
  try {
    await inspection(f);
    const canonical = {
      ...contract,
      apps: contract.apps.map((app) => ({ ...app, command: ["bun", "saved-app.ts"], port: 5123 })),
    };
    f.source.files.set(systemPath, JSON.stringify(canonical));
    const before = new Map(f.source.files);
    const stopped = { ...f.lease, actorUID: crypto.randomUUID() };
    expect(await sourceStartupContract(f.database.client, stopped, f.source.forward)).toEqual(
      canonical,
    );
    expect(f.source.files).toEqual(before);
    expect(f.source.calls.map(({ operation, body }) => [operation, body["path"]])).toEqual([
      ["read", systemPath],
    ]);
  } finally {
    await f.dispose();
  }
}, 60_000);

test.each([undefined, "", "{invalid JSON", JSON.stringify({ ...contract, primaryApp: "missing" })])(
  "Source after Stop preserves absent or invalid canonical contract %# instead of restoring old setup",
  async (content) => {
    const f = await fixture();
    try {
      await inspection(f);
      if (content !== undefined) f.source.files.set(systemPath, content);
      const before = new Map(f.source.files);
      const start = sourceStartupContract(
        f.database.client,
        { ...f.lease, actorUID: crypto.randomUUID() },
        f.source.forward,
      );
      if (content === undefined) expect(await start).toBeNull();
      else await expect(start).rejects.toThrow();
      expect(f.source.files).toEqual(before);
      expect(f.source.mutations()).toEqual([]);
    } finally {
      await f.dispose();
    }
  },
  60_000,
);

test("Source contract absence never masks access, transport or integrity failures", async () => {
  const f = await fixture();
  try {
    const before = new Map(f.source.files);
    for (const forward of [
      async () => new Response(null, { status: 403 }),
      async () => new Response(null, { status: 503 }),
      async () => {
        throw new Error("Owned Source reply lost");
      },
      async () => Response.json({ content: "", version: "unconfirmed" }),
      async () =>
        Response.json({
          content: Buffer.from(JSON.stringify(contract)).toString("base64"),
          version: "a".repeat(64),
        }),
    ])
      await expect(sourceStartupContract(f.database.client, f.lease, forward)).rejects.toThrow();
    for (const lease of [
      { ...f.lease, writable: false },
      { ...f.lease, owner: "actor" as const },
      { ...f.lease, seed: null },
      { ...f.lease, seedConfirmedAt: null },
    ])
      await expect(
        sourceStartupContract(f.database.client, lease, f.source.forward),
      ).rejects.toThrow();
    expect(f.source.files).toEqual(before);
    expect(f.source.mutations()).toEqual([]);
    expect(f.source.calls).toEqual([]);
  } finally {
    await f.dispose();
  }
}, 60_000);
