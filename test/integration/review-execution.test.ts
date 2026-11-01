import { expect, test } from "bun:test";
import { createReviewExecutionReader } from "../../apps/factory/src/agent/review-execution";
import type {
  EnvironmentSecrets,
  StoredEnvironment,
} from "../../apps/factory/src/environments/openbao";
import type { RuntimeHub } from "../../apps/factory/src/runtime/hub";
import { candidateReviewCallInput } from "../../packages/conversation-domain/src/candidate-review";
import { environmentMetadata } from "../../packages/project-domain/src/environment";
import { candidateReviewFixture } from "../fixtures/candidate-review";

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
        return Response.json({
          data: [
            {
              id: "owned-message",
              type: "assistant",
              time: { created: 1, completed: 2 },
              content: Array.from({ length: 14 }, (_, index) => ({
                id: `action-${index}`,
                type: "tool",
                name: index === 0 && patchText ? "patch" : "shell",
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
        const missingEnvironment = crypto.randomUUID();
        await f.database.client`INSERT INTO factory.runtime_attempt(
          id,project_id,change_id,workspace_id,generation,revision,state,
          parent_connector_token_hash,child_connector_token_hash,create_intended_at,created_by)
          VALUES(${missingEnvironment},${f.projectID},${f.changeID},${f.workspaceID},2,${f.commit},
            'stopped',${"a".repeat(64)},${"b".repeat(64)},now(),${f.userID})`;
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
