import { describe, expect, test } from "bun:test";
import {
  CommandError,
  type CommandErrorReason,
  genericFailure,
  isUnreachable,
  plainErrorFor,
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
  test("database query failures never disclose SQL or bound lease and credential values", () => {
    const raw =
      'Failed query: select "owner_token" from "factory"."agent_turn" where "owner_token" = $1\nparams: private-lease-529,private-key';
    const expected =
      "Factory could not confirm its saved state. Check the current status before starting another action.";
    expect(plainErrorMessage(raw)).toBe(expected);
    expect(plainFailureMessage(raw)).toBe(expected);
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

describe("CommandError typed reasons and plainErrorFor", () => {
  const expectedByReason: Record<CommandErrorReason, string> = {
    "rate-limited":
      "The model provider is limiting requests right now. Wait a minute, then retry. Retained work is kept.",
    "provider-auth":
      "The model provider rejected Factory's credentials. Ask a System Manager to check the model connection, then retry. Retained work is kept.",
    "provider-quota":
      "The model provider reports that the account has no quota left. Ask a System Manager to check the provider account, then retry. Retained work is kept.",
    "context-too-long":
      "This conversation is too long for the model. Start a new conversation or shorten the request. Retained work is kept.",
    "provider-unavailable":
      "The model provider is temporarily unavailable. Wait a minute, then retry. Retained work is kept.",
    "provider-network":
      "Factory lost its connection to the model provider. Wait a minute, then retry. Retained work is kept.",
    "coding-allowance":
      "The Coding allowance is used up. Your code is kept. Resume after the allowance resets or is raised.",
    "stale-request": "This request no longer matches what was saved. Reload and try again.",
    "work-changed":
      "The work changed while this was running. Check its current status, then try again.",
    "namespace-collision":
      "Two connected tools have the same name. Disable one of them in Settings.",
    "database-state":
      "Factory could not confirm its saved state. Check the current status before starting another action.",
    unreachable: unreachableMessage,
  };

  test("preserves backward-compatible two-argument CommandError construction", () => {
    const cases = [
      ["invalid", 400],
      ["conflict", 409],
      ["not-found", 404],
      ["unavailable", 503],
      ["forbidden", 403],
    ] as const;
    for (const [code, status] of cases) {
      const error = new CommandError(code, "Something went wrong.");
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(CommandError);
      expect(error.name).toBe("CommandError");
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
      expect(error.message).toBe("Something went wrong.");
      expect(error.reason).toBeUndefined();
      expect(error.cause).toBeUndefined();
    }
  });

  test("records optional reason and cause on CommandError", () => {
    const inner = new Error("socket closed");
    const error = new CommandError("unavailable", "upstream disconnected", {
      reason: "provider-network",
      cause: inner,
    });
    expect(error.code).toBe("unavailable");
    expect(error.status).toBe(503);
    expect(error.message).toBe("upstream disconnected");
    expect(error.reason).toBe("provider-network");
    expect(error.cause).toBe(inner);
  });

  test("treats CommandError with unreachable reason as unreachable for retries", async () => {
    const error = new CommandError("unavailable", "gateway timeout", { reason: "unreachable" });
    expect(isUnreachable(error)).toBe(true);
    expect(
      isUnreachable(new CommandError("unavailable", "rate limit", { reason: "rate-limited" })),
    ).toBe(false);

    let calls = 0;
    const result = await untilReachable(
      async () => {
        calls += 1;
        if (calls < 2) throw error;
        return "recovered";
      },
      1_000,
      1,
    );
    expect(result).toBe("recovered");
    expect(calls).toBe(2);
  });

  test("maps every CommandErrorReason directly via lookup table before regex rules", () => {
    const reasons = Object.keys(expectedByReason) as CommandErrorReason[];
    for (const reason of reasons) {
      const expected = expectedByReason[reason];
      // Raw message deliberately resembles a different error category to verify reason wins first.
      const conflictingRaw =
        reason === "database-state"
          ? "Failed to fetch"
          : 'Failed query: select "secret" from "tokens"';
      const error = new CommandError("unavailable", conflictingRaw, { reason });

      expect(plainErrorFor(error)).toBe(expected);
      expect(plainErrorMessage(conflictingRaw, reason)).toBe(expected);
      expect(plainFailureMessage(conflictingRaw, reason)).toBe(expected);
    }
  });

  test("plainErrorFor falls back to plainErrorMessage when CommandError has no reason", () => {
    expect(
      plainErrorFor(new CommandError("conflict", "Build authority changed before dispatch")),
    ).toBe(expectedByReason["work-changed"]);
    expect(
      plainErrorFor(new CommandError("invalid", "Name is already used in this Project.")),
    ).toBe("Name is already used in this Project.");

    const quoted =
      "Prerequisites must be delivered before implementation: Fix network error 429 overloaded";
    expect(plainErrorFor(new CommandError("conflict", quoted))).toBe(quoted);
  });

  test("plainErrorFor handles plain Errors, strings, and unknown values", () => {
    expect(plainErrorFor(new TypeError("Failed to fetch"))).toBe(unreachableMessage);
    expect(plainErrorFor(new Error("TypeError: x is undefined"))).toBe(genericFailure);
    expect(plainErrorFor(new Error("Failed query: select 1"))).toBe(
      expectedByReason["database-state"],
    );
    expect(plainErrorFor(new Error("This Runtime Attempt is not connected."))).toBe(
      "This Sandbox is not connected.",
    );
    expect(plainErrorFor("Failed to fetch")).toBe(unreachableMessage);
    expect(plainErrorFor("Name is already used.")).toBe("Name is already used.");

    for (const blank of [
      new CommandError("unavailable", ""),
      new CommandError("unavailable", "   "),
      new Error(""),
      "",
      "   ",
      null,
      undefined,
      42,
      { message: "ignored object" },
    ]) {
      expect(plainErrorFor(blank)).toBe(genericFailure);
    }
  });
});
