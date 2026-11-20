import { expect, mock, test } from "bun:test";
import { buildBrowserToolCatalogue } from "../../../../packages/conversation-domain/src/browser-tools";
import { candidateReviewToolCatalogue } from "../../../../packages/conversation-domain/src/candidate-review";
import type { LearningCase } from "../../../../packages/conversation-domain/src/learning";
import type { createDatabase } from "../../../../packages/db/src/client";
import { memoryPrivateObjects } from "../../../../test/fixtures/private-objects";
import type { SessionArchiveManifest } from "../agent/session-archive";
import { objectDigest } from "../storage/objects";
import { readNativeToolEvidence } from "./native-tool-evidence";
import { collectLearningCases } from "./sources";

const turnID = "11111111-1111-4111-8111-111111111111";
const runtimeAttemptID = "22222222-2222-4222-8222-222222222222";
const projectID = "33333333-3333-4333-8333-333333333333";
const userID = "44444444-4444-4444-8444-444444444444";
const checkpoint = {
  turnID,
  runtimeAttemptID,
  sessionID: "ses_owned_checkpoint",
  promptID: "msg_owned_prompt",
  throughMessageID: "msg_owned_result",
};
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function tool(
  name: string,
  command: string,
  status = "completed",
  time: unknown = {
    created: 10,
    completed: 25,
  },
) {
  return {
    type: "tool",
    name,
    state: {
      status,
      input: { ...(name === "read" ? { path: command } : { command }), password: "PRIVATE-INPUT" },
      error: "PRIVATE-ERROR",
      content: [{ type: "text", text: "PRIVATE-OUTPUT" }],
    },
    time,
  };
}
function configRead(path: string, offset = 1, limit = 100) {
  const part = tool("read", "PRIVATE-UNUSED");
  return {
    ...part,
    state: { ...part.state, input: { path, offset, limit, password: "PRIVATE-INPUT" } },
  };
}
async function archive(
  content: unknown[] = [
    tool("shell", "ss -ltnp"),
    tool("shell", "lsof -nP -iTCP -sTCP:LISTEN", "error"),
    tool("bash", "ps aux"),
    tool("bash", "pgrep -af PRIVATE-PROCESS"),
    tool("read", "PRIVATE-PATH"),
    tool("PRIVATE-TOOL-NAME", "PRIVATE-COMMAND"),
  ],
  messages?: unknown[],
) {
  const objects = memoryPrivateObjects();
  const source = { projectID, revision: "a".repeat(40), private: "PRIVATE-SOURCE-REF" };
  const native = {
    info: { id: checkpoint.sessionID, metadata: { credential: "PRIVATE-GRANT" } },
    messages: messages ?? [
      { id: "msg_earlier", type: "user", text: "PRIVATE-EARLIER" },
      { id: "msg_earlier_result", type: "assistant", content: [tool("shell", "ss -ltnp")] },
      { id: checkpoint.promptID, type: "user", text: "PRIVATE-PROMPT" },
      {
        id: checkpoint.throughMessageID,
        type: "assistant",
        time: { created: 2, completed: 30 },
        finish: "stop",
        content: [{ type: "text", text: "PRIVATE-TRANSCRIPT" }, ...content],
      },
    ],
  };
  const data = encode(native);
  const payloadSHA256 = objectDigest(data);
  const prefix = `session-archives/v1/${turnID}/${payloadSHA256}`;
  const chunk = `${prefix}/0-${payloadSHA256}.json.part`;
  const manifest: SessionArchiveManifest = {
    version: 1,
    producer: { name: "opencode", version: "2.0.27" },
    checkpoint,
    source,
    limitations: "completed-messages-only; external bytes and execution state not checkpointed",
    bytes: data.byteLength,
    sha256: payloadSHA256,
    chunks: [{ key: chunk, sha256: payloadSHA256, bytes: data.byteLength }],
  };
  const manifestBytes = encode(manifest);
  const sha256 = objectDigest(manifestBytes);
  const key = `${prefix}/${sha256}.manifest.json`;
  await objects.put(chunk, data, "application/octet-stream");
  await objects.put(key, manifestBytes, "application/json");
  const read = mock(objects.open);
  return {
    objects: {
      ...objects,
      open: read,
      read: async (_key: string) => {
        throw new Error("Unbounded private object reads are forbidden");
      },
    },
    read,
    manifest,
    saved: { ...checkpoint, key, sha256, source, producerVersion: manifest.producer.version },
  };
}

