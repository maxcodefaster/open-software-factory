import { describe, expect, test } from "bun:test";
import {
  plainErrorMessage,
  plainFailureMessage,
  unreachableMessage,
  untilReachable,
} from "./command-error";

describe("plainErrorMessage", () => {
  test("replaces transport and runtime errors", () => {
    expect(plainErrorMessage("Failed to fetch")).toContain("could not reach the server");
    expect(plainErrorMessage("NetworkError when attempting to fetch resource.")).toContain(
      "could not reach the server",
    );
    expect(plainErrorMessage("Server function call failed with status 500")).toBe(
      "Factory could not complete that action. Try again.",
    );
    expect(plainErrorMessage("TypeError: x is undefined")).toBe(
      "Factory could not complete that action. Try again.",
    );
  });
  test("keeps messages written for people", () => {
    expect(plainErrorMessage("Name is already used in this Project.")).toBe(
      "Name is already used in this Project.",
    );
  });
});

describe("untilReachable", () => {
  test("retries a brief outage and returns the first success", async () => {
    let calls = 0;
    const value = await untilReachable(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error(unreachableMessage);
        return "ok";
      },
      1_000,
      1,
    );
    expect(value).toBe("ok");
    expect(calls).toBe(3);
  });
  test("surfaces other failures at once", async () => {
    let calls = 0;
    await expect(
      untilReachable(
        async () => {
          calls += 1;
          throw new Error("Name is already used.");
        },
        1_000,
        1,
      ),
    ).rejects.toThrow("Name is already used.");
    expect(calls).toBe(1);
  });
  test("gives up once the outage outlasts the limit", async () => {
    await expect(
      untilReachable(
        async () => {
          throw new Error(unreachableMessage);
        },
        20,
        5,
      ),
    ).rejects.toThrow(unreachableMessage);
  });
});

describe("plainErrorMessage for server bookkeeping", () => {
  const reload = "This request no longer matches what was saved. Reload and try again.";
  const changed =
    "The work changed while this was running. Check its current status, then try again.";
  test("names a reused or changed request without the word identity or command", () => {
    for (const message of [
      "Release command identity was already used",
      "The implementation command identity was reused with different input",
      "This save command belongs to another document",
      "Policy command changed input",
      "Checks retry changed target",
      "This editing request identity has different input.",
      "Media identity changed its original content",
      "This action key already created a different Ticket.",
    ])
      expect(plainErrorMessage(message)).toBe(reload);
  });
  test("names changed ownership as work that changed", () => {
    for (const message of [
      "Build authority changed before dispatch",
      "Agent turn ownership expired before settlement",
      "Browser no longer owns this Build execution",
      "Monitoring diagnosis lost execution ownership",
    ])
      expect(plainErrorMessage(message)).toBe(changed);
  });
  test("keeps unconfirmed outcomes and their guidance as written", () => {
    for (const message of [
      "Skill publication outcome is unconfirmed",
      "Your message was saved. The response outcome is unconfirmed; no request was replayed.",
      "Browser recovery storage is unavailable. Unconfirmed requests are retained.",
      "A mirror operation is unconfirmed. Check Forgejo and reload before another change.",
    ])
      expect(plainErrorMessage(message)).toBe(message);
  });
  test("replaces internal terms and bare status text", () => {
    expect(plainErrorMessage("Request failed with 502")).toBe(
      "Factory could not complete that action. Try again.",
    );
    expect(plainErrorMessage("MCP tool namespace collision")).toContain("same name");
    expect(plainErrorMessage("This Runtime Attempt is not connected.")).toBe(
      "This Sandbox is not connected.",
    );
  });
  test("keeps ordinary guidance", () => {
    for (const message of [
      "The Ticket changed. Review the current requirements before implementing.",
      "Choose a model from the approved catalogue",
      "Enter a commit message",
    ])
      expect(plainErrorMessage(message)).toBe(message);
  });
});

describe("plainFailureMessage for stored failures", () => {
  test("turns provider codes into one sentence with a next step", () => {
    const raw =
      "rate_limit_exceeded: Your requests to gpt-5.6-terra in swedencentral have exceeded token rate limit.";
    expect(plainFailureMessage(raw)).toContain("limiting requests");
    expect(plainFailureMessage(raw)).not.toContain("rate_limit_exceeded");
    expect(
      plainFailureMessage(
        "Factory Coding allowance paused subsequent inference. Existing code is retained; resume explicitly after reset or an allowance increase.",
      ),
    ).toBe(
      "The Coding allowance is used up. Your code is kept. Resume after the allowance resets or is raised.",
    );
  });
  test("still applies the bookkeeping rules", () => {
    expect(plainFailureMessage("Build authority changed before dispatch")).toContain(
      "changed while this was running",
    );
  });
  test("plainErrorMessage never rewrites messages that quote a title", () => {
    const quoted =
      "Prerequisites must be delivered before implementation: Fix network error 429 overloaded";
    expect(plainErrorMessage(quoted)).toBe(quoted);
  });
});
