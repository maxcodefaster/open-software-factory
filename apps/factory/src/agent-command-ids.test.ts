import { expect, test } from "bun:test";
import { createAgentCommandIds } from "./agent-command-ids";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    values,
  };
}

test("a lost response retains identity and submitted text across a browser reload", () => {
  const storage = memoryStorage();
  const commands = createAgentCommandIds({ storage, userId: "developer" });
  const id = commands.forInput("project:ticket:message", "prompt", "My submitted text");
  const restored = createAgentCommandIds({ storage, userId: "developer" });
  expect(restored.forInput("project:ticket:message", "prompt")).toBe(id);
  expect(restored.latest("project:ticket:message")?.draft).toBe("My submitted text");
});

test("identity is isolated by user, context and command kind", () => {
  const storage = memoryStorage();
  const commands = createAgentCommandIds({ storage, userId: "developer" });
  const id = commands.forInput("project:ticket:message", "prompt");
  expect(commands.forInput("another-project:ticket:message", "prompt")).not.toBe(id);
  expect(commands.forInput("project:another-ticket:message", "prompt")).not.toBe(id);
  expect(commands.forInput("project:ticket:answer", "prompt")).not.toBe(id);
  const otherUser = createAgentCommandIds({ storage, userId: "another-developer" });
  expect(otherUser.latest("project:ticket:message")).toBeUndefined();
  expect(otherUser.forInput("project:ticket:message", "prompt")).not.toBe(id);
});

test("an acknowledged request permits a new explicit submission after reload", () => {
  const storage = memoryStorage();
  const commands = createAgentCommandIds({ storage, userId: "developer" });
  const id = commands.forInput("message", "prompt");
  commands.forget("message", id);
  const restored = createAgentCommandIds({ storage, userId: "developer" });
  expect(restored.latest("message")).toBeUndefined();
  expect(restored.forInput("message", "prompt")).not.toBe(id);
});

test("a changed draft does not discard an older unacknowledged identity", () => {
  const storage = memoryStorage();
  const commands = createAgentCommandIds({ storage, userId: "developer" });
  const first = commands.forInput("message", "first");
  const second = commands.forInput("message", "second");
  expect(commands.forInput("message", "first")).toBe(first);
  commands.forget("message", first);
  expect(commands.forInput("message", "second")).toBe(second);
});

test("a stale acknowledgement cannot erase another context's command", () => {
  const storage = memoryStorage();
  const commands = createAgentCommandIds({ storage, userId: "developer" });
  const id = commands.forInput("message", "prompt");
  commands.forget("another-message", id);
  expect(commands.forInput("message", "prompt")).toBe(id);
});

test("corrupt recovery data blocks a new identity instead of silently replaying", () => {
  const storage = memoryStorage();
  const commands = createAgentCommandIds({ storage, userId: "developer" });
  commands.forInput("message", "prompt");
  const key = [...storage.values.keys()][0];
  if (!key) throw new Error("Missing recovery key");
  storage.setItem(key, "not json");
  expect(() => commands.forInput("message", "prompt")).toThrow("recovery data");
  expect(storage.getItem(key)).toBe("not json");
});

test("unavailable browser storage prevents dispatch rather than creating a transient ID", () => {
  const commands = createAgentCommandIds({
    userId: "developer",
    storage: {
      getItem: () => null,
      setItem: () => {
        throw new Error("Quota exceeded");
      },
      removeItem: () => {},
    },
  });
  expect(() => commands.forInput("message", "prompt")).toThrow("recovery storage");
});

test("the bounded journal never evicts an unresolved command to make room", () => {
  const storage = memoryStorage();
  const commands = createAgentCommandIds({ storage, userId: "developer" });
  const first = commands.forInput("message", "prompt-0");
  for (let index = 1; index < 50; index++) commands.forInput("message", `prompt-${index}`);
  expect(() => commands.forInput("message", "prompt-50")).toThrow("unconfirmed");
  expect(commands.forInput("message", "prompt-0")).toBe(first);
  commands.forget("message", first);
  expect(commands.forInput("message", "prompt-50")).toBeString();
});