function collection(
  saved: Awaited<ReturnType<typeof archive>>["saved"] | undefined,
  options: {
    personal?: boolean;
    personalOutsideExcerpt?: boolean;
    disabled?: boolean;
    contributor?: boolean;
    state?: string;
    settledAt?: Date;
    submitted?: boolean;
    verificationPending?: boolean;
    largeEvidence?: boolean;
    nonNative?: boolean;
  } = {},
) {
  const snapshots: LearningCase[] = [];
  const queries: string[] = [];
  const policyOwners: unknown[] = [];
  const availability = { saved };
  const transaction = { depth: 0 };
  const run = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?").replace(/\s+/g, " ").trim();
    queries.push(query);
    if (query.includes("FROM factory.usage_operation operation"))
      return snapshots.length || values[0] !== null
        ? []
        : [
            {
              id: `turn:${turnID}`,
              projectId: projectID,
              userId: userID,
              purpose: "coding",
              outcome: "completed",
              settledAt: options.settledAt ?? new Date(Date.now() - 10 * 60_000),
              cursorAt: "2026-11-19 10:00:00.123456+00",
              wiki: false,
            },
          ];
    if (query.includes("FROM factory.agent_turn WHERE"))
      return [
        {
          id: turnID,
          input: {
            kind: "change-prompt",
            text: options.largeEvidence
              ? "Task.".repeat(1_600)
              : "Continue the approved implementation.",
          },
          authority: { mode: "build", modelId: "owned" },
          state: options.state ?? "completed",
          nativeCoding: !options.nonNative,
          ticketId: "55555555-5555-4555-8555-555555555555",
          conversationId: null,
          createdBy: userID,
          summary: options.largeEvidence ? "Outcome.".repeat(500) : "Saved implementation outcome.",
          createdAt: new Date("2026-11-19T09:00:00Z"),
          updatedAt: new Date("2026-11-19T10:00:00Z"),
        },
      ];
    if (query.includes("FROM factory.agent_turn_skill loaded"))
      return options.personal || options.personalOutsideExcerpt
        ? [
            {
              id: "66666666-6666-4666-8666-666666666666",
              scope: options.personal ? "personal" : "project",
              personalLoaded: true,
              content: {},
            },
          ]
        : [];
    if (query.includes("SELECT pg_advisory_xact_lock_shared")) return [];
    if (query.includes("SELECT scope_key FROM factory.learning_policy")) {
      policyOwners.push(values[1]);
      return options.disabled ? [{ scope_key: "owned-paused" }] : [];
    }
    if (query.includes('FROM auth."user"')) return [{ id: userID }];
    if (query.includes("FROM factory.account_access"))
      return [{ disabledAt: null, directoryDisabledAt: null }];
    if (query.includes("SELECT role FROM factory.project_membership"))
      return [{ role: options.contributor ? "product-contributor" : "developer" }];
    if (query.includes("FROM factory.project_membership")) return [{ manageProject: false }];
    if (query.includes("FROM factory.administrator")) return [];
    if (query.includes("FROM factory.project WHERE")) return [{ id: projectID }];
    if (query.includes("SELECT id FROM factory.learning_case"))
      return snapshots.map((snapshot) => ({ id: snapshot.id }));
    if (query.includes("FROM factory.session_archive archive"))
      return availability.saved ? [availability.saved] : [];
    if (query.includes("FROM factory.change_commit_operation WHERE id"))
      return options.submitted
        ? [
            {
              id: turnID,
              sha: "a".repeat(40),
              parent: "b".repeat(40),
              state: "succeeded",
              changeId: "77777777-7777-4777-8777-777777777777",
            },
          ]
        : [];
    if (query.includes("FROM factory.verification"))
      return [
        {
          id: "88888888-8888-4888-8888-888888888888",
          state: "succeeded",
          completedAt: options.verificationPending ? null : new Date(),
          summary: null,
          diagnosis: null,
        },
      ];
    if (query.includes("FROM factory.learning_source_artifact"))
      return options.largeEvidence
        ? Array.from({ length: 3 }, (_, ordinal) => ({
            ordinal,
            reference: `code:owned-${ordinal}`,
            body: "source".repeat(500),
            truncated: false,
          }))
        : [];
    if (query.includes("INSERT INTO factory.learning_case")) {
      snapshots.push(JSON.parse(String(values[8])));
      return [];
    }
    if (
      [
        "FROM factory.learning_source_artifact",
        "FROM factory.technical_design_revision",
        "FROM factory.change_commit_operation",
        "FROM factory.review_feedback_command",
        "FROM factory.candidate_review",
      ].some((table) => query.includes(table))
    )
      return [];
    throw new Error(`Unexpected offline query: ${query}`);
  };
  const client = Object.assign(run, {
    begin: async <T>(work: (sql: typeof run) => Promise<T>) => {
      transaction.depth++;
      try {
        return await work(run);
      } finally {
        transaction.depth--;
      }
    },
  });
  return {
    database: { client } as unknown as ReturnType<typeof createDatabase>,
    snapshots,
    queries,
    policyOwners,
    availability,
    transaction,
  };
}
function nativeItem(snapshot: LearningCase | undefined) {
  const item = snapshot?.evidence.find((item) => item.id === `turn:${turnID}:native-tools`);
  if (!item) throw new Error("Missing native tool evidence");
  return item;
}

test("selected completed Coding work retains safe checkpoint-bound tool counts and method signals offline", async () => {
  const owned = await archive();
  const source = collection(owned.saved);
  await collectLearningCases(source.database, null, owned.objects);
  const item = nativeItem(source.snapshots[0]);
  const packet = JSON.parse(item.body);
  expect(item.kind).toBe("artifact");
  expect(item.truncated).toBe(false);
  expect(packet.provenance).toEqual({
    turnID,
    runtimeAttemptID,
    manifestSHA256: owned.saved.sha256,
    payloadSHA256: owned.manifest.sha256,
    checkpointSHA256: objectDigest(encode(checkpoint)),
    sourceSHA256: objectDigest(encode(owned.saved.source)),
  });
  expect(packet.tools).toContainEqual({
    tool: "shell",
    calls: 2,
    completed: 1,
    failed: 1,
    unknown: 0,
    timed: 2,
    elapsedMS: 30,
  });
  expect(packet.tools).toContainEqual({
    tool: "other",
    calls: 1,
    completed: 1,
    failed: 0,
    unknown: 0,
    timed: 1,
    elapsedMS: 15,
  });
  expect(packet.methods).toMatchObject([
    { category: "port-discovery", calls: 2, repeated: true },
    { category: "process-discovery", calls: 2, repeated: true },
  ]);
  expect(packet.coverage).toMatchObject({
    earlierMessagesExcluded: 2,
    turnMessages: 1,
    inspectedMessages: 1,
    toolCalls: 6,
    unclassifiedToolCalls: 1,
    shellCalls: 4,
    classifiedShellCalls: 4,
  });
  expect(item.body).not.toContain("PRIVATE-");
  expect(item.body).not.toContain("ss -ltnp");
  expect(item.body).not.toContain(owned.saved.key);
  expect(Buffer.byteLength(item.body)).toBeLessThanOrEqual(4_000);
  expect(source.snapshots[0]?.ownerId).toBeNull();
  expect(source.snapshots[0]?.developerOnly).toBe(true);
  expect(owned.read).toHaveBeenCalledTimes(2);
  const query = source.queries.find((query) => query.includes("FROM factory.session_archive"));
  expect(query).toContain("archive.state='saved'");
  expect(query).toContain("intent.session_id=archive.session_id");
  expect(query).toContain("intent.prompt_id=archive.prompt_id");
  expect(query).toContain(
    "attempt.change_id=turn.change_id AND attempt.project_id=turn.project_id",
  );
  await collectLearningCases(source.database, null, owned.objects);
  expect(source.snapshots).toHaveLength(1);
  expect(owned.read).toHaveBeenCalledTimes(2);
});

test.each(["disabled", "contributor"] as const)(
  "%s Learning authority prevents archive I/O and evidence retention",
  async (gate) => {
    const owned = await archive();
    const source = collection(owned.saved, { [gate]: true, personal: true });
    await collectLearningCases(source.database, null, owned.objects);
    expect(source.snapshots).toEqual([]);
    expect(owned.read).not.toHaveBeenCalled();
    expect(source.queries.some((query) => query.includes("FROM factory.session_archive"))).toBe(
      false,
    );
    if (gate === "disabled") expect(source.policyOwners).toEqual([userID]);
  },
);

