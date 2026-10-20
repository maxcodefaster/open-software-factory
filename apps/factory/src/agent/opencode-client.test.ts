import { describe, expect, test } from "bun:test";
import {
  cancelQueuedOpenCodeInput,
  confirmEmptyOpenCodeSession,
  confirmSettledOpenCodeInput,
  createOpenCodeClient,
  decodeOpenCodeAdmission,
  interruptOpenCodeSession,
  promptRecordedOpenCodeInput,
  readOpenCodeInputMessages,
  syncOpenCodeInputGuidance,
} from "./opencode-client";

const input = {
  sessionID: "ses_owned",
  promptID: "msg_owned",
  text: "Recorded work",
  bootstrap: false,
};
const receipt = {
  id: input.promptID,
  sessionID: input.sessionID,
  type: "user" as const,
  time: { created: 1 },
  delivery: "queue" as const,
  payload: { text: input.text },
};

describe("native OpenCode 2 admission", () => {
  test("validates identity and payload without inventing promotion from a receipt", () => {
    expect(decodeOpenCodeAdmission(receipt, input)).toEqual({
      id: input.promptID,
      sessionID: input.sessionID,
      state: "queued",
    });
    for (const value of [
      null,
      { ...receipt, id: "msg_other" },
      { ...receipt, sessionID: "ses_other" },
      { ...receipt, delivery: "steer" },
      { ...receipt, payload: { text: "secret" } },
      { ...receipt, payload: { text: input.text, files: [{}] } },
      { ...receipt, time: { created: -1 } },
    ])
      expect(() => decodeOpenCodeAdmission(value, input)).toThrow("admission");
    expect(() => decodeOpenCodeAdmission(receipt, { ...input, bootstrap: true })).toThrow(
      "recorded input",
    );
    expect(
      decodeOpenCodeAdmission(
        { ...receipt, payload: { text: input.text, metadata: { factoryBootstrap: true } } },
        { ...input, bootstrap: true },
      ).state,
    ).toBe("queued");
  });
  test("forwards native prompt and interrupt without legacy wire conversions", async () => {
    const client = createOpenCodeClient(async (request, path) => {
      if (path.startsWith("/api/shell")) return Response.json({ data: [] });
      if (path.startsWith("/api/session?")) return Response.json({ data: [], cursor: {} });
      if (path.endsWith("/active")) return Response.json({ data: {} });
      if (path.endsWith("/prompt")) {
        expect(await request.json()).toMatchObject({ text: input.text, id: input.promptID });
        return Response.json({ data: receipt });
      }
      return Response.json({ interrupted: true });
    });
    expect(
      await client.session.prompt({
        sessionID: input.sessionID,
        id: input.promptID,
        text: input.text,
      }),
    ).toEqual(receipt);
    expect(await interruptOpenCodeSession(client, input.sessionID)).toBe("interrupted");
  });
  test("identifies promoted input beyond the first native history page without resending it", async () => {
    let prompts = 0;
    const cursors: Array<string | null> = [];
    const client = createOpenCodeClient(async (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/prompt")) {
        prompts++;
        return Response.json({ data: receipt });
      }
      if (url.pathname.endsWith("/inbox")) return Response.json({ data: [] });
      cursors.push(url.searchParams.get("cursor"));
      return Response.json(
        url.searchParams.has("cursor")
          ? {
              data: [{ id: input.promptID, type: "user", text: input.text, time: { created: 1 } }],
              cursor: {},
            }
          : {
              data: Array.from({ length: 100 }, (_, index) => ({
                id: `msg_step_${index}`,
                type: "assistant",
                time: { created: 101 - index, completed: 102 - index },
                finish: "tool-calls",
                content: [],
              })),
              cursor: { next: "owned-earlier-messages" },
            },
      );
    });
    expect(await promptRecordedOpenCodeInput(client, input, false)).toEqual({
      id: input.promptID,
      sessionID: input.sessionID,
      state: "promoted",
    });
    expect(prompts).toBe(1);
    expect(cursors).toEqual([null, "owned-earlier-messages"]);
  });
});

