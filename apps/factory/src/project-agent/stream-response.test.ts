import { expect, test } from "bun:test";
import type { ConversationView } from "../api-contracts";
import { CommandError } from "../command-error";
import { projectResponseStream } from "./stream-response";

const conversation: ConversationView = {
  id: "owned",
  projectId: "owned",
  mode: "plan",
  version: 1,
  entries: [],
};
const turnId = crypto.randomUUID();
const decode = (value: Uint8Array | undefined) => new TextDecoder().decode(value);

test("HTTP text precedes completion and slow consumers do not queue snapshots", async () => {
  const release = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  const response = projectResponseStream(async (observer) => {
    observer.admitted(turnId);
    await ready.promise;
    observer.answerText(turnId, "Hello");
    for (let index = 0; index < 1000; index++) observer.answerText(turnId, `Hello ${index}`);
    await release.promise;
    return conversation;
  });
  if (!response.body) throw new Error("Stream body missing");
  const reader = response.body.getReader();
  expect(decode((await reader.read()).value)).toContain('"type":"admitted"');
  ready.resolve();
  expect(decode((await reader.read()).value)).toContain('"text":"Hello"');
  release.resolve();
  // One snapshot can be queued while the first is handed directly to a waiting reader.
  expect(decode((await reader.read()).value)).toContain('"text":"Hello 0"');
  expect(decode((await reader.read()).value)).toContain('"type":"complete"');
  expect((await reader.read()).done).toBe(true);
});

test("disconnect detaches observation but does not stop admitted work", async () => {
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const response = projectResponseStream(async (observer) => {
    observer.admitted(turnId);
    await release.promise;
    observer.answerText(turnId, "After disconnect");
    finished.resolve();
    return conversation;
  });
  if (!response.body) throw new Error("Stream body missing");
  await response.body.cancel();
  release.resolve();
  await finished.promise;
});

test.each([
  new Error("provider-key-secret"),
  new CommandError("forbidden", "Project access changed"),
])("stream failure exposes only trusted command messages", async (cause) => {
  const response = projectResponseStream(async () => {
    throw cause;
  });
  const text = await response.text();
  expect(text).toContain('"type":"error"');
  expect(text).not.toContain("provider-key-secret");
  if (cause instanceof CommandError) expect(text).toContain("Project access changed");
});