test("loaded personal Skills keep tool evidence in the owner's Developer-only case", async () => {
  const owned = await archive();
  const source = collection(owned.saved, { personal: true });
  await collectLearningCases(source.database, null, owned.objects);
  expect(nativeItem(source.snapshots[0]).kind).toBe("artifact");
  expect(source.snapshots[0]?.ownerId).toBe(userID);
  expect(source.snapshots[0]?.developerOnly).toBe(true);
  expect(source.policyOwners).toEqual([userID, userID]);
});

test("an absent saved archive supplies an explicit unknown configuration, never a tool trace", async () => {
  const owned = await archive();
  const source = collection(undefined);
  await collectLearningCases(source.database, null, owned.objects);
  const item = nativeItem(source.snapshots[0]);
  expect(item.kind).toBe("configuration");
  expect(JSON.parse(item.body)).toMatchObject({ status: "unknown", reason: "no-saved-checkpoint" });
  expect(item.body).not.toContain('"tools"');
  expect(owned.read).not.toHaveBeenCalled();
});

test("personal Skills beyond the bounded instruction excerpt still fence archive retention", async () => {
  const owned = await archive();
  const source = collection(owned.saved, { personalOutsideExcerpt: true, disabled: true });
  await collectLearningCases(source.database, null, owned.objects);
  expect(source.policyOwners).toEqual([userID]);
  expect(source.snapshots).toEqual([]);
  expect(owned.read).not.toHaveBeenCalled();
});

test.each(["failed", "stopped", "uncertain"])(
  "a %s turn cannot borrow a completed native checkpoint",
  async (state) => {
    const owned = await archive();
    const source = collection(owned.saved, { state });
    await collectLearningCases(source.database, null, owned.objects);
    expect(source.snapshots[0]?.evidence.some((item) => item.id.endsWith(":native-tools"))).toBe(
      false,
    );
    expect(owned.read).not.toHaveBeenCalled();
  },
);

test.each([
  "turnID",
  "runtimeAttemptID",
  "sessionID",
  "promptID",
  "throughMessageID",
  "source",
  "producerVersion",
  "key",
  "sha256",
])("an archive with a different %s is unknown, not another turn's evidence", async (field) => {
  const owned = await archive();
  const changed = {
    ...owned.saved,
    [field]: field === "source" ? { different: "PRIVATE-WRONG-SOURCE" } : "PRIVATE-WRONG-IDENTITY",
  };
  const item = await readNativeToolEvidence(turnID, changed, owned.objects);
  expect(item.kind).toBe("configuration");
  expect(JSON.parse(item.body)).toMatchObject({
    status: "unknown",
    reason: "saved-checkpoint-unavailable",
  });
  expect(item.body).not.toContain("PRIVATE-");
  expect(item.body).not.toContain('"tools"');
});

test("private object errors and corrupt chunks stay unknown without exposing their error text", async () => {
  const owned = await archive();
  const ref = owned.manifest.chunks[0];
  if (!ref) throw new Error("Missing test chunk");
  owned.objects.blobs.set(ref.key, new TextEncoder().encode("PRIVATE-CORRUPT-BYTES"));
  const corrupt = await readNativeToolEvidence(turnID, owned.saved, owned.objects);
  expect(corrupt.kind).toBe("configuration");
  expect(corrupt.body).not.toContain("PRIVATE-");
  owned.read.mockImplementation(async () => {
    throw new Error("https://PRIVATE-SIGNED-URL");
  });
  const unavailable = await readNativeToolEvidence(turnID, owned.saved, owned.objects);
  expect(unavailable).toEqual(corrupt);
});

test("unknown tool states and missing, negative or reversed timings never become measured success", async () => {
  const owned = await archive([
    tool("shell", "ps aux", "pending", { created: 1, completed: 8 }),
    tool("read", "PRIVATE-PATH", "completed", { created: 1 }),
    tool("write", "PRIVATE-PATH", "error", { created: 8, completed: 1 }),
    tool("patch", "PRIVATE-PATCH", "completed", { created: -1, completed: 10 }),
    tool("factory_browser_browser_fill", "https://PRIVATE-URL", "unrecognized"),
  ]);
  const item = await readNativeToolEvidence(turnID, owned.saved, owned.objects);
  const packet = JSON.parse(item.body);
  expect(packet.tools).toContainEqual({
    tool: "shell",
    calls: 1,
    completed: 0,
    failed: 0,
    unknown: 1,
    timed: 0,
    elapsedMS: null,
  });
  expect(packet.tools).toContainEqual({
    tool: "write",
    calls: 1,
    completed: 0,
    failed: 1,
    unknown: 0,
    timed: 0,
    elapsedMS: null,
  });
  expect(
    packet.tools.every(
      (entry: { timed: number; elapsedMS: null }) => entry.timed === 0 && entry.elapsedMS === null,
    ),
  ).toBe(true);
  expect(packet.methods).toEqual([]);
  expect(packet.coverage.classifiedShellCalls).toBe(0);
  expect(item.body).not.toContain("PRIVATE-");
});

test("discovery method hints do not interpret quoted command names or arbitrary shell programs", async () => {
  const owned = await archive([
    tool("shell", 'echo "ps aux; ss -ltnp"'),
    tool("shell", "node -e 'ps aux'"),
    tool("shell", "lsof PRIVATE-FILE"),
    tool("shell", "/usr/bin/pgrep -af PRIVATE-PROCESS"),
  ]);
  const item = await readNativeToolEvidence(turnID, owned.saved, owned.objects);
  expect(JSON.parse(item.body).methods).toMatchObject([
    { category: "process-discovery", calls: 1, repeated: false },
  ]);
  expect(item.body).not.toContain("PRIVATE-");
});

test("a complete saved turn with no tools is a known empty inventory, not invented execution", async () => {
  const owned = await archive([]);
  const item = await readNativeToolEvidence(turnID, owned.saved, owned.objects);
  expect(item.kind).toBe("artifact");
  expect(item.truncated).toBe(false);
  expect(JSON.parse(item.body)).toMatchObject({
    status: "observed",
    tools: [],
    methods: [],
    coverage: { toolCalls: 0 },
  });
  expect(await readNativeToolEvidence(turnID, owned.saved, owned.objects)).toEqual(item);
});

