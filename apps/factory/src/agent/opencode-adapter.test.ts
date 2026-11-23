import { describe, expect, test } from "bun:test";
import {
  cancelQueuedOpenCodeInput,
  confirmEmptyOpenCodeSession,
  confirmSettledOpenCodeInput,
  createOpenCodeClient,
  decodeOpenCodeAdmission,
  ensureOpenCodeMessageBoundary,
  installedOpenCodeSkillIDs,
  interruptOpenCodeSession,
  listOpenCodeSessionTree,
  promptRecordedOpenCodeInput,
  readOpenCodeInputMessages,
  readOpenCodeWorkspace,
  syncOpenCodeInputGuidance,
} from "./opencode-adapter";
import { checkTerminalOpenCodeInbox } from "./opencode-terminal";

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

test.each(["/workspaces/project", "/code/my-python-app", "/code/monorepo/backend"])(
  "discovers native OpenCode context %s without a Factory directory override",
  async (directory) => {
    const client = createOpenCodeClient(async (request, path) => {
      expect(request.method).toBe("GET");
      expect(path).toBe("/api/location");
      return Response.json({ directory, project: { directory } });
    });
    expect(await readOpenCodeWorkspace(client)).toEqual({
      location: { directory },
      checkoutDirectory: directory,
    });
  },
);

test.each(["/", "../project", "/code/../project", "/code/project/", "/code/\nproject"])(
  "does not admit invalid native OpenCode context %s",
  async (directory) => {
    const client = createOpenCodeClient(async () =>
      Response.json({ directory, project: { directory } }),
    );
    await expect(readOpenCodeWorkspace(client)).rejects.toThrow("directory is invalid");
  },
);

test("native built-in Skill URIs do not count as extra installed packages", () => {
  const id = `factory-${crypto.randomUUID()}`;
  expect(
    installedOpenCodeSkillIDs([
      { id: "browser", path: "skill://browser/SKILL.md" },
      { id: "git", path: "skill://git/SKILL.md" },
      { id, path: `/opt/factory/admitted-skills/${id}/SKILL.md` },
    ]),
  ).toEqual([id]);
  expect(
    installedOpenCodeSkillIDs([
      { id: "browser", path: "skill://another/SKILL.md" },
      { id: "git", path: "/workspace/project/.opencode/skills/git/SKILL.md" },
    ]),
  ).toEqual(["browser", "git"]);
});

