import { describe, expect, test } from "bun:test";
import { monitoringSaveNotice } from "./settings-types";

describe("monitoringSaveNotice", () => {
  test("omits prior-work disclaimer for newly created inputs", () => {
    expect(monitoringSaveNotice(0, false)).toBe("Input enabled for new requests.");
  });

  test("appends prior-work disclaimer only when re-enabling an existing disabled input", () => {
    expect(monitoringSaveNotice(2, false)).toBe(
      "Input enabled for new requests. Earlier work is not resumed.",
    );
    expect(monitoringSaveNotice(2, true)).toBe("Input enabled for new requests.");
  });
});