test("projection bounds preserve complete JSON and mark uninspected parts and commands", async () => {
  const owned = await archive([
    tool("shell", `ss ${"PRIVATE-ARGUMENT".repeat(400)}`),
    ...Array.from({ length: 2_200 }, () => tool("shell", "ss -ltnp")),
  ]);
  const item = await readNativeToolEvidence(turnID, owned.saved, owned.objects);
  const packet = JSON.parse(item.body);
  expect(item.truncated).toBe(true);
  expect(item.kind).toBe("artifact");
  expect(packet.coverage).toMatchObject({
    inspectedParts: 2_048,
    omittedParts: 154,
    toolCalls: 2_047,
    oversizedShellInputs: 1,
  });
  expect(packet.methods).toMatchObject([
    { category: "port-discovery", calls: 2_046, repeated: true },
  ]);
  expect(packet.coverage).toMatchObject({
    inventoryComplete: false,
    methodInputsComplete: false,
  });
  expect(Buffer.byteLength(item.body)).toBeLessThanOrEqual(4_000);
  expect(item.body).not.toContain("PRIVATE-");
});

test("message coverage stops at its explicit bound without claiming later tools were inspected", async () => {
  const messages = [
    { id: checkpoint.promptID, type: "user", text: "PRIVATE-PROMPT" },
    ...Array.from({ length: 270 }, (_, index) => ({
      id: index === 269 ? checkpoint.throughMessageID : `msg_${index}`,
      type: "assistant",
      time: { created: 1, completed: 2 },
      finish: "stop",
      content: [tool("shell", "ps aux")],
    })),
  ];
  const owned = await archive([], messages);
  const item = await readNativeToolEvidence(turnID, owned.saved, owned.objects);
  expect(item.truncated).toBe(true);
  expect(JSON.parse(item.body).coverage).toMatchObject({
    turnMessages: 270,
    inspectedMessages: 256,
    omittedMessages: 14,
    toolCalls: 256,
  });
});

test("a manifest cannot relabel a later user turn as the requested completed checkpoint", async () => {
  const owned = await archive(
    [],
    [
      { id: checkpoint.promptID, type: "user", text: "PRIVATE-FIRST-PROMPT" },
      { id: "msg_later", type: "user", text: "PRIVATE-LATER-PROMPT" },
      {
        id: checkpoint.throughMessageID,
        type: "assistant",
        finish: "stop",
        time: { completed: 2 },
        content: [tool("shell", "ps aux")],
      },
    ],
  );
  const item = await readNativeToolEvidence(turnID, owned.saved, owned.objects);
  expect(item.kind).toBe("configuration");
  expect(JSON.parse(item.body).status).toBe("unknown");
});

test("a completed turn is not frozen without tools during the archive-save race before Git submission", async () => {
  const owned = await archive();
  const source = collection(undefined, { settledAt: new Date() });
  let cursor = await collectLearningCases(source.database, null, owned.objects);
  expect(source.snapshots).toEqual([]);
  expect(owned.read).not.toHaveBeenCalled();
  // The next ordinary sweep sees the independently saved archive. No native
  // export, replay or retrospective mutation of a Learning case is needed.
  source.availability.saved = owned.saved;
  for (let sweep = 0; sweep < 2; sweep++)
    cursor = await collectLearningCases(source.database, cursor, owned.objects);
  expect(nativeItem(source.snapshots[0]).kind).toBe("artifact");
});

test("Verification deferral is revisited after settlement and uses the already saved archive", async () => {
  const owned = await archive();
  const options = { submitted: true, verificationPending: true, settledAt: new Date() };
  const source = collection(owned.saved, options);
  let cursor = await collectLearningCases(source.database, null, owned.objects);
  expect(source.snapshots).toEqual([]);
  expect(owned.read).not.toHaveBeenCalled();
  options.verificationPending = false;
  for (let sweep = 0; sweep < 2; sweep++)
    cursor = await collectLearningCases(source.database, cursor, owned.objects);
  expect(nativeItem(source.snapshots[0]).kind).toBe("artifact");
});

test("an unsaved archive expires to unknown instead of indefinitely stalling completed work", async () => {
  const owned = await archive();
  const options = { settledAt: new Date() };
  const source = collection(undefined, options);
  let cursor = await collectLearningCases(source.database, null, owned.objects);
  expect(source.snapshots).toEqual([]);
  options.settledAt = new Date(Date.now() - 6 * 60_000);
  for (let sweep = 0; sweep < 2; sweep++)
    cursor = await collectLearningCases(source.database, cursor, owned.objects);
  expect(JSON.parse(nativeItem(source.snapshots[0]).body)).toMatchObject({
    status: "unknown",
    reason: "no-saved-checkpoint",
  });
  expect(owned.read).not.toHaveBeenCalled();
  const original = JSON.stringify(source.snapshots);
  source.availability.saved = owned.saved;
  await collectLearningCases(source.database, null, owned.objects);
  expect(JSON.stringify(source.snapshots)).toBe(original);
  expect(owned.read).not.toHaveBeenCalled();
});

test("failed work never waits for a successful completed-turn archive", async () => {
  const owned = await archive();
  const source = collection(undefined, { state: "failed", settledAt: new Date() });
  await collectLearningCases(source.database, null, owned.objects);
  expect(source.snapshots).toHaveLength(1);
  expect(owned.read).not.toHaveBeenCalled();
});

test("work without an admitted native turn intent never waits for a native archive", async () => {
  const owned = await archive();
  const source = collection(undefined, { nonNative: true, settledAt: new Date() });
  await collectLearningCases(source.database, null, owned.objects);
  expect(source.snapshots).toHaveLength(1);
  expect(source.snapshots[0]?.evidence.some((item) => item.id.endsWith(":native-tools"))).toBe(
    false,
  );
  expect(owned.read).not.toHaveBeenCalled();
});

