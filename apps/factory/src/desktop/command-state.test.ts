import { expect, test } from "bun:test";
import { createDesktopCommandState } from "./command-state";

test("commands retain pending ownership across navigation and concurrent results", async () => {
  let context = "project-a:ticket-a";
  const commands = createDesktopCommandState(() => context);
  const first = Promise.withResolvers<string>();
  const second = Promise.withResolvers<string>();
  const a = commands.mutate(() => first.promise);
  const b = commands.mutate(() => second.promise);
  expect(commands.pendingContexts()[context]).toBe(2);
  context = "project-b:ticket-b";
  first.resolve("saved");
  expect(await a).toEqual({ ok: true, value: "saved" });
  expect(commands.pendingContexts()["project-a:ticket-a"]).toBe(1);
  second.reject(new Error("old context failed"));
  expect(await b).toEqual({ ok: false });
  expect(commands.error()).toBe("");
  expect(commands.pendingContexts()["project-a:ticket-a"]).toBeUndefined();
});

test("a command reports current failures and always settles its pending count", async () => {
  const commands = createDesktopCommandState(() => "project-a");
  expect(
    await commands.mutate(async () => {
      throw new Error("Save failed");
    }),
  ).toEqual({ ok: false });
  expect(commands.error()).toBe("Save failed");
  expect(commands.pendingContexts()["project-a"]).toBeUndefined();
  expect(await commands.mutate(async () => 42)).toEqual({ ok: true, value: 42 });
  expect(commands.error()).toBe("");
});

test("an explicit ownership fence controls feedback without changing command identity", async () => {
  const commands = createDesktopCommandState(() => "current");
  const result = commands.mutate(
    async () => {
      throw "not an Error";
    },
    () => false,
    "admitted",
  );
  expect(await result).toEqual({ ok: false });
  expect(commands.error()).toBe("");
  expect(commands.pendingContexts()["admitted"]).toBeUndefined();
  expect(commands.pendingContexts()["current"]).toBeUndefined();
});
