import { expect, test } from "bun:test";
import { fixtureValue } from "../fixtures/value";

test("fixture values reject null and undefined with their owning expectation", () => {
  for (const value of [undefined, null])
    expect(() => fixtureValue(value, "the admitted response")).toThrow(
      "Missing fixture value: the admitted response",
    );
});

test("fixture values preserve falsy data and object identity", () => {
  for (const value of [false, 0, ""]) expect(fixtureValue(value, "present data")).toBe(value);
  const record = { id: "owned-fixture" };
  expect(fixtureValue(record, "the owned record")).toBe(record);
});
