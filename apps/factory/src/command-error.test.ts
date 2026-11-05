import { describe, expect, test } from "bun:test";
import { plainErrorMessage } from "./command-error";

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
