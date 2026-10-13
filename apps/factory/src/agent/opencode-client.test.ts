import { describe, expect, test } from "bun:test";
import {
  cancelQueuedOpenCodeInput,
  confirmEmptyOpenCodeSession,
  confirmSettledOpenCodeInput,
  createOpenCodeClient,
  decodeOpenCodeAdmission,
  interruptOpenCodeSession,
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
