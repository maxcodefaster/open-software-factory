import { expect, test } from "bun:test";
import { createReviewExecutionReader } from "../../apps/factory/src/agent/review-execution";
import type {
  EnvironmentSecrets,
  StoredEnvironment,
} from "../../apps/factory/src/environments/openbao";
import { createVisualReviewController } from "../../apps/factory/src/review/controller";
import type { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import { candidateReviewCallInput } from "../../packages/conversation-domain/src/candidate-review";
import { environmentMetadata } from "../../packages/project-domain/src/environment";
import { candidateReviewFixture } from "../fixtures/candidate-review";
import { eventually } from "../fixtures/factory-process";
import { recordUncreatedWorkspaceAttempt } from "../fixtures/uncreated-workspace-attempt";

test("feedback CRUD rolls back its command snapshot and rejects a stale reply after real row contention", async () => {
  const f = await candidateReviewFixture();
  const review = createVisualReviewController(f.database);
  const release = Promise.withResolvers<void>();
  let holder: Promise<unknown> | undefined;
  let contender: Promise<unknown> | undefined;
  try {
    await f.database.client.unsafe(`CREATE FUNCTION factory.owned_feedback_rollback() RETURNS trigger
      LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Owned feedback command rollback'; END$$;
      CREATE TRIGGER owned_feedback_rollback BEFORE INSERT ON factory.review_feedback_command
      FOR EACH ROW EXECUTE FUNCTION factory.owned_feedback_rollback()`);
    await expect(
      review.create(f.changeID, f.userID, {
        commandId: crypto.randomUUID(),
        kind: "thread",
        body: "Must roll back with its command",
      }),
    ).rejects.toThrow();
    const [rollback] = await f.database.client<
      { feedback: number; messages: number; commands: number }[]
    >`
      SELECT (SELECT count(*)::int FROM factory.review_feedback WHERE change_id=${f.changeID}) AS feedback,
        (SELECT count(*)::int FROM factory.review_feedback_message) AS messages,
        (SELECT count(*)::int FROM factory.review_feedback_command WHERE change_id=${f.changeID}) AS commands`;
    expect(rollback).toEqual({ feedback: 0, messages: 0, commands: 0 });
    await f.database.client.unsafe(`DROP TRIGGER owned_feedback_rollback ON factory.review_feedback_command;
      DROP FUNCTION factory.owned_feedback_rollback()`);
    const input = {
      commandId: crypto.randomUUID(),
      kind: "thread",
      body: "Owned exact candidate feedback",
    };
    const created = await review.create(f.changeID, f.userID, input);
    const feedbackID = created.feedbackId;
    if (!feedbackID) throw new Error("Owned feedback identity missing");
    expect(await review.create(f.changeID, f.userID, input)).toMatchObject(created);
    await expect(
      review.create(f.changeID, f.userID, { ...input, body: "Changed command input" }),
    ).rejects.toThrow("Feedback command changed input");
    const entered = Promise.withResolvers<number>();
    holder = f.database.client.begin(async (sql) => {
      await sql`SELECT id FROM factory.review_feedback WHERE id=${feedbackID} FOR UPDATE`;
      const [connection] = await sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      if (!connection) throw new Error("Owned feedback lock connection missing");
      await sql`UPDATE factory.review_feedback SET version=version+1 WHERE id=${feedbackID}`;
      entered.resolve(connection.pid);
      await release.promise;
    });
    const holderPID = await entered.promise;
    const staleCommandID = crypto.randomUUID();
    contender = review.update(f.changeID, f.userID, {
      commandId: staleCommandID,
      feedbackId: feedbackID,
      expectedVersion: 1,
      action: "reply",
      body: "Stale reply",
    });
    const rejected = contender.then(
      () => {
        throw new Error("Stale feedback reply succeeded");
      },
      (cause: unknown) => cause,
    );
    try {
      await eventually(
        async () => {
          const [wait] = await f.database.client<{ blocked: boolean }[]>`
          SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE ${holderPID} = ANY(pg_blocking_pids(pid))) AS blocked`;
          return wait?.blocked;
        },
        (blocked) => blocked === true,
        "Feedback update did not contend on its actual row lock",
      );
    } finally {
      release.resolve();
    }
    await holder;
    expect(await rejected).toMatchObject({ message: expect.stringContaining("Feedback changed") });
    const [stale] = await f.database
      .client`SELECT id FROM factory.review_feedback_command WHERE id=${staleCommandID}`;
    expect(stale).toBeUndefined();
    const reply = {
      commandId: crypto.randomUUID(),
      feedbackId: feedbackID,
      expectedVersion: 2,
      action: "reply",
      body: "Current reply",
    };
    await review.update(f.changeID, f.userID, reply);
    await review.update(f.changeID, f.userID, reply);
    await review.update(f.changeID, f.userID, {
      commandId: crypto.randomUUID(),
      feedbackId: feedbackID,
      expectedVersion: 3,
      action: "resolve",
    });
    expect((await review.get(f.changeID, f.userID)).feedback).toMatchObject([
      {
        id: feedbackID,
        commitSha: f.commit,
        state: "resolved",
        version: 4,
        messages: [{ body: input.body }, { body: reply.body }],
      },
    ]);
    expect(f.requests()).toBe(0);
  } finally {
    release.resolve();
    await Promise.allSettled([holder, contender]);
    await f.dispose();
  }
}, 30_000);

test("review projections keep native microsecond ordering, finding lineage and recording scenario bounds", async () => {
  const f = await candidateReviewFixture();
  const review = createVisualReviewController(f.database);
  try {
    const sourceID = crypto.randomUUID();
    const retryID = crypto.randomUUID();
    await f.database
      .client`INSERT INTO factory.candidate_review(id,verification_id,change_id,commit_sha,base_sha,
      created_by,ordinal,created_at) VALUES
      (${sourceID},${f.verificationID},${f.changeID},${f.commit},${"a".repeat(40)},${f.userID},2,
        '2050-01-01 00:00:00.000002+00'),
      (${retryID},${f.verificationID},${f.changeID},${f.commit},${"a".repeat(40)},${f.userID},3,
        '2050-01-01 00:00:00.000001+00')`;
    await f.database
      .client`INSERT INTO factory.review_scenario(review_id,id,title,category,criterion,expected,
      observation_kind,media_started_ms,started_at) VALUES
      (${sourceID},'z-first','First','normal',1,'Original candidate','app',20,'2050-01-01 00:00:00.000001+00'),
      (${sourceID},'source-case','Source','normal',1,'Source only','source',30,'2050-01-01 00:00:00.000002+00'),
      (${sourceID},'a-next','Next','boundary',1,'Later app case','app',80,'2050-01-01 00:00:00.000003+00'),
      (${retryID},'retry-case','Retry','normal',1,'Other review','app',0,'2050-01-01 00:00:00.000001+00')`;
    const fallback = await review.get(f.changeID, f.userID);
    expect(fallback.scenarios.map((item) => item.id)).toEqual(["z-first", "source-case", "a-next"]);
    expect(fallback.scenarios.every((item) => item.startedMs === 0 && item.endedMs === null)).toBe(
      true,
    );
    const findingID = crypto.randomUUID();
    await f.database
      .client`INSERT INTO factory.candidate_review(id,verification_id,change_id,commit_sha,base_sha,
      created_by,ordinal,finding_source_id,created_at)
      VALUES(${findingID},${f.verificationID},${f.changeID},${f.commit},${"a".repeat(40)},${f.userID},4,
        ${sourceID},'2050-01-01 00:00:00.000003+00')`;
    const recordingID = crypto.randomUUID();
    await f.database
      .client`INSERT INTO factory.review_media(id,change_id,review_id,created_by,kind,commit_sha,state,
      byte_length,sha256,duration_ms,created_at) VALUES
      (${recordingID},${f.changeID},${sourceID},${f.userID},'recording',${f.commit},'complete',1,${"a".repeat(64)},100,
        '2050-01-01 00:00:00.000001+00'),
      (${crypto.randomUUID()},${f.changeID},${findingID},${f.userID},'recording',${f.commit},'unavailable',NULL,NULL,NULL,
        '2050-01-01 00:00:00.000003+00')`;
    const playback = await review.get(f.changeID, f.userID);
    expect(playback).toMatchObject({
      recording: { id: recordingID, commitSha: f.commit, durationMs: 100 },
      recordingCurrent: true,
      currentCommitSha: f.commit,
    });
    expect(playback.scenarios).toMatchObject([
      { id: "z-first", startedMs: 20, endedMs: 80, hasRecordingPosition: true },
      { id: "source-case", startedMs: 30, endedMs: 80, hasRecordingPosition: true },
      { id: "a-next", startedMs: 80, endedMs: 100, hasRecordingPosition: true },
    ]);
    expect(f.requests()).toBe(0);
  } finally {
    await f.dispose();
  }
}, 30_000);

function actions(input: Record<string, unknown> = {}) {
  const parsed = candidateReviewCallInput.parse({
    name: "review_execution",
    arguments: { section: "actions", ...input },
  });
  if (parsed.name !== "review_execution") throw new Error("Missing execution tool");
  return parsed.arguments;
}

test("execution history uses only recorded implementation ancestry, bounded pages and redacted inputs", async () => {
  const stored = new Map<string, StoredEnvironment>();
  let incorrectFingerprint = false;
  const secrets: EnvironmentSecrets = {
    configured: true,
    async create(key, value) {
      stored.set(key, value);
    },
    async read(key) {
      const value = stored.get(key);
      return incorrectFingerprint && value ? { ...value, fingerprint: "e".repeat(64) } : value;
    },
  };
  const f = await candidateReviewFixture(undefined, undefined, false, async (sql, context) => {
    const commandID = crypto.randomUUID();
    const key = `projects/${context.projectID}/development/${commandID}`;
    const value: StoredEnvironment = {
      commandID,
      fingerprint: "d".repeat(64),
      bundle: {
        variables: [
          { name: "APP_DISPLAY", value: "a b c", runtime: true, build: false, verification: false },
        ],
        registries: [
          {
            host: "owned.invalid",
            username: "test",
            password: "registry value with spaces",
            certificate: "",
            verification: false,
            publish: false,
          },
        ],
      },
    };
    const manifest = JSON.stringify(environmentMetadata(value.bundle));
    stored.set(key, value);
    await sql`INSERT INTO factory.environment_write(command_id,project_id,environment,base_version,
      fingerprint,manifest,secret_key,state,created_by,committed_at)
      VALUES(${commandID},${context.projectID},'development',0,${value.fingerprint},${manifest}::jsonb,
        ${key},'committed',${context.userID},now())`;
    await sql`INSERT INTO factory.project_environment(project_id,environment,version,manifest,secret_key)
      VALUES(${context.projectID},'development',1,${manifest}::jsonb,${key})
      ON CONFLICT(project_id,environment) DO UPDATE SET version=1,manifest=excluded.manifest,
        secret_key=excluded.secret_key`;
  });
  const [intent] = await f.database.client<{ sessionID: string }[]>`
    SELECT session_id AS "sessionID" FROM factory.change_agent_turn_intent WHERE turn_id=${f.initial.id}`;
  if (!intent) throw new Error("Missing implementation intent");
  const root = intent.sessionID;
  const child = "owned-child";
  let command = "echo 0";
  let patchText: string | undefined;
  let oversizedInventory = false;
  const reads: Array<{ attempt: string; path: string; query: Record<string, string> }> = [];
  const native: Pick<RuntimeHub, "request"> = {
    async request(attempt, channel, request) {
      expect(channel).toBe("agent");
      expect(request.method).toBe("GET");
      const url = new URL(request.url);
      reads.push({ attempt, path: url.pathname, query: Object.fromEntries(url.searchParams) });
      if (url.pathname === "/api/session")
        return Response.json({
          data:
            url.searchParams.get("parentID") === root
              ? [{ id: child, parentID: root, location: { directory: "/workspace/project" } }]
              : [],
          cursor: {},
        });
      if (url.pathname === `/api/session/${root}/message`)
        if (url.searchParams.get("cursor") === "next-native-page")
          return Response.json({ data: [], cursor: {} });
      if (url.pathname === `/api/session/${root}/message`)
        return Response.json({
          data: [
            {
              id: "owned-message",
              type: "assistant",
              time: { created: 1, completed: 2 },
              content: Array.from({ length: oversizedInventory ? 2_000 : 14 }, (_, index) => ({
                id: `action-${index}`,
                type: "tool",
                name: oversizedInventory
                  ? `owned-inventory-tool-${index}`
                  : index === 0 && patchText
                    ? "patch"
                    : "shell",
                state: {
                  status: "completed",
                  input:
                    index === 0 && patchText
                      ? { patchText }
                      : {
                          command:
                            index === 13
                              ? `pnpm test ${"x".repeat(12_000)}`
                              : index === 0
                                ? command
                                : `echo ${index}`,
                        },
                  content: [{ type: "text", text: "private-output" }],
                },
                time: { created: 1, completed: 2 },
              })),
            },
          ],
          cursor: { next: "next-native-page" },
        });
      if (url.pathname === `/api/session/${child}/message`)
        return Response.json({ data: [], cursor: {} });
      throw new Error(`Unexpected native action route ${url.pathname}`);
    },
  };
  const read = createReviewExecutionReader(f.database, native, secrets);
  try {
    await f.database
      .client`UPDATE factory.change_agent_turn_intent SET runtime_attempt_id=${f.attemptID}
      WHERE turn_id=${f.initial.id}`;
    const turn = await f.activeReview();
    const scope = {
      id: f.reviewID,
      changeID: f.changeID,
      commitSHA: f.commit,
      attemptID: f.attemptID,
    };
    const first = await read(scope, actions());
    expect(first).toMatchObject({
      candidate: f.commit,
      sessionID: root,
      totalSessions: 2,
      actionsInPage: 14,
      nextOffset: 12,
      nextCursor: "next-native-page",
    });
    expect("actions" in first && first.actions).toHaveLength(12);
    expect(JSON.stringify(first)).not.toContain("private-output");
    expect(JSON.stringify(first)).not.toContain(turn.sessionID);
    const inventory = await read(scope, actions({ section: "inventory" }));
    expect(inventory).toMatchObject({
      candidate: f.commit,
      sessionID: root,
      totalSessions: 2,
      actionsInPage: 14,
      tools: [{ name: "shell", actions: Array.from({ length: 14 }, (_, index) => index) }],
      nextCursor: "next-native-page",
      nextSession: null,
    });
    expect(JSON.stringify(inventory)).not.toContain("echo 0");
    expect(JSON.stringify(inventory)).not.toContain("private-output");
    const end = await read(scope, actions({ section: "inventory", cursor: "next-native-page" }));
    expect(end).toMatchObject({ actionsInPage: 0, tools: [], nextCursor: null, nextSession: 1 });
    const descendantIndex = await read(scope, actions({ section: "inventory", session: 1 }));
    expect(descendantIndex).toMatchObject({
      actionsInPage: 0,
      tools: [],
      nextCursor: null,
      nextSession: null,
    });
    const next = await read(scope, actions({ offset: 12 }));
    expect("actions" in next && next.actions).toHaveLength(2);
    expect(next).toMatchObject({ nextOffset: null });
    const long = await read(scope, actions({ action: 13, inputOffset: 1_024 }));
    if (!("actions" in long)) throw new Error("Missing owned actions");
    expect(long.actions[0]).toMatchObject({ inputStartsAt: 1_024, nextInputOffset: 9_024 });
    expect(Buffer.byteLength(long.actions[0]?.input ?? "")).toBe(8_000);
    await read(scope, actions({ cursor: "next-native-page" }));
    expect(reads.at(-1)?.query).toMatchObject({ cursor: "next-native-page", limit: "20" });
    const descendant = await read(scope, actions({ session: 1 }));
    expect(descendant).toMatchObject({ sessionID: child, actions: [], nextCursor: null });
    expect(reads.every((request) => request.attempt === f.attemptID)).toBe(true);

    patchText =
      "*** Add File: /tmp/opencode/reader.mjs\n" +
      '+const marker = "a b c";\n' +
      '+const auth = {"password":"private-helper-password"};\n' +
      `+await sql\`SELECT id FROM qa_viewers WHERE id = \${ownedID}\`;\n` +
      `+// ${"x".repeat(9_000)}\n`;
    const patchIndex = await read(scope, actions());
    if (!("actions" in patchIndex)) throw new Error("Missing helper action index");
    expect(patchIndex.actions[0]?.input).not.toContain("SELECT id FROM qa_viewers");
    const selectedPatch = await read(scope, actions({ action: 0 }));
    if (!("actions" in selectedPatch)) throw new Error("Missing selected helper patch");
    expect(selectedPatch.actions[0]?.input).toContain("SELECT id FROM qa_viewers");
    expect(patchIndex.actions[0]?.input).toContain('"bodyAvailable":true');
    expect(selectedPatch.actions[0]?.redacted).toBe(true);
    expect(JSON.stringify(selectedPatch)).not.toContain("a b c");
    expect(JSON.stringify(selectedPatch)).not.toContain("private-helper-password");
    expect(selectedPatch.actions[0]).toMatchObject({
      inputTruncated: true,
      nextInputOffset: 8_000,
    });
    const remainingPatch = await read(scope, actions({ action: 0, inputOffset: 8_000 }));
    if (!("actions" in remainingPatch)) throw new Error("Missing helper continuation");
    expect(remainingPatch.actions[0]).toMatchObject({
      inputStartsAt: 8_000,
      inputTruncated: false,
      nextInputOffset: null,
    });
    expect(
      JSON.parse(`${selectedPatch.actions[0]?.input}${remainingPatch.actions[0]?.input}`).patchText,
    ).toContain("SELECT id FROM qa_viewers");
    expect(reads.at(-1)?.path).toBe(`/api/session/${root}/message`);
    patchText = undefined;
    oversizedInventory = true;
    await expect(read(scope, actions({ section: "inventory" }))).rejects.toThrow(
      "Execution inventory exceeds the response limit",
    );
    const detailedFallback = await read(scope, actions());
    expect(detailedFallback).toMatchObject({ actionsInPage: 2_000, nextOffset: 12 });
    expect("actions" in detailedFallback && detailedFallback.actions).toHaveLength(12);
    oversizedInventory = false;

    command = "printf '%s' 'a b c' 'registry value with spaces'";
    const beforeSecrets = reads.length;
    expect(await createReviewExecutionReader(f.database, native)(scope, actions())).toMatchObject({
      unavailable: "Historical input redaction is unavailable",
    });
    expect(reads.length).toBe(beforeSecrets);
    incorrectFingerprint = true;
    expect(await read(scope, actions())).toMatchObject({
      unavailable: "Historical input redaction is unavailable",
    });
    expect(reads.length).toBe(beforeSecrets);
    incorrectFingerprint = false;
    const redacted = await read(scope, actions());
    expect(JSON.stringify(redacted)).not.toContain("a b c");
    expect(JSON.stringify(redacted)).not.toContain("registry value with spaces");
    expect("actions" in redacted && redacted.actions[0]?.redacted).toBe(true);
  } finally {
    await f.dispose();
  }
});

test.each(["workspace", "environment"])(
  "missing historical %s identity fails closed before contacting native history",
  async (missing) => {
    const f = await candidateReviewFixture();
    let reads = 0;
    const read = createReviewExecutionReader(f.database, {
      async request() {
        reads++;
        throw new Error("Unadmitted native read");
      },
    });
    try {
      if (missing === "environment") {
        await f.database.client`UPDATE factory.runtime_attempt SET state='stopped'
          WHERE id=${f.attemptID}`;
        const missingEnvironment = await recordUncreatedWorkspaceAttempt(f.database, {
          workspaceID: f.workspaceID,
          generation: 2,
          createdBy: f.userID,
          revision: f.commit,
          parentHash: "a".repeat(64),
          childHash: "b".repeat(64),
          connectorURL: "wss://owned-build.factory.invalid/internal/runtime-connect",
          state: "stopped",
          recordEnvironment: false,
        });
        await f.database.client`UPDATE factory.runtime_attempt SET state='ready'
          WHERE id=${f.attemptID}`;
        await f.database
          .client`UPDATE factory.change_agent_turn_intent SET runtime_attempt_id=${missingEnvironment}
          WHERE turn_id=${f.initial.id}`;
      }
      await f.activeReview();
      const result = await read(
        {
          id: f.reviewID,
          changeID: f.changeID,
          commitSHA: f.commit,
          attemptID: f.attemptID,
        },
        actions(),
      );
      expect(result).toMatchObject({
        unavailable:
          missing === "environment"
            ? "Historical environment identity is unavailable"
            : "Implementation history has an uninspectable Workspace identity",
      });
      expect(reads).toBe(0);
    } finally {
      await f.dispose();
    }
  },
);
