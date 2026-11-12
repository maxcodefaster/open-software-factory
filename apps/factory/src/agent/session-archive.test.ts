import { expect, test } from "bun:test";
import type { SessionTransferData } from "@opencode/client";
import { memoryPrivateObjects } from "../../../../test/fixtures/private-objects";
import { agentViewSchema } from "../api-contracts";
import { createOpenCodeClient } from "./opencode-client";
import {
  importNativeSessionArchive,
  readNativeSessionArchive,
  saveNativeSessionArchive,
} from "./session-archive";

const sessionID = "ses_owned_archive";
const promptID = "msg_owned_archive";
const checkpoint = {
  turnID: "11111111-1111-4111-8111-111111111111",
  runtimeAttemptID: "22222222-2222-4222-8222-222222222222",
  sessionID,
  promptID,
};
function payload(): SessionTransferData {
  return {
    info: {
      id: sessionID,
      projectID: "project_owned",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 3 },
      location: { directory: "/workspace/project" },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
      metadata: { privateGrant: "not-to-restore" },
    },
    messages: [
      { id: promptID, type: "user", time: { created: 1 }, text: "Exact approved input" },
      {
        id: "msg_owned_result",
        type: "assistant",
        time: { created: 2, completed: 3 },
        agent: "build",
        model: { id: "owned", providerID: "factory" },
        finish: "stop",
        content: [{ type: "text", text: "Exact completed result" }],
      },
    ],
  };
}
function client(native = payload(), version = "2.0.27") {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const api = createOpenCodeClient(async (request, path) => {
    calls.push({
      path,
      method: request.method,
      body: request.method === "POST" ? await request.json() : null,
    });
    return Response.json(
      path === "/api/info"
        ? { version }
        : { data: request.method === "POST" ? native.info : native },
    );
  });
  return { api, calls };
}

test("native transcript chunks, exact text and modest metadata remain separate from product storage", async () => {
  const native = payload();
  const first = native.messages[0];
  if (!first) throw new Error("Owned input missing");
  native.messages[0] = {
    ...first,
    type: "user",
    text: "x".repeat(2 * 1024 ** 2),
    time: { created: 1 },
  };
  const owned = client(native);
  const objects = memoryPrivateObjects();
  const saved = await saveNativeSessionArchive(owned.api, objects, checkpoint, {
    revision: "a".repeat(40),
  });
  expect(saved.manifest.chunks).toHaveLength(3);
  expect(saved.summary).not.toHaveProperty("text");
  expect(saved.summary.messages).toBe(2);
  expect((await readNativeSessionArchive(objects, saved.key, saved.manifestSHA256)).native).toEqual(
    native,
  );
  expect(owned.calls[1]?.path).toContain("sanitize=false");
});

test("retry cannot include the next user turn in an older completed checkpoint", async () => {
  const native = payload();
  native.messages.push({
    id: "msg_later",
    type: "user",
    time: { created: 4 },
    text: "Later unsaved work",
  });
  const objects = memoryPrivateObjects();
  const saved = await saveNativeSessionArchive(client(native).api, objects, checkpoint, {});
  const restored = await readNativeSessionArchive(objects, saved.key, saved.manifestSHA256);
  expect(restored.native.messages.map((message) => message.id)).toEqual([
    promptID,
    "msg_owned_result",
  ]);
  expect(saved.manifest.checkpoint.throughMessageID).toBe("msg_owned_result");
});

test("unfinished inputs and unpinned producers never become saved checkpoints", async () => {
  const native = payload();
  native.messages.pop();
  const objects = memoryPrivateObjects();
  await expect(
    saveNativeSessionArchive(client(native).api, objects, checkpoint, {}),
  ).rejects.toThrow("no completed turn");
  await expect(
    saveNativeSessionArchive(client(payload(), "2.0.28").api, objects, checkpoint, {}),
  ).rejects.toThrow("pinned");
  expect(objects.blobs.size).toBe(0);
});

test("checksum failures prevent importing corrupted transcript bytes", async () => {
  const objects = memoryPrivateObjects();
  const saved = await saveNativeSessionArchive(client().api, objects, checkpoint, {});
  const ref = saved.manifest.chunks[0];
  if (!ref) throw new Error("Owned chunk missing");
  objects.blobs.set(ref.key, new TextEncoder().encode("corrupt"));
  await expect(readNativeSessionArchive(objects, saved.key, saved.manifestSHA256)).rejects.toThrow(
    "checksum",
  );
});

test("native import does not restore grants or dispatch a prompt", async () => {
  const owned = client();
  await importNativeSessionArchive(owned.api, payload());
  expect(owned.calls.map((call) => [call.method, call.path])).toEqual([
    ["GET", "/api/info"],
    ["POST", "/api/experimental/session/import"],
  ]);
  expect(owned.calls[1]?.body).toMatchObject({
    info: { id: sessionID, location: { directory: "/workspace/project" } },
  });
  expect(JSON.stringify(owned.calls[1]?.body)).not.toContain("privateGrant");
  expect(JSON.stringify(owned.calls[1]?.body)).not.toContain("permissions");
});

test("authenticated Coding projection retains save status but excludes private archive pointers", () => {
  const projected = agentViewSchema.parse({
    state: "idle",
    messages: [],
    messagesAvailable: true,
    sessionAvailable: false,
    runtimeConnected: false,
    stopPending: false,
    stopId: null,
    transcriptArchive: {
      latest: {
        turnID: checkpoint.turnID,
        state: "failed",
        attempts: 1,
        lastError: "Retry pending",
      },
      lastSaved: null,
      recovery: "Last successfully saved checkpoint only",
      manifestKey: "private-must-not-leak",
      transcript: "private-must-not-leak",
    },
  });
  expect(projected.transcriptArchive?.latest?.state).toBe("failed");
  expect(JSON.stringify(projected)).not.toContain("private-must-not-leak");
});
