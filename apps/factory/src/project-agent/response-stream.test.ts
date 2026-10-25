import { expect, test } from "bun:test";
import type { ConversationView } from "../api-contracts";
import { CommandError } from "../command-error";
import { projectResponseStream } from "./response-stream";

const conversation: ConversationView = {
  id: "owned",
  projectId: "owned",
  mode: "plan",
  version: 1,
  contextId: null,
  activeCodingContextId: null,
  isActiveCoding: false,
  contexts: [],
  codingHistory: null,
  entries: [],
};
const turnId = crypto.randomUUID();

test("native text precedes completion and slow consumers do not queue snapshots", async () => {
  const release = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  const stream = projectResponseStream(async (observer) => {
    observer.admitted(turnId);
    await ready.promise;
    observer.answerText(turnId, "Hello");
    for (let index = 0; index < 1000; index++) observer.answerText(turnId, `Hello ${index}`);
    await release.promise;
    return conversation;
  }, new AbortController().signal);
  const reader = stream.getReader();
  expect((await reader.read()).value).toEqual({ type: "admitted", turnId });
  ready.resolve();
  expect((await reader.read()).value).toEqual({ type: "answer", turnId, text: "Hello" });
  release.resolve();
  // Keep the first queued snapshot and one latest replacement, not a transcript
  // queue. The last text must not disappear behind the final validated view.
  expect((await reader.read()).value).toEqual({ type: "answer", turnId, text: "Hello 0" });
  expect((await reader.read()).value).toEqual({ type: "answer", turnId, text: "Hello 999" });
  expect((await reader.read()).value).toEqual({ type: "complete", conversation });
  expect((await reader.read()).done).toBe(true);
});

test("disconnect detaches observation but does not stop admitted work", async () => {
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const stream = projectResponseStream(async (observer) => {
    observer.admitted(turnId);
    await release.promise;
    observer.answerText(turnId, "After disconnect");
    finished.resolve();
    return conversation;
  }, new AbortController().signal);
  await stream.cancel();
  release.resolve();
  await finished.promise;
});

test("the authenticated request signal closes the native observer while admitted work still finishes once", async () => {
  const abort = new AbortController(),
    release = Promise.withResolvers<void>(),
    finished = Promise.withResolvers<void>();
  let starts = 0;
  const stream = projectResponseStream(async (observer) => {
    starts++;
    observer.admitted(turnId);
    await release.promise;
    observer.answerText(turnId, "After browser disconnect");
    finished.resolve();
    return conversation;
  }, abort.signal);
  const reader = stream.getReader();
  expect((await reader.read()).value).toEqual({ type: "admitted", turnId });
  abort.abort();
  expect((await reader.read()).done).toBe(true);
  release.resolve();
  await finished.promise;
  expect(starts).toBe(1);
});

test.each([
  new Error("provider-key-secret"),
  new CommandError("forbidden", "Project access changed"),
])("stream failure exposes only trusted command messages", async (cause) => {
  const stream = projectResponseStream(async () => {
    throw cause;
  }, new AbortController().signal);
  const values = [];
  const reader = stream.getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    values.push(chunk.value);
  }
  const text = JSON.stringify(values);
  expect(text).toContain('"type":"error"');
  expect(text).not.toContain("provider-key-secret");
  if (cause instanceof CommandError) expect(text).toContain("Project access changed");
});
