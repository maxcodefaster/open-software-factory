import { describe, expect, test } from "bun:test";
import { plainErrorMessage, unreachableMessage, untilReachable } from "./command-error";

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
