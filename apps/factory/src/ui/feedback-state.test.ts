import { expect, test } from "bun:test";
import { copyFeedbackLabel, saveFeedback } from "./feedback-state";

test("only an acknowledged save has a success state", () => {
  expect(saveFeedback("idle")).toEqual({ state: "idle", message: "" });
  expect(saveFeedback("dirty")).toEqual({
    state: "idle",
    message: "Changes will save automatically",
  });
  expect(saveFeedback("saving")).toEqual({ state: "pending", message: "Saving…" });
  expect(saveFeedback("saved")).toEqual({ state: "success", message: "Saved" });
  expect(saveFeedback("error")).toEqual({
    state: "error",
    message: "Not saved. Your draft is retained.",
  });
});

test("copy feedback preserves the idle action and names pending and failed outcomes", () => {
  expect(copyFeedbackLabel("idle", "Copy URL")).toBe("Copy URL");
  expect(copyFeedbackLabel("pending")).toBe("Copying…");
  expect(copyFeedbackLabel("success")).toBe("Copied");
  expect(copyFeedbackLabel("error")).toBe("Copy failed");
});
