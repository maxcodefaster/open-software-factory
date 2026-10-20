import { ClientError, OpenCode } from "@opencode/client";
import { z } from "zod";

type AgentTransport = (request: Request, path: string) => Promise<Response>;

export function isOpenCodeObservationTransportError(error: unknown) {
  return (
    (error instanceof ClientError && error.reason === "Transport") ||
    (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name))
  );
}

type RecordedInput = {
  readonly sessionID: string;
  readonly promptID: string;
  readonly text: string;
  readonly bootstrap: boolean;
  readonly skills?: readonly { id: string }[];
};

export type OpenCodeAdmission = {
  readonly id: string;
  readonly sessionID: string;
  readonly state: "queued" | "promoted";
};

const admissionInput = z.object({
  id: z.string().min(1),
  sessionID: z.string().min(1),
  type: z.literal("user"),
  time: z.object({ created: z.number().int().nonnegative() }),
  delivery: z.literal("queue"),
  payload: z.object({
    text: z.string(),
    files: z.array(z.unknown()).max(0).optional(),
    agents: z.array(z.unknown()).max(0).optional(),
    skills: z
      .array(
        z
          .object({ id: z.string(), name: z.string().optional(), text: z.string().optional() })
          .strict(),
      )
      .max(16)
      .optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
});

// Validate native OpenCode 2 receipt against immutable Factory input.
export function decodeOpenCodeAdmission(
  value: unknown,
  expected: RecordedInput,
): OpenCodeAdmission {
  const result = admissionInput.safeParse(value);
  if (!result.success) throw new Error("OpenCode returned an invalid durable admission");
  const admitted = result.data;
  if (
    admitted.id !== expected.promptID ||
    admitted.sessionID !== expected.sessionID ||
    admitted.payload.text !== expected.text ||
    JSON.stringify((admitted.payload.skills ?? []).map((skill) => ({ id: skill.id }))) !==
      JSON.stringify(expected.skills ?? []) ||
    (expected.bootstrap && admitted.payload.metadata?.["factoryBootstrap"] !== true)
  )
    throw new Error("OpenCode durable admission does not match its recorded input");
  return {
    id: admitted.id,
    sessionID: admitted.sessionID,
    state: "queued",
  };
}

// Lifecycle needs the interval after the exact input, not an arbitrary recent
// page. Follow native cursors read-only, preserving newest-first causal order.
export async function readOpenCodeInputMessages(
  client: ReturnType<typeof createOpenCodeClient>,
  sessionID: string,
  promptID: string,
  signal = AbortSignal.timeout(5_000),
) {
  const data: Awaited<ReturnType<typeof client.message.list>>["data"][number][] = [];
  const messages = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    signal.throwIfAborted();
    const page = await client.message.list(
      { sessionID, limit: 100, ...(cursor ? { cursor } : { order: "desc" as const }) },
      { signal },
    );
    for (const message of page.data) {
      if (messages.has(message.id)) continue;
      messages.add(message.id);
      data.push(message);
      if (message.id === promptID) return { data };
    }
    cursor = page.cursor?.next ?? undefined;
    if (!cursor) return { data };
    if (cursors.has(cursor)) throw new Error("OpenCode repeated a message cursor");
    cursors.add(cursor);
  }
}

// API-managed instruction entries are rebased by native compaction. Input
// attachments alone are conversation history and can disappear from context.
// Replace only this Factory-owned namespace when a new turn selects guidance.
export async function syncOpenCodeInputGuidance(
  client: ReturnType<typeof createOpenCodeClient>,
  input: {
    sessionID: string;
    skills: readonly { id: string }[];
    skillManifest: { files: readonly { path: string; body: string }[] } | null;
  },
) {
  const prefix = "factory-skill-";
  const expected = new Map<string, string>(
    input.skills.map((skill) => {
      const file = input.skillManifest?.files.find((file) => file.path === `${skill.id}/SKILL.md`);
      if (!file) throw new Error("Admitted native guidance has no exact Skill package");
      return [`${prefix}${skill.id}`, Buffer.from(file.body, "base64").toString("utf8")] as const;
    }),
  );
  const entries = await client.session.instructions.entry.list(
    { sessionID: input.sessionID },
    { signal: AbortSignal.timeout(5_000) },
  );
  let changed = false;
  for (const entry of entries) {
    if (!entry.key.startsWith(prefix) || expected.has(entry.key)) continue;
    await client.session.instructions.entry.remove(
      { sessionID: input.sessionID, key: entry.key },
      { signal: AbortSignal.timeout(5_000) },
    );
    changed = true;
  }
  for (const [key, value] of expected) {
    if (entries.some((entry) => entry.key === key && entry.value === value)) continue;
    await client.session.instructions.entry.put(
      { sessionID: input.sessionID, key, value },
      { signal: AbortSignal.timeout(5_000) },
    );
    changed = true;
  }
  if (!changed) return;
  const confirmed = await client.session.instructions.entry.list(
    { sessionID: input.sessionID },
    { signal: AbortSignal.timeout(5_000) },
  );
  const owned = confirmed.filter((entry) => entry.key.startsWith(prefix));
  if (
    owned.length !== expected.size ||
    owned.some((entry) => entry.value !== expected.get(entry.key))
  )
    throw new Error("Native instruction entries do not match the admitted Skill guidance");
}

export async function promptRecordedOpenCodeInput(
  client: ReturnType<typeof createOpenCodeClient>,
  input: RecordedInput,
  resume: boolean,
) {
  const admitted = await client.session.prompt({
    sessionID: input.sessionID,
    id: input.promptID,
    text: input.text,
    ...(input.skills?.length ? { skills: input.skills } : {}),
    ...(input.bootstrap ? { metadata: { factoryBootstrap: true } } : {}),
    delivery: "queue",
    resume,
  });
  const receipt = decodeOpenCodeAdmission(admitted, input);
  const inbox = await client.session.inbox.list({ sessionID: input.sessionID });
  if (inbox.some((item) => item.id === input.promptID)) return receipt;
  const messages = await readOpenCodeInputMessages(client, input.sessionID, input.promptID);
  const message = messages.data.find((item) => item.id === input.promptID);
  if (message?.type !== "user" || message.text !== input.text)
    throw new Error("OpenCode input is neither queued nor identifiable in retained messages");
  return { ...receipt, state: "promoted" };
}

export async function ensureOpenCodeMessageBoundary(
  client: ReturnType<typeof createOpenCodeClient>,
  sessionID: string,
) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await client.model.list(
        { location: { directory: "/workspace/project" } },
        { signal: AbortSignal.timeout(10_000) },
      );
      break;
    } catch (error) {
      // Native activation has its own five-second bound. Only a readiness 503
      // permits another read; authorization, transport and configuration errors surface.
      const unavailable = z
        .object({ cause: z.object({ status: z.literal(503) }) })
        .safeParse(error);
      if (!unavailable.success || Date.now() >= deadline) throw error;
      await Bun.sleep(100);
    }
  }
  const messages = await client.message.list({ sessionID, limit: 1 });
  if (messages.data.length === 0) await client.session.switchAgent({ sessionID, agent: "build" });
}

