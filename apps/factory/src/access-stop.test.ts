import { expect, test } from "bun:test";
import { confirmAccessStopped } from "./access-stop";

test("access recovery waits for confirmed Stop, not just its acknowledgement", async () => {
  const calls: string[] = [];
  const states = ["stop-intended", "stopped"];
  await confirmAccessStopped(
    new AbortController().signal,
    {
      stop: async () => {
        calls.push("stop");
      },
      read: async () => {
        const state = states.shift();
        if (!state) throw new Error("Unexpected observation");
        calls.push(state);
        return { state };
      },
      wait: async () => {
        calls.push("wait");
      },
    },
    "Editor Stop was not confirmed.",
  );
  expect(calls).toEqual(["stop", "stop-intended", "wait", "stopped"]);
});

test("a failed editor Stop cannot authorize another epoch", async () => {
  await expect(
    confirmAccessStopped(
      new AbortController().signal,
      {
        stop: async () => {},
        read: async () => ({ state: "failed" }),
        wait: async () => {
          throw new Error("A failed Stop must not be polled again");
        },
      },
      "Editor Stop was not confirmed.",
    ),
  ).rejects.toThrow("Editor Stop was not confirmed.");
});

test("a rejected Stop does not proceed to observation", async () => {
  await expect(
    confirmAccessStopped(
      new AbortController().signal,
      {
        stop: async () => {
          throw new Error("Stop rejected");
        },
        read: async () => {
          throw new Error("Must not observe a rejected Stop");
        },
        wait: async () => {},
      },
      "Editor Stop was not confirmed.",
    ),
  ).rejects.toThrow("Stop rejected");
});

test("late Stop observations cannot finish recovery after navigation or revocation", async () => {
  const entered = Promise.withResolvers<void>();
  const result = Promise.withResolvers<{ state: string }>();
  const cancel = new AbortController();
  const recovery = confirmAccessStopped(
    cancel.signal,
    {
      stop: async () => {},
      read: async () => {
        entered.resolve();
        return result.promise;
      },
      wait: async () => {},
    },
    "Editor Stop was not confirmed.",
  );
  await entered.promise;
  cancel.abort(new Error("Editor selection changed"));
  result.resolve({ state: "stopped" });
  await expect(recovery).rejects.toThrow("Editor selection changed");
});
