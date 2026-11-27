import { describe, expect, test } from "bun:test";
import {
  classifyActorState,
  classifyTemplateState,
  planBrowserUpdate,
} from "./substrate-browser-state";

const at = "2026-01-01T00:00:00.000Z";
const templateUid = "11111111-1111-4111-8111-111111111111";
const actorUid = "22222222-2222-4222-8222-222222222222";

describe("NativeResourceState classifiers", () => {
  test("classifies pending, attempted, confirmed, and rejected template states", () => {
    expect(classifyTemplateState({})).toEqual({ phase: "pending" });
    expect(classifyTemplateState({ templateAttemptedAt: at })).toEqual({
      phase: "attempted",
      attemptedAt: new Date(at),
    });
    expect(
      classifyTemplateState({
        templateAttemptedAt: at,
        templateUid,
        templateVersion: "1",
      }),
    ).toEqual({
      phase: "confirmed",
      attemptedAt: new Date(at),
      uid: templateUid,
      version: "1",
    });
    expect(classifyTemplateState({ templateAttemptedAt: at, templateRejected: true })).toEqual({
      phase: "rejected",
      attemptedAt: new Date(at),
    });
  });

  test("classifies pending, attempted, confirmed, and rejected actor states", () => {
    expect(classifyActorState({}, {})).toEqual({ phase: "pending" });
    expect(classifyActorState({ actorAttemptedAt: at }, {})).toEqual({
      phase: "attempted",
      attemptedAt: new Date(at),
    });
    expect(classifyActorState({ actorAttemptedAt: at }, { actorUid })).toEqual({
      phase: "confirmed",
      attemptedAt: new Date(at),
      uid: actorUid,
    });
    expect(classifyActorState({ actorAttemptedAt: at, actorRejected: true }, {})).toEqual({
      phase: "rejected",
      attemptedAt: new Date(at),
    });
  });
});

describe("planBrowserUpdate", () => {
  test("plans valid lifecycle transitions from intended through closed", () => {
    expect(planBrowserUpdate("intended", {}, {}, { templateAttemptedAt: true })).toEqual({
      kind: "timestamp",
      field: "templateAttemptedAt",
    });
    expect(
      planBrowserUpdate(
        "intended",
        { templateAttemptedAt: at },
        {},
        { templateUid, templateVersion: "1" },
      ),
    ).toEqual({ kind: "template-identity", uid: templateUid, version: "1" });
    expect(
      planBrowserUpdate(
        "intended",
        { templateAttemptedAt: at, templateUid, templateVersion: "1" },
        {},
        { templateUid, templateVersion: "1" },
      ),
    ).toEqual({ kind: "noop" });
    expect(
      planBrowserUpdate(
        "intended",
        { templateAttemptedAt: at, templateUid, templateVersion: "1", actorAttemptedAt: at },
        {},
        { actorUid },
      ),
    ).toEqual({ kind: "actor-identity", uid: actorUid });
    expect(
      planBrowserUpdate(
        "intended",
        { templateAttemptedAt: at, templateUid, templateVersion: "1", actorAttemptedAt: at },
        { actorUid },
        { resumeAttemptedAt: true },
      ),
    ).toEqual({ kind: "timestamp", field: "resumeAttemptedAt" });
    expect(
      planBrowserUpdate(
        "intended",
        { resumeAttemptedAt: at, resumeConfirmedAt: at },
        {},
        { connectAttemptedAt: true },
      ),
    ).toEqual({ kind: "timestamp", field: "connectAttemptedAt", activate: true });
    expect(
      planBrowserUpdate("closing", { actorDeletedAt: at }, {}, { templateDeletedAt: true }),
    ).toEqual({ kind: "timestamp", field: "templateDeletedAt", close: true });
  });

  test("rejects illegal transitions with exact immutable/ordering errors", () => {
    expect(() => planBrowserUpdate("closed", {}, {}, { templateAttemptedAt: true })).toThrow(
      "Native Browser intent, identity and external outcomes are immutable",
    );
    expect(() => planBrowserUpdate("closing", {}, {}, { actorAttemptedAt: true })).toThrow(
      "Closing Browser cannot start native execution",
    );
    expect(() =>
      planBrowserUpdate("intended", { actorAttemptedAt: at }, {}, { resumeAttemptedAt: true }),
    ).toThrow("Native Browser Resume requires confirmed Actor UID");
    expect(() =>
      planBrowserUpdate("intended", { resumeAttemptedAt: at }, {}, { connectAttemptedAt: true }),
    ).toThrow("Native Browser connect requires confirmed Resume");
    expect(() =>
      planBrowserUpdate(
        "intended",
        { templateAttemptedAt: at, templateUid, templateVersion: "1" },
        {},
        { templateUid, templateVersion: "2" },
      ),
    ).toThrow("Native Browser intent, identity and external outcomes are immutable");
    expect(() =>
      planBrowserUpdate("closing", { actorAttemptedAt: at }, {}, { actorDeletedAt: true }),
    ).toThrow("Native Browser deletion requires confirmed identity");
    expect(() => planBrowserUpdate("active", {}, {}, { actorDeletedAt: true })).toThrow(
      "Native Browser deletion requires saved cleanup intent",
    );
  });
});