const missingSession = z.object({
  _tag: z.literal("SessionNotFoundError"),
  sessionID: z.string(),
});

// Child Sessions and native shell commands may outlive the primary agent loop.
// The same ancestry check owns lifecycle confirmation and usage attribution.
export async function listOpenCodeSessionTree(
  client: ReturnType<typeof createOpenCodeClient>,
  root: string,
) {
  const result = [root];
  const seen = new Set(result);
  for (let index = 0; index < result.length; index++) {
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = await client.session.list(
        { parentID: result[index], limit: 100, ...(cursor ? { cursor } : {}) },
        { signal: AbortSignal.timeout(5_000) },
      );
      for (const child of page.data) {
        if (child.parentID !== result[index] || child.location.directory !== "/workspace/project")
          throw new Error("OpenCode child Session has inconsistent ancestry");
        if (!seen.has(child.id)) {
          seen.add(child.id);
          result.push(child.id);
        }
      }
      cursor = page.cursor.next ?? undefined;
      if (cursor && cursors.has(cursor)) throw new Error("OpenCode repeated a Session cursor");
      if (cursor) cursors.add(cursor);
      if (seen.size > 1_000) throw new Error("OpenCode Session tree exceeds its observation bound");
    } while (cursor);
  }
  return result;
}

export async function observeOpenCodeWork(
  client: ReturnType<typeof createOpenCodeClient>,
  root: string,
) {
  const sessionIDs = new Set(await listOpenCodeSessionTree(client, root));
  const shells = z
    .array(
      z.object({
        id: z.string().min(1),
        status: z.literal("running"),
        metadata: z.object({ sessionID: z.string().optional() }),
      }),
    )
    .parse(
      (
        await client.shell.list(
          { location: { directory: "/workspace/project" } },
          { signal: AbortSignal.timeout(5_000) },
        )
      ).data,
    );
  const active = z
    .record(z.string(), z.object({ type: z.literal("running") }))
    .parse(await client.session.active({ signal: AbortSignal.timeout(5_000) }));
  const ownedShells = shells.filter(
    (shell) => shell.metadata.sessionID && sessionIDs.has(shell.metadata.sessionID),
  );
  const unknownShell = shells.some((shell) => !shell.metadata.sessionID);
  return {
    sessionIDs: [...sessionIDs],
    shells: ownedShells,
    running:
      unknownShell ||
      ownedShells.length > 0 ||
      [...sessionIDs].some((id) => Object.hasOwn(active, id)),
    unknownShell,
  };
}