describe("native input history", () => {
  test("keeps causal order across overlapping pages and stops at the exact input", async () => {
    const reads: string[] = [];
    const client = createOpenCodeClient(async (_request, path) => {
      reads.push(path);
      const url = new URL(`http://opencode.runtime${path}`);
      expect(url.searchParams.get("order")).toBe(url.searchParams.has("cursor") ? null : "desc");
      const message = (id: string) => ({ id, type: "synthetic", time: { created: 1 } });
      return Response.json(
        url.searchParams.has("cursor")
          ? {
              data: [message("msg_shared"), message(input.promptID), message("msg_older")],
              cursor: { next: "must-not-read-before-input" },
            }
          : {
              data: [message("msg_newest"), message("msg_shared")],
              cursor: { next: "owned-earlier-messages" },
            },
      );
    });
    expect(
      (await readOpenCodeInputMessages(client, input.sessionID, input.promptID)).data.map(
        (message) => message.id,
      ),
    ).toEqual(["msg_newest", "msg_shared", input.promptID]);
    expect(reads).toHaveLength(2);
  });
  test("a repeated native cursor fails rather than silently returning incomplete history", async () => {
    let reads = 0;
    const client = createOpenCodeClient(async () => {
      reads++;
      return Response.json({ data: [], cursor: { next: "owned-repeated" } });
    });
    await expect(
      readOpenCodeInputMessages(client, input.sessionID, input.promptID),
    ).rejects.toThrow("repeated a message cursor");
    expect(reads).toBe(2);
  });
  test("an aborted paginated read does not present partial history as proof of absence", async () => {
    const controller = new AbortController();
    const client = createOpenCodeClient(async () => {
      controller.abort();
      return Response.json({ data: [], cursor: { next: "unread-page" } });
    });
    await expect(
      readOpenCodeInputMessages(client, input.sessionID, input.promptID, controller.signal),
    ).rejects.toThrow();
  });
});

test("durable input guidance is idempotent, scoped and cleared for the next turn without inference", async () => {
  const entries = new Map<string, unknown>([
    ["another-client-rule", "Preserve unrelated native instructions"],
    ["factory-skill-previous", "Previously invoked manual guidance"],
  ]);
  const writes: string[] = [];
  const client = createOpenCodeClient(async (request, path) => {
    const pathname = new URL(`http://opencode.runtime${path}`).pathname;
    const key = decodeURIComponent(pathname.slice(pathname.lastIndexOf("/") + 1));
    if (request.method === "GET")
      return Response.json({ data: [...entries].map(([key, value]) => ({ key, value })) });
    writes.push(`${request.method} ${key}`);
    if (request.method === "PUT") entries.set(key, (await request.json()).value);
    else if (request.method === "DELETE") entries.delete(key);
    else throw new Error("Guidance synchronization must not dispatch inference");
    return new Response(null, { status: 204 });
  });
  const guidance = {
    sessionID: input.sessionID,
    skills: [{ id: "factory-owned" }],
    skillManifest: {
      files: [
        {
          path: "factory-owned/SKILL.md",
          body: Buffer.from("Exact admitted guidance").toString("base64"),
        },
      ],
    },
  };
  await syncOpenCodeInputGuidance(client, guidance);
  expect(entries.get("factory-skill-factory-owned")).toBe("Exact admitted guidance");
  expect(entries.has("factory-skill-previous")).toBe(false);
  const first = [...writes];
  await syncOpenCodeInputGuidance(client, guidance);
  expect(writes).toEqual(first);
  await syncOpenCodeInputGuidance(client, { ...guidance, skills: [] });
  expect([...entries]).toEqual([["another-client-rule", "Preserve unrelated native instructions"]]);
});

test("missing admitted guidance refuses preparation before any native request", async () => {
  let requests = 0;
  const client = createOpenCodeClient(async () => {
    requests++;
    return new Response(null, { status: 204 });
  });
  await expect(
    syncOpenCodeInputGuidance(client, {
      sessionID: input.sessionID,
      skills: [{ id: "factory-missing" }],
      skillManifest: null,
    }),
  ).rejects.toThrow("no exact Skill package");
  expect(requests).toBe(0);
});

test("lost guidance receipt reconciles the same native value without another write or prompt", async () => {
  const entries = new Map<string, unknown>();
  let writes = 0;
  const client = createOpenCodeClient(async (request, path) => {
    if (request.method === "GET")
      return Response.json({ data: [...entries].map(([key, value]) => ({ key, value })) });
    if (request.method !== "PUT") throw new Error("Unexpected native mutation");
    const key = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
    entries.set(key, (await request.json()).value);
    writes++;
    throw new Error("Owned response loss after durable instruction update");
  });
  const guidance = {
    sessionID: input.sessionID,
    skills: [{ id: "factory-owned" }],
    skillManifest: {
      files: [
        { path: "factory-owned/SKILL.md", body: Buffer.from("Exact guidance").toString("base64") },
      ],
    },
  };
  await expect(syncOpenCodeInputGuidance(client, guidance)).rejects.toThrow("Transport");
  await syncOpenCodeInputGuidance(client, guidance);
  expect(writes).toBe(1);
});