describe("checkpointed terminal shell notifications", () => {
  const shell = { id: "sh_owned_terminal", sessionID: input.sessionID };
  const notification = {
    id: "msg_owned_shell_notification",
    sessionID: input.sessionID,
    type: "synthetic",
    time: { created: 4 },
    delivery: "steer",
    payload: {
      text: "Owned shell failed after removal",
      metadata: { source: "shell", jobID: shell.id, shellID: shell.id, state: "error" },
    },
  };
  function peer(initial: unknown[], arriveDuringCancel = false) {
    let inbox = initial;
    const cancelled: string[] = [];
    const client = createOpenCodeClient(async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path.endsWith("/inbox"))
        return Response.json({ data: inbox });
      if (request.method === "DELETE" && path.includes("/inbox/")) {
        const id = decodeURIComponent(path.split("/").at(-1) ?? "");
        cancelled.push(id);
        inbox = inbox.filter((item) => (item as { id: string }).id !== id);
        if (arriveDuringCancel) inbox.push(receipt);
        return new Response(null, { status: 204 });
      }
      throw new Error("Terminal notification test escaped its owned Inbox");
    });
    return { client, cancelled };
  }
  test("cancels only recorded background-job notification IDs", async () => {
    const owned = peer([notification]);
    await checkTerminalOpenCodeInbox(owned.client, input.sessionID, [shell]);
    expect(owned.cancelled).toEqual([]);
    await checkTerminalOpenCodeInbox(owned.client, input.sessionID, [shell], true);
    expect(owned.cancelled).toEqual([notification.id]);
  });
  test.each([
    receipt,
    {
      ...notification,
      payload: {
        ...notification.payload,
        metadata: { ...notification.payload.metadata, shellID: "sh_other", jobID: "sh_other" },
      },
    },
    {
      ...notification,
      payload: {
        ...notification.payload,
        metadata: { source: "shell", shellID: shell.id, state: "error" },
      },
    },
    {
      ...notification,
      payload: {
        ...notification.payload,
        metadata: { ...notification.payload.metadata, source: "other" },
      },
    },
  ])("rejects user, foreign or user-shell input without cancelling anything", async (foreign) => {
    const owned = peer([notification, foreign]);
    await expect(
      checkTerminalOpenCodeInbox(owned.client, input.sessionID, [shell], true),
    ).rejects.toThrow("newer or unidentified");
    expect(owned.cancelled).toEqual([]);
  });
  test("a user input arriving during owned notification cancellation remains queued", async () => {
    const owned = peer([notification], true);
    await checkTerminalOpenCodeInbox(owned.client, input.sessionID, [shell], true);
    await expect(
      checkTerminalOpenCodeInbox(owned.client, input.sessionID, [shell], true),
    ).rejects.toThrow("newer or unidentified");
    expect(owned.cancelled).toEqual([notification.id]);
    expect((await owned.client.session.inbox.list({ sessionID: input.sessionID }))[0]?.id).toBe(
      receipt.id,
    );
  });
});

describe("Factory Coding native interaction boundary", () => {
  const denyQuestion = { action: "question", resource: "*", effect: "deny" as const };
  const restricted = [
    { action: "*", resource: "*", effect: "deny" as const },
    { action: "read", resource: "*", effect: "allow" as const },
    { action: "shell", resource: "*", effect: "ask" as const },
  ];
  function boundary(
    initial = restricted,
    behavior: {
      lost?: boolean;
      unconfirmed?: boolean;
      foreign?: boolean;
      malformed?: boolean;
      malformedRules?: boolean;
      omitted?: boolean;
    } = {},
  ) {
    let permissions = behavior.omitted ? undefined : structuredClone(initial);
    let writes = 0;
    let reads = 0;
    const client = createOpenCodeClient(async (request, path) => {
      if (path.startsWith("/api/model")) return Response.json({ data: [] });
      if (path.includes("/message"))
        return Response.json({ data: [{ id: "msg_existing", type: "user" }] });
      if (path !== `/api/session/${input.sessionID}`)
        throw new Error("Boundary preparation must not prompt, answer or cancel native forms");
      if (request.method === "PATCH") {
        writes++;
        if (!behavior.unconfirmed) permissions = (await request.json()).permissions;
        if (behavior.lost) throw new Error("Owned permission update response loss");
        return new Response(null, { status: 204 });
      }
      reads++;
      return Response.json({
        data: {
          id: behavior.foreign ? "ses_other" : input.sessionID,
          permissions: behavior.malformed
            ? null
            : behavior.malformedRules
              ? [{ ...denyQuestion, effect: "unknown" }]
              : permissions,
        },
      });
    });
    return { client, permissions: () => permissions, writes: () => writes, reads: () => reads };
  }
  test("an omitted native Session override is empty, then the question deny is confirmed", async () => {
    const owned = boundary([], { omitted: true });
    await ensureOpenCodeMessageBoundary(owned.client, input.sessionID);
    expect(owned.permissions()).toEqual([denyQuestion]);
    expect(owned.writes()).toBe(1);
    expect(owned.reads()).toBe(2);
    await ensureOpenCodeMessageBoundary(owned.client, input.sessionID);
    expect(owned.writes()).toBe(1);
  });
  test("an omitted override after an unconfirmed update still refuses input preparation", async () => {
    const owned = boundary([], { omitted: true, unconfirmed: true });
    await expect(ensureOpenCodeMessageBoundary(owned.client, input.sessionID)).rejects.toThrow(
      "interaction boundary",
    );
    expect(owned.writes()).toBe(1);
    expect(owned.reads()).toBe(2);
  });
  test("narrows only the unsupported builtin, including retained sessions, without changing other rules", async () => {
    const owned = boundary();
    await ensureOpenCodeMessageBoundary(owned.client, input.sessionID);
    expect(owned.permissions()).toEqual([...restricted, denyQuestion]);
    expect(restricted).toHaveLength(3);
    expect(owned.writes()).toBe(1);
    await ensureOpenCodeMessageBoundary(owned.client, input.sessionID);
    expect(owned.writes()).toBe(1);
  });
  test("an earlier question deny cannot be reopened by a later wildcard allowance", async () => {
    const rules = [denyQuestion, { action: "*", resource: "*", effect: "allow" as const }];
    const owned = boundary(rules);
    await ensureOpenCodeMessageBoundary(owned.client, input.sessionID);
    expect(owned.permissions()).toEqual([...rules, denyQuestion]);
  });
  test.each(["foreign", "malformed", "malformedRules", "unconfirmed"] as const)(
    "refuses %s native permission evidence before input admission",
    async (failure) => {
      const owned = boundary(restricted, { [failure]: true });
      await expect(ensureOpenCodeMessageBoundary(owned.client, input.sessionID)).rejects.toThrow(
        "interaction boundary",
      );
    },
  );
  test("a lost update reply is not retried; a later preparation confirms the same restriction", async () => {
    const behavior = { lost: true };
    const owned = boundary(restricted, behavior);
    await expect(ensureOpenCodeMessageBoundary(owned.client, input.sessionID)).rejects.toThrow(
      "Transport",
    );
    behavior.lost = false;
    await ensureOpenCodeMessageBoundary(owned.client, input.sessionID);
    expect(owned.writes()).toBe(1);
  });
});

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
      if (path === `/api/session/${input.sessionID}`)
        return Response.json({
          data: { id: input.sessionID, location: { directory: "/code/project" } },
        });
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
          location: { directory: "/code/project" },
          ...(options.revert ? { revert: {} } : {}),
        },
      });
    }),
  };
}