// Use only through the Connector's ordered history read and Stop dispatch fence.
// No public durable event means no admitted input, including unpromoted queues.
export async function confirmEmptyOpenCodeSession(
  client: ReturnType<typeof createOpenCodeClient>,
  sessionID: string,
) {
  try {
    const session = await client.session.get({ sessionID }, { signal: AbortSignal.timeout(5_000) });
    if (session.id !== sessionID || session.revert) return false;
    const inbox = await client.session.inbox.list(
      { sessionID },
      { signal: AbortSignal.timeout(5_000) },
    );
    const messages = await client.message.list(
      { sessionID, limit: 1 },
      { signal: AbortSignal.timeout(5_000) },
    );
    const work = await observeOpenCodeWork(client, sessionID);
    return inbox.length === 0 && messages.data.length === 0 && !work.running;
  } catch (cause) {
    const absent = missingSession.safeParse(cause);
    // A failed or malformed read leaves the persisted barrier in place.
    return absent.success && absent.data.sessionID === sessionID;
  }
}

export async function confirmSettledOpenCodeInput(
  client: ReturnType<typeof createOpenCodeClient>,
  sessionID: string,
  _promptID: string,
) {
  try {
    const inbox = await client.session.inbox.list(
      { sessionID },
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!Array.isArray(inbox) || inbox.length !== 0) return false;
    const session = await client.session.get({ sessionID }, { signal: AbortSignal.timeout(5_000) });
    if (session.id !== sessionID || session.revert) return false;
    return !(await observeOpenCodeWork(client, sessionID)).running;
  } catch {
    return false;
  }
}

// The ordered interrupt completes after earlier mutations. Ordinary Session
// GETs can overtake them and do not establish this absence proof.
export async function interruptOpenCodeSession(
  client: ReturnType<typeof createOpenCodeClient>,
  sessionID: string,
) {
  try {
    const result = await client.session.interrupt(
      { sessionID },
      { signal: AbortSignal.timeout(5_000) },
    );
    const work = await observeOpenCodeWork(client, sessionID);
    for (const child of work.sessionIDs.toReversed()) {
      if (child === sessionID) continue;
      await client.session.interrupt({ sessionID: child }, { signal: AbortSignal.timeout(5_000) });
    }
    for (const shell of work.shells)
      await client.shell.remove(
        { id: shell.id, location: { directory: "/workspace/project" } },
        { signal: AbortSignal.timeout(5_000) },
      );
    // Shell/child completion can notify and wake the parent. Fence that loop too.
    if (work.shells.length || work.sessionIDs.length > 1)
      await client.session.interrupt({ sessionID }, { signal: AbortSignal.timeout(5_000) });
    if (work.unknownShell) return "unconfirmed";
    if (result.interrupted) return "interrupted";
    return (await observeOpenCodeWork(client, sessionID)).running ? "unconfirmed" : "interrupted";
  } catch (cause) {
    const absent = missingSession.safeParse(cause);
    if (absent.success && absent.data.sessionID === sessionID) return "absent";
    throw cause;
  }
}

// Call after ordered interrupt and the Connector dispatch fence. Native Inbox
// cancellation does not stage a revert or touch the developer's checkout.
export async function cancelQueuedOpenCodeInput(
  client: ReturnType<typeof createOpenCodeClient>,
  sessionID: string,
  promptID: string,
) {
  const inbox = await client.session.inbox.list({ sessionID });
  if (inbox.some((item) => item.id === promptID))
    await client.session.inbox.cancel({ sessionID, inboxID: promptID });
  return confirmSettledOpenCodeInput(client, sessionID, promptID);
}

// Pinned client and executable use the same native OpenCode 2 protocol.
export function createOpenCodeClient(transport: AgentTransport) {
  const runtimeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request && !init ? input : new Request(input, init);
    const url = new URL(request.url);
    return transport(request, `${url.pathname}${url.search}`);
  }) as typeof fetch;
  return OpenCode.make({ baseUrl: "http://opencode.runtime", fetch: runtimeFetch });
}
