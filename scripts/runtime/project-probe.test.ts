import { expect, test } from "bun:test";
import { projectStateProbeArguments } from "./project-probe";

test("project probes bind the container selected at invocation, never an empty initial identity", () => {
  expect(() => projectStateProbeArguments("", [])).toThrow("immutable container identity");
  const source = "a".repeat(64);
  const next = "b".repeat(64);
  expect(
    projectStateProbeArguments(source, ["--env", "NODE_OPTIONS=--dns-result-order=ipv4first"]),
  ).toContain(source);
  expect(projectStateProbeArguments(next, [])).toContain(next);
  expect(projectStateProbeArguments(next, [])).not.toContain(source);
});