describe("ordered native Stop", () => {
  test.each(["/workspaces/project", "/code/my-python-app", "/code/monorepo/backend"])(
    "native child ancestry uses the recorded root directory %s, not a Factory path",
    async (directory) => {
      const client = createOpenCodeClient(async (_request, path) => {
        const url = new URL(path, "http://opencode.runtime");
        if (url.pathname === `/api/session/${input.sessionID}`)
          return Response.json({ data: { id: input.sessionID, location: { directory } } });
        if (url.pathname !== "/api/session")
          throw new Error("Ancestry observation must only read the root and its children");
        return Response.json({
          data:
            url.searchParams.get("parentID") === input.sessionID
              ? [{ id: "ses_child", parentID: input.sessionID, location: { directory } }]
              : [],
          cursor: {},
        });
      });
      expect(await listOpenCodeSessionTree(client, input.sessionID)).toEqual([
        input.sessionID,
        "ses_child",
      ]);
    },
  );
  test("a native child in a different directory cannot join the admitted tree", async () => {
    const client = createOpenCodeClient(async (_request, path) =>
      Response.json({
        data: path.includes(`/api/session/${input.sessionID}`)
          ? { id: input.sessionID, location: { directory: "/code/project" } }
          : [
              {
                id: "ses_child",
                parentID: input.sessionID,
                location: { directory: "/code/another-project" },
              },
            ],
        cursor: {},
      }),
    );
    await expect(listOpenCodeSessionTree(client, input.sessionID)).rejects.toThrow("ancestry");
  });
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
      return Response.json({
        data: { id: input.sessionID, location: { directory: "/code/project" } },
      });
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