test("the existing packet budget reserves a complete native JSON item even with large work artifacts", async () => {
  const owned = await archive();
  const source = collection(owned.saved, { largeEvidence: true });
  await collectLearningCases(source.database, null, owned.objects);
  const item = nativeItem(source.snapshots[0]);
  expect(JSON.parse(item.body).status).toBe("observed");
  expect(item.truncated).toBe(false);
  const evidence = source.snapshots[0]?.evidence ?? [];
  expect(evidence.length).toBeLessThanOrEqual(24);
  expect(
    evidence.reduce((bytes, item) => bytes + Buffer.byteLength(item.body), 0),
  ).toBeLessThanOrEqual(20_000);
});

test("a full deferred page advances at PostgreSQL precision, then an exhausted pass resets", async () => {
  const cursorAt = "2026-11-19 10:00:00.123456+00";
  const operations = Array.from({ length: 100 }, (_, index) => ({
    id: `turn:11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
    projectId: projectID,
    userId: userID,
    purpose: "coding",
    outcome: "completed",
    settledAt: new Date("2026-11-19T10:00:00Z"),
    cursorAt,
    wiki: false,
  }));
  const run = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?");
    if (query.includes("FROM factory.usage_operation operation"))
      return values[0] === null ? operations : [];
    if (query.includes("FROM factory.agent_turn WHERE")) return [];
    throw new Error("Unexpected query while deferring an unsettled turn");
  };
  const database = { client: run } as unknown as ReturnType<typeof createDatabase>;
  const owned = await archive();
  const cursor = await collectLearningCases(database, null, owned.objects);
  const last = operations.at(-1);
  if (!last) throw new Error("Missing test page");
  expect(cursor).toEqual({ at: cursorAt, id: last.id });
  expect(await collectLearningCases(database, cursor, owned.objects)).toBeNull();
  expect(owned.read).not.toHaveBeenCalled();
});

test("archive object I/O runs outside SQL transactions and retention rechecks current policy", async () => {
  const owned = await archive();
  const options = { disabled: false };
  const source = collection(owned.saved, options);
  const depths: number[] = [];
  const noteRead = () => {
    depths.push(source.transaction.depth);
    options.disabled = true;
  };
  const objects = {
    ...owned.objects,
    read: async (key: string) => {
      noteRead();
      return owned.objects.read(key);
    },
    open: async (key: string) => {
      noteRead();
      return owned.objects.open(key);
    },
  };
  await collectLearningCases(source.database, null, objects);
  expect(depths.length).toBeGreaterThan(0);
  expect(depths.every((depth) => depth === 0)).toBe(true);
  expect(source.snapshots).toEqual([]);
  expect(source.policyOwners).toEqual([null, null]);
});

test("oversized saved archives are refused before downloading their chunks", async () => {
  const owned = await archive();
  const manifest = { ...owned.manifest, bytes: 3 * 1024 ** 2 };
  const bytes = encode(manifest);
  const sha256 = objectDigest(bytes);
  const key = owned.saved.key.replace(owned.saved.sha256, sha256);
  await owned.objects.put(key, bytes, "application/json");
  const item = await readNativeToolEvidence(turnID, { ...owned.saved, key, sha256 }, owned.objects);
  expect(item.kind).toBe("configuration");
  expect(JSON.parse(item.body)).toMatchObject({ status: "unknown", reason: "archive-size-limit" });
  expect(owned.read).toHaveBeenCalledTimes(1);
});

test("an archive read deadline cancels a stalled stream and retains only an unknown reason", async () => {
  const owned = await archive();
  let cancelled = false;
  const item = await readNativeToolEvidence(turnID, owned.saved, {
    ...owned.objects,
    open: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull: () => new Promise(() => {}),
          cancel: () => {
            cancelled = true;
          },
        }),
      ),
  });
  expect(item.kind).toBe("configuration");
  expect(JSON.parse(item.body)).toMatchObject({ status: "unknown", reason: "archive-time-limit" });
  expect(cancelled).toBe(true);
  expect(item.body).not.toContain('"tools"');
}, 10_000);

test("the actual Factory browser_open and exact catalogue are browser tools, speculative and custom names are other", async () => {
  const owned = await archive([
    ...buildBrowserToolCatalogue.map(({ name }) => tool(`factory_browser_${name}`, "PRIVATE-APP")),
    tool("factory_browser_browser_navigate", "https://PRIVATE-URL"),
    tool("factory_browser_PRIVATE-CUSTOM", "PRIVATE-COMMAND"),
  ]);
  const item = await readNativeToolEvidence(turnID, owned.saved, owned.objects);
  const packet = JSON.parse(item.body);
  expect(packet.tools).toContainEqual({
    tool: "browser",
    calls: buildBrowserToolCatalogue.length,
    completed: buildBrowserToolCatalogue.length,
    failed: 0,
    unknown: 0,
    timed: buildBrowserToolCatalogue.length,
    elapsedMS: buildBrowserToolCatalogue.length * 15,
  });
  expect(packet.tools).toContainEqual({
    tool: "other",
    calls: 2,
    completed: 2,
    failed: 0,
    unknown: 0,
    timed: 2,
    elapsedMS: 30,
  });
  expect(item.body).not.toContain("PRIVATE-");
  expect(item.body).not.toContain("browser_navigate");
});

test("offline exact 42 known review calls and 18 browser calls retain a classified 60-call inventory", async () => {
  // Counts from the retained native independent-review tool-shape observation.
  // Replay only trusted catalogue names and counts, never private archive bytes.
  const counts = {
    review_diff: 2,
    review_execution: 16,
    review_files: 2,
    review_read: 11,
    review_report: 1,
    review_scenario: 5,
    review_scenario_result: 5,
  };
  const registered = new Set<string>(candidateReviewToolCatalogue.map(({ name }) => name));
  expect(Object.keys(counts).every((name) => registered.has(name))).toBe(true);
  const owned = await archive([
    ...Object.entries(counts).flatMap(([name, count]) =>
      Array.from({ length: count }, () => tool(`factory_browser_${name}`, "PRIVATE-INPUT")),
    ),
    ...Array.from({ length: 18 }, () =>
      tool("factory_browser_browser_open", "https://PRIVATE-URL"),
    ),
  ]);
  const item = await readNativeToolEvidence(turnID, owned.saved, owned.objects);
  const packet = JSON.parse(item.body);
  expect(item.kind).toBe("artifact");
  expect(item.truncated).toBe(false);
  expect(packet.tools).toEqual([
    {
      tool: "browser",
      calls: 18,
      completed: 18,
      failed: 0,
      unknown: 0,
      timed: 18,
      elapsedMS: 270,
    },
    {
      tool: "review",
      calls: 42,
      completed: 42,
      failed: 0,
      unknown: 0,
      timed: 42,
      elapsedMS: 630,
    },
  ]);
  expect(packet.coverage).toMatchObject({
    toolCalls: 60,
    unclassifiedToolCalls: 0,
    inventoryComplete: true,
    toolClassificationComplete: true,
  });
  expect(item.body).not.toContain("PRIVATE-");
  expect(Buffer.byteLength(item.body)).toBeLessThanOrEqual(4_000);
});

test("all exact registered review names and pinned subagent classify without admitting lookalikes", async () => {
  const owned = await archive([
    ...candidateReviewToolCatalogue.map(({ name }) =>
      tool(`factory_browser_${name}`, "PRIVATE-INPUT"),
    ),
    tool("subagent", "PRIVATE-CHILD"),
    tool("question", "PRIVATE-QUESTION"),
    tool("factory_browser_review_PRIVATE", "PRIVATE-INPUT"),
    tool("factory_browser_review_read_PRIVATE", "PRIVATE-INPUT"),
    tool("Factory_browser_review_read", "PRIVATE-INPUT"),
    tool("subagent_PRIVATE", "PRIVATE-INPUT"),
  ]);
  const item = await readNativeToolEvidence(turnID, owned.saved, owned.objects);
  const packet = JSON.parse(item.body);
  expect(packet.tools).toContainEqual({
    tool: "review",
    calls: candidateReviewToolCatalogue.length,
    completed: candidateReviewToolCatalogue.length,
    failed: 0,
    unknown: 0,
    timed: candidateReviewToolCatalogue.length,
    elapsedMS: candidateReviewToolCatalogue.length * 15,
  });
  expect(packet.tools.find((entry: { tool: string }) => entry.tool === "subagent")?.calls).toBe(1);
  expect(packet.tools.find((entry: { tool: string }) => entry.tool === "question")?.calls).toBe(1);
  expect(packet.coverage).toMatchObject({
    unclassifiedToolCalls: 4,
    inventoryComplete: true,
    toolClassificationComplete: false,
  });
  expect(item.body).not.toContain("PRIVATE");
  expect(item.body).not.toContain("Factory_browser");
  expect(item.truncated).toBe(false);
});

test("discovery equivalence distinguishes repeated explicit inputs, working directories and read pages privately", async () => {
  const shell = tool("shell", "ss -ltnp");
  const first = {
    ...shell,
    state: { ...shell.state, input: { ...shell.state.input, workdir: "/PRIVATE-A" } },
  };
  const retry = structuredClone(first);
  retry.state.status = "error";
  const elsewhere = structuredClone(first);
  elsewhere.state.input.workdir = "/PRIVATE-B";
  const owned = await archive([
    first,
    retry,
    elsewhere,
    tool("shell", "pgrep -af PRIVATE-PROCESS"),
    tool("shell", "pgrep -af PRIVATE-PROCESS"),
    configRead("/PRIVATE-A/package.json"),
    configRead("/PRIVATE-A/package.json"),
    configRead("/PRIVATE-A/package.json", 101),
    tool("shell", "cat /PRIVATE-A/.env"),
  ]);
  const item = await readNativeToolEvidence(turnID, owned.saved, owned.objects);
  const packet = JSON.parse(item.body);
  expect(packet.methods).toMatchObject([
    { category: "config-discovery", calls: 4, repeated: true },
    { category: "port-discovery", calls: 3, repeated: true },
    { category: "process-discovery", calls: 2, repeated: true },
  ]);
  const groups = (category: string) =>
    packet.methods.find((method: { category: string }) => method.category === category).groups;
  expect(groups("port-discovery")).toMatchObject([
    { calls: 2, completed: 1, failed: 1 },
    { calls: 1, completed: 1, failed: 0 },
  ]);
  expect(groups("process-discovery")).toMatchObject([{ calls: 2, completed: 2, failed: 0 }]);
  expect(groups("config-discovery").map((group: { calls: number }) => group.calls)).toEqual([
    2, 1, 1,
  ]);
  expect(
    packet.methods.flatMap((method: { groups: { id: number }[] }) =>
      method.groups.map((group) => group.id),
    ),
  ).toEqual(expect.arrayContaining([0, 1, 2, 3, 4, 5]));
  expect(packet.coverage).toMatchObject({
    inventoryComplete: true,
    toolClassificationComplete: true,
    methodInputsComplete: true,
    omittedEquivalenceGroups: 0,
    omittedEquivalenceCalls: 0,
  });
  expect(item.truncated).toBe(false);
  for (const secret of ["PRIVATE", "package.json", ".env", "ss -ltnp", "pgrep"]) {
    expect(item.body).not.toContain(secret);
  }
  expect(item.body).not.toContain(objectDigest(new TextEncoder().encode("ss -ltnp")));
  expect(await readNativeToolEvidence(turnID, owned.saved, owned.objects)).toEqual(item);
});

test("different discovery commands do not become repeated equivalent observations", async () => {
  const repeated = await archive([
    tool("shell", "ss -ltnp"),
    tool("shell", "ss -ltnp"),
    tool("shell", "ss -ltnp"),
  ]);
  const distinct = await archive([
    tool("shell", "ss -ltnp"),
    tool("shell", "ss -lunp"),
    tool("shell", "lsof -nP -iTCP -sTCP:LISTEN"),
  ]);
  const summarize = async (owned: Awaited<ReturnType<typeof archive>>) =>
    JSON.parse((await readNativeToolEvidence(turnID, owned.saved, owned.objects)).body);
  const a = await summarize(repeated);
  const b = await summarize(distinct);
  expect(a.tools).toEqual(b.tools);
  expect(a.methods[0].groups).toMatchObject([{ calls: 3, completed: 3, failed: 0 }]);
  expect(b.methods[0].groups).toHaveLength(3);
  expect(b.methods[0].groups.every((group: { calls: number }) => group.calls === 1)).toBe(true);
});

test("shell execution options and read limits remain part of explicit-input equivalence", async () => {
  const shell = (options: Record<string, unknown> = {}) => {
    const part = tool("shell", "pgrep -af PRIVATE-PROCESS");
    return { ...part, state: { ...part.state, input: { ...part.state.input, ...options } } };
  };
  const owned = await archive([
    shell(),
    shell(),
    shell({ background: true }),
    shell({ timeout: 1_000 }),
    configRead("/PRIVATE/package.json"),
    configRead("/PRIVATE/package.json"),
    configRead("/PRIVATE/package.json", 1, 200),
  ]);
  const item = await readNativeToolEvidence(turnID, owned.saved, owned.objects);
  const packet = JSON.parse(item.body);
  expect(packet.methods[0].groups.map((group: { calls: number }) => group.calls)).toEqual([2, 1]);
  expect(packet.methods[1].groups.map((group: { calls: number }) => group.calls)).toEqual([
    2, 1, 1,
  ]);
  expect(item.body).not.toContain("PRIVATE");
  expect(item.truncated).toBe(false);
});

test("unavailable discovery inputs do not erase a complete classified call inventory", async () => {
  const inputs = [
    { command: 42 },
    { command: "ps aux", workdir: "PRIVATE".repeat(700) },
    { command: "ps aux", timeout: -1 },
    { command: "ps aux", background: "true" },
  ];
  const owned = await archive([
    ...inputs.map((input) => ({
      ...tool("shell", "PRIVATE"),
      state: { status: "completed", input },
    })),
    {
      ...configRead("/PRIVATE/package.json"),
      state: { status: "completed", input: { path: "/PRIVATE/package.json", offset: 0 } },
    },
    configRead("/PRIVATE/package.json", 1, 2_001),
    tool("shell", "ps aux", "pending"),
    tool("shell", `ps ${"PRIVATE".repeat(700)}`),
  ]);
  const item = await readNativeToolEvidence(turnID, owned.saved, owned.objects);
  const packet = JSON.parse(item.body);
  expect(packet.methods).toEqual([]);
  expect(packet.coverage).toMatchObject({
    toolCalls: 8,
    unavailableMethodInputs: 7,
    oversizedShellInputs: 1,
    inventoryComplete: true,
    toolClassificationComplete: true,
    methodInputsComplete: false,
  });
  expect(item.kind).toBe("artifact");
  expect(item.truncated).toBe(true);
  expect(item.body).not.toContain("PRIVATE");
});

test("finite discovery patterns do not interpret shell programs, quoted prose or speculative read fields", async () => {
  const owned = await archive([
    tool("shell", 'echo "ss -ltnp"'),
    tool("shell", "cd PRIVATE && ss -ltnp"),
    tool("shell", "ss -ltnp; cat PRIVATE"),
    tool("shell", "ss -ltnp\ncat PRIVATE"),
    tool("shell", "cat /PRIVATE/package.json | node PRIVATE"),
    tool("shell", "cat /PRIVATE/arbitrary.json"),
    tool("shell", "cat /PRIVATE/package.json /PRIVATE/.env"),
    configRead("/PRIVATE/source.ts"),
    {
      ...configRead("/PRIVATE/package.json"),
      state: { status: "completed", input: { filePath: "/PRIVATE/package.json" } },
    },
  ]);
  const item = await readNativeToolEvidence(turnID, owned.saved, owned.objects);
  const packet = JSON.parse(item.body);
  expect(packet.methods).toEqual([]);
  expect(packet.coverage).toMatchObject({
    classifiedShellCalls: 0,
    inventoryComplete: true,
    methodInputsComplete: false,
    unavailableMethodInputs: 1,
  });
  expect(item.body).not.toContain("PRIVATE");
});

test("known non-assistant messages are excluded explicitly and unknown part kinds keep inventory incomplete", async () => {
  const excluded = [
    "agent-switched",
    "model-switched",
    "location-switched",
    "synthetic",
    "system",
    "skill",
    "shell",
    "compaction",
    "idle",
  ];
  const content: unknown[] = [
    { type: "reasoning", text: "PRIVATE-REASONING" },
    tool("shell", "ps aux"),
  ];
  const messages: unknown[] = [
    { id: checkpoint.promptID, type: "user" },
    ...excluded.map((type, index) => ({ id: `msg_${index}`, type, text: "PRIVATE-CONTEXT" })),
    {
      id: checkpoint.throughMessageID,
      type: "assistant",
      finish: "stop",
      time: { completed: 30 },
      content,
    },
  ];
  const owned = await archive([], messages);
  const item = await readNativeToolEvidence(turnID, owned.saved, owned.objects);
  expect(item.truncated).toBe(false);
  expect(JSON.parse(item.body).coverage).toMatchObject({
    excludedMessages: excluded.length,
    unclassifiedMessages: 0,
    unclassifiedParts: 0,
    inventoryComplete: true,
    toolCalls: 1,
  });
  content.push({ type: "PRIVATE-UNKNOWN-PART" });
  messages.splice(1, 0, { id: "msg_unknown", type: "PRIVATE-UNKNOWN-MESSAGE" });
  const unfamiliar = await archive([], messages);
  const incomplete = await readNativeToolEvidence(turnID, unfamiliar.saved, unfamiliar.objects);
  expect(incomplete.truncated).toBe(true);
  expect(JSON.parse(incomplete.body).coverage).toMatchObject({
    unclassifiedMessages: 1,
    unclassifiedParts: 1,
    inventoryComplete: false,
    toolCalls: 1,
  });
  expect(incomplete.body).not.toContain("PRIVATE");
});

test("equivalence detail is bounded without losing category counts or known tool inventory", async () => {
  const owned = await archive(
    Array.from({ length: 100 }, (_, index) => tool("shell", `pgrep -af PRIVATE-${index}`)),
  );
  const item = await readNativeToolEvidence(turnID, owned.saved, owned.objects);
  const packet = JSON.parse(item.body);
  expect(item.kind).toBe("artifact");
  expect(packet.methods).toMatchObject([
    { category: "process-discovery", calls: 100, repeated: true },
  ]);
  const groups = packet.methods[0].groups;
  expect(groups.length).toBeGreaterThan(0);
  expect(groups.length).toBeLessThanOrEqual(8);
  expect(packet.coverage).toMatchObject({
    toolCalls: 100,
    inventoryComplete: true,
    toolClassificationComplete: true,
    methodInputsComplete: true,
    omittedEquivalenceGroups: 100 - groups.length,
    omittedEquivalenceCalls: 100 - groups.length,
  });
  expect(item.truncated).toBe(true);
  expect(item.body).not.toContain("PRIVATE");
  expect(Buffer.byteLength(item.body)).toBeLessThanOrEqual(4_000);
});

test("repeated discovery survives the group bound ahead of earlier one-off inputs", async () => {
  const owned = await archive([
    ...Array.from({ length: 100 }, (_, index) => tool("shell", `pgrep -af PRIVATE-${index}`)),
    ...Array.from({ length: 10 }, (_, index) =>
      tool("shell", "pgrep -af PRIVATE-REPEATED", index === 0 ? "error" : "completed"),
    ),
  ]);
  const item = await readNativeToolEvidence(turnID, owned.saved, owned.objects);
  const packet = JSON.parse(item.body);
  expect(packet.methods[0].groups[0]).toEqual({
    id: 100,
    calls: 10,
    completed: 9,
    failed: 1,
  });
  expect(packet.coverage).toMatchObject({
    toolCalls: 110,
    omittedEquivalenceGroups: 93,
    omittedEquivalenceCalls: 93,
    inventoryComplete: true,
    methodInputsComplete: true,
  });
  expect(item.body).not.toContain("PRIVATE");
});

test("a normal multi-tool summary fits the complete declared 4KB projection", async () => {
  const names = [
    "shell",
    "bash",
    "read",
    "write",
    "edit",
    "patch",
    "glob",
    "grep",
    "list",
    "webfetch",
    "websearch",
    "task",
    "skill",
    ...buildBrowserToolCatalogue.map(({ name }) => `factory_browser_${name}`),
    "PRIVATE-CUSTOM",
  ];
  const owned = await archive(names.map((name) => tool(name, "ss -ltnp")));
  const item = await readNativeToolEvidence(turnID, owned.saved, owned.objects);
  expect(item.kind).toBe("artifact");
  expect(item.truncated).toBe(false);
  expect(JSON.parse(item.body).coverage.toolCalls).toBe(names.length);
  expect(Buffer.byteLength(item.body)).toBeLessThanOrEqual(4_000);
  expect(item.body).not.toContain("PRIVATE-");
});

test("maximal categories, discovery groups and large timings remain useful within 4KB", async () => {
  const names = [
    "shell",
    "bash",
    "read",
    "write",
    "edit",
    "patch",
    "glob",
    "grep",
    "list",
    "webfetch",
    "websearch",
    "task",
    "skill",
    "subagent",
    "question",
    ...buildBrowserToolCatalogue.map(({ name }) => `factory_browser_${name}`),
    ...candidateReviewToolCatalogue.map(({ name }) => `factory_browser_${name}`),
    "PRIVATE-CUSTOM",
  ];
  const content = [
    ...names.map((name) =>
      name === "read" ? configRead("/PRIVATE/package.json") : tool(name, "ss -ltnp"),
    ),
    ...Array.from({ length: 12 }, (_, index) =>
      tool("shell", `pgrep -af PRIVATE-PROCESS-${index}`),
    ),
    ...Array.from({ length: 12 }, (_, index) => configRead(`/PRIVATE-${index}/.env`)),
  ].map((part) => ({ ...part, time: { created: 0, completed: 123_456_789_012 } }));
  const owned = await archive(content);
  const item = await readNativeToolEvidence(turnID, owned.saved, owned.objects);
  const packet = JSON.parse(item.body);
  expect(item.kind).toBe("artifact");
  expect(packet.status).toBe("observed");
  expect(packet.coverage).toMatchObject({
    toolCalls: content.length,
    unclassifiedToolCalls: 1,
    inventoryComplete: true,
    toolClassificationComplete: false,
    methodInputsComplete: true,
  });
  expect(packet.tools).toHaveLength(18);
  expect(
    packet.tools.reduce((calls: number, entry: { calls: number }) => calls + entry.calls, 0),
  ).toBe(content.length);
  expect(packet.methods.map((method: { category: string }) => method.category)).toEqual([
    "config-discovery",
    "port-discovery",
    "process-discovery",
  ]);
  expect(
    packet.methods.flatMap((method: { groups: unknown[] }) => method.groups).length,
  ).toBeGreaterThan(0);
  expect(item.body).not.toContain("PRIVATE");
  expect(Buffer.byteLength(item.body)).toBeLessThanOrEqual(4_000);
});

test("projection byte pressure removes only optional groups, not tool or discovery category totals", async () => {
  const names = [
    "shell",
    "bash",
    "read",
    "write",
    "edit",
    "patch",
    "glob",
    "grep",
    "list",
    "webfetch",
    "websearch",
    "task",
    "skill",
    "subagent",
    "question",
    "factory_browser_browser_open",
    "factory_browser_review_execution",
    "PRIVATE-CUSTOM",
  ];
  const content = [
    ...names.flatMap((name) =>
      Array.from({ length: 100 }, () =>
        name === "read" ? configRead("/PRIVATE/package.json") : tool(name, "ss -ltnp"),
      ),
    ),
    ...Array.from({ length: 12 }, (_, index) => tool("shell", `pgrep -af PRIVATE-${index}`)),
    ...Array.from({ length: 12 }, (_, index) => configRead(`/PRIVATE-${index}/.env`)),
  ].map((part) => ({ ...part, time: { created: 0, completed: 90_000_000_000_000 } }));
  const owned = await archive(content);
  const item = await readNativeToolEvidence(turnID, owned.saved, owned.objects);
  const packet = JSON.parse(item.body);
  expect(item.kind).toBe("artifact");
  expect(packet.tools).toHaveLength(18);
  expect(packet.methods).toMatchObject([
    { category: "config-discovery", calls: 112 },
    { category: "port-discovery", calls: 200 },
    { category: "process-discovery", calls: 12 },
  ]);
  const groups = packet.methods.flatMap((method: { groups: { calls: number }[] }) => method.groups);
  expect(groups.length).toBeGreaterThan(0);
  expect(groups.length).toBeLessThan(8);
  expect(packet.coverage).toMatchObject({
    toolCalls: 1_824,
    omittedMessages: 0,
    omittedParts: 0,
    inventoryComplete: true,
    methodInputsComplete: true,
  });
  expect(
    groups.reduce((calls: number, group: { calls: number }) => calls + group.calls, 0) +
      packet.coverage.omittedEquivalenceCalls,
  ).toBe(324);
  expect(item.truncated).toBe(true);
  expect(item.body).not.toContain("PRIVATE");
  expect(Buffer.byteLength(item.body)).toBeLessThanOrEqual(4_000);
});
