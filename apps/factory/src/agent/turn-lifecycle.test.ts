import { describe, expect, test } from "bun:test";
import { canTransitionAdmissionPhase, transitionAdmissionPhase } from "./change-admission-context";
import {
  assertOpenCodeSessionMatches,
  canTransitionDispatchPhase,
  canTransitionRecoveryPhase,
  transitionDispatchPhase,
  transitionRecoveryPhase,
} from "./turn-lifecycle";

describe("agent turn lifecycle state machines", () => {
  test("dispatch phase follows pending -> claimed -> prepared -> dispatched -> running -> settled", () => {
    expect(transitionDispatchPhase("pending", "claimed")).toBe("claimed");
    expect(transitionDispatchPhase("claimed", "prepared")).toBe("prepared");
    expect(transitionDispatchPhase("prepared", "dispatched")).toBe("dispatched");
    expect(transitionDispatchPhase("dispatched", "running")).toBe("running");
    expect(transitionDispatchPhase("running", "settled")).toBe("settled");

    expect(canTransitionDispatchPhase("pending", "settled")).toBe(true);
    expect(canTransitionDispatchPhase("pending", "running")).toBe(false);
    expect(canTransitionDispatchPhase("settled", "claimed")).toBe(false);
    expect(() => transitionDispatchPhase("pending", "dispatched")).toThrow(
      "Invalid dispatch transition from pending to dispatched",
    );
  });

  test("recovery phase allows observation loops, input admission, restoration, and uncertain settlement", () => {
    expect(transitionRecoveryPhase("claiming", "observing")).toBe("observing");
    expect(transitionRecoveryPhase("observing", "admitting-input")).toBe("admitting-input");
    expect(transitionRecoveryPhase("admitting-input", "observing")).toBe("observing");
    expect(transitionRecoveryPhase("observing", "restoring")).toBe("restoring");
    expect(transitionRecoveryPhase("restoring", "monitoring")).toBe("monitoring");

    expect(canTransitionRecoveryPhase("observing", "uncertain")).toBe(true);
    expect(canTransitionRecoveryPhase("uncertain", "observing")).toBe(false);
    expect(() => transitionRecoveryPhase("claiming", "monitoring")).toThrow(
      "Invalid recovery transition from claiming to monitoring",
    );
  });

  test("admission phase allows replay short-circuit or full locked policy admission", () => {
    expect(transitionAdmissionPhase("validating", "replayed")).toBe("replayed");
    expect(transitionAdmissionPhase("validating", "context-locked")).toBe("context-locked");
    expect(transitionAdmissionPhase("context-locked", "policy-checked")).toBe("policy-checked");
    expect(transitionAdmissionPhase("policy-checked", "admitted")).toBe("admitted");

    expect(canTransitionAdmissionPhase("replayed", "admitted")).toBe(false);
    expect(canTransitionAdmissionPhase("admitted", "validating")).toBe(false);
    expect(() => transitionAdmissionPhase("validating", "admitted")).toThrow(
      "Invalid admission transition from validating to admitted",
    );
  });

  test("assertOpenCodeSessionMatches validates session identity, directory, and factory model", () => {
    const valid = {
      id: "ses_1",
      location: { directory: "/workspace" },
      model: { providerID: "factory", id: "gpt-5" },
    };
    expect(() =>
      assertOpenCodeSessionMatches(
        valid,
        { sessionID: "ses_1", directory: "/workspace", modelID: "gpt-5" },
        "mismatch",
      ),
    ).not.toThrow();
    expect(() =>
      assertOpenCodeSessionMatches(
        { ...valid, model: { providerID: "openai", id: "gpt-5" } },
        { sessionID: "ses_1", directory: "/workspace", modelID: "gpt-5" },
        "custom mismatch",
      ),
    ).toThrow("custom mismatch");
  });
});
