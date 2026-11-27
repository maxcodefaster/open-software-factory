import { describe, expect, test } from "bun:test";
import type { ModelConnectionView } from "#conversation-domain/model-connection";
import {
  connectionLabel,
  describeRoleAccessStatus,
  isConnectionFormLocked,
  isProbingRole,
  startEditingConnection,
} from "./connection-state";

const sampleConnection: ModelConnectionView = {
  connectionID: "abcdef123456",
  version: 3,
  provider: "openai",
  endpoint: "https://my-resource.openai.azure.com/openai/v1",
  configured: true,
  pendingCommandID: null,
};

describe("model connection state machine", () => {
  test("formats Azure and provider labels cleanly", () => {
    expect(connectionLabel(sampleConnection)).toBe("Azure · my-resource · abcdef");
    expect(
      connectionLabel({
        connectionID: "1234567890",
        provider: "anthropic",
        endpoint: null,
      }),
    ).toBe("anthropic · 123456");
  });

  test("tracks editing/saving lock state and probing role state", () => {
    const editing = startEditingConnection(sampleConnection);
    expect(editing.kind).toBe("editing");
    expect(isConnectionFormLocked(editing)).toBe(false);
    expect(isConnectionFormLocked({ kind: "viewing", saved: true })).toBe(false);
    expect(
      isConnectionFormLocked({
        kind: "editing",
        target: sampleConnection,
        provider: "openai",
        apiKey: "",
        endpoint: "",
        pendingSave: {
          commandID: "cmd-1",
          connectionID: sampleConnection.connectionID,
          version: 3,
          provider: "openai",
          endpoint: null,
          apiKey: "secret",
        },
      }),
    ).toBe(true);

    const probe = {
      kind: "probing" as const,
      role: "build" as const,
      abort: new AbortController(),
    };
    expect(isProbingRole(probe, "build")).toBe(true);
    expect(isProbingRole(probe, "planning")).toBe(false);
    expect(isProbingRole({ kind: "idle" }, "build")).toBe(false);
  });

  test("describes role access status across checking, probing, uncertain and unconfigured states", () => {
    expect(
      describeRoleAccessStatus({
        checking: true,
        active: undefined,
        deploymentConfigured: false,
        endpoint: null,
      }),
    ).toBe("Checking access…");
    expect(
      describeRoleAccessStatus({
        checking: false,
        active: undefined,
        deploymentConfigured: false,
        endpoint: null,
      }),
    ).toBe("Not configured");
    expect(
      describeRoleAccessStatus({
        checking: false,
        active: undefined,
        deploymentConfigured: true,
        endpoint: null,
      }),
    ).toBe("Access not checked");
  });
});