function controlled(
  options: {
    inbox?: unknown;
    active?: unknown;
    messages?: unknown;
    revert?: boolean;
    sessionID?: string;
  } = {},
) {
  const paths: string[] = [];
  return {
    paths,
    client: createOpenCodeClient(async (request, path) => {
      paths.push(`${request.method} ${path}`);
      if (path.startsWith("/api/shell")) return Response.json({ data: [] });
      if (path.startsWith("/api/session?")) return Response.json({ data: [], cursor: {} });
      if (path.endsWith("/interrupt")) return Response.json({ interrupted: false });
      if (path.endsWith("/inbox")) return Response.json({ data: options.inbox ?? [] });
      if (path.endsWith("/active")) return Response.json({ data: options.active ?? {} });
      if (path.includes("/message")) return Response.json({ data: options.messages ?? [] });
      return Response.json({
        data: {
          id: options.sessionID ?? input.sessionID,
          ...(options.revert ? { revert: {} } : {}),
        },
      });
    }),
  };
}

describe("ordered native Stop", () => {
  test("an idle primary cannot release its writer while a background shell runs", async () => {
    const client = createOpenCodeClient(async (_request, path) => {
      if (path.startsWith("/api/shell"))
        return Response.json({
          data: [{ id: "sh_owned", status: "running", metadata: { sessionID: input.sessionID } }],
        });
      if (path.startsWith("/api/session?")) return Response.json({ data: [], cursor: {} });
      if (path.endsWith("/active")) return Response.json({ data: {} });
      if (path.endsWith("/inbox")) return Response.json({ data: [] });
      return Response.json({
        data: { id: input.sessionID, location: { directory: "/workspace/project" } },
      });
    });
    expect(await confirmSettledOpenCodeInput(client, input.sessionID, input.promptID)).toBe(false);
  });
  test("inactive interruption is complete, running interruption is not", async () => {
    expect(await interruptOpenCodeSession(controlled().client, input.sessionID)).toBe(
      "interrupted",
    );
    expect(
      await interruptOpenCodeSession(
        controlled({ active: { [input.sessionID]: { type: "running" } } }).client,
        input.sessionID,
      ),
    ).toBe("unconfirmed");
  });
  test("read-only proof requires exact session, no queued work, no staged revert and no drain", async () => {
    const owned = controlled();
    expect(await confirmSettledOpenCodeInput(owned.client, input.sessionID, input.promptID)).toBe(
      true,
    );
    expect(owned.paths.every((path) => path.startsWith("GET "))).toBe(true);
    for (const options of [
      { inbox: [receipt] },
      { inbox: {} },
      { active: { [input.sessionID]: { type: "running" } } },
      { active: [] },
      { active: { [input.sessionID]: {} } },
      { revert: true },
      { sessionID: "ses_other" },
    ])
      expect(
        await confirmSettledOpenCodeInput(
          controlled(options).client,
          input.sessionID,
          input.promptID,
        ),
      ).toBe(false);
    expect(await confirmEmptyOpenCodeSession(controlled().client, input.sessionID)).toBe(true);
    expect(
      await confirmEmptyOpenCodeSession(
        controlled({ messages: [{ id: input.promptID }] }).client,
        input.sessionID,
      ),
    ).toBe(false);
  });
  test("native cancellation never stages a revert or touches files", async () => {
    let pending = true;
    const paths: string[] = [];
    const client = createOpenCodeClient(async (request, path) => {
      paths.push(`${request.method} ${path}`);
      if (path.startsWith("/api/shell")) return Response.json({ data: [] });
      if (path.startsWith("/api/session?")) return Response.json({ data: [], cursor: {} });
      if (request.method === "DELETE") {
        pending = false;
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/inbox")) return Response.json({ data: pending ? [receipt] : [] });
      if (path.endsWith("/active")) return Response.json({ data: {} });
      return Response.json({ data: { id: input.sessionID } });
    });
    expect(await cancelQueuedOpenCodeInput(client, input.sessionID, input.promptID)).toBe(true);
    expect(paths).toContain(`DELETE /api/session/${input.sessionID}/inbox/${input.promptID}`);
    expect(paths.some((path) => path.includes("revert"))).toBe(false);
  });
  test("transport failures and unrelated absence cannot clear the barrier", async () => {
    for (const body of [
      null,
      { _tag: "SessionNotFoundError", sessionID: "ses_other" },
      { _tag: "UnauthorizedError" },
    ]) {
      const client = createOpenCodeClient(async () => Response.json(body, { status: 404 }));
      expect(await confirmEmptyOpenCodeSession(client, input.sessionID)).toBe(false);
      expect(await confirmSettledOpenCodeInput(client, input.sessionID, input.promptID)).toBe(
        false,
      );
    }
    const lost = createOpenCodeClient(async () => {
      throw new Error("lost");
    });
    expect(await confirmEmptyOpenCodeSession(lost, input.sessionID)).toBe(false);
    await expect(interruptOpenCodeSession(lost, input.sessionID)).rejects.toThrow("Transport");
  });
});
