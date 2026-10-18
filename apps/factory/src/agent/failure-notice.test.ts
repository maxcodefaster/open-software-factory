import { expect, test } from "bun:test";
import { projectFailureNotice } from "./failure-notice";

test("a definite validation failure explains the known problem instead of hiding it", () => {
  const message = projectFailureNotice({
    state: "failed",
    summary: "The Project Agent returned an invalid response. Your input is saved.",
  });
  expect(message).toContain("invalid response");
  expect(message).toContain("No request was resent");
});

test("an unknown provider outcome is not presented as a definite rejected response", () => {
  const message = projectFailureNotice({ state: "uncertain", summary: null });
  expect(message).toContain("could not confirm");
  expect(message).toContain("separate AI request");
  expect(message).not.toContain("ready to continue");
});

test("stopped work does not invite an automatic restart", () => {
  expect(projectFailureNotice({ state: "stopped", summary: null })).toBe(
    "This response was stopped. Your input is saved; no request was resent.",
  );
});
