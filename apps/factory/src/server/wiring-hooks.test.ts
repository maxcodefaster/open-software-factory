import { describe, expect, test } from "bun:test";
import type { DatabaseTransaction } from "#db/client";
import { CommandError } from "../command-error";
import { createWiringHooks, type WriterAccess } from "./wiring-hooks";

describe("createWiringHooks", () => {
  test("fails explicitly when required hooks are invoked before registration", async () => {
    const hooks = createWiringHooks();

    expect(() => hooks.runtimeStatus("att-1", "ready")).toThrow(
      'Factory wiring hook "runtimeStatus" was invoked before registration',
    );
    expect(() => hooks.onMonitoringTrigger("proj-1")).toThrow(
      'Factory wiring hook "onMonitoringTrigger" was invoked before registration',
    );
    expect(() => hooks.onProjectRegistered("proj-1", "user-1", false)).toThrow(
      'Factory wiring hook "onProjectRegistered" was invoked before registration',
    );
    expect(() => hooks.stopAgent("chg-1")).toThrow(
      'Factory wiring hook "stopCoding" was invoked before registration',
    );
    expect(() => hooks.writerAccess.view("chg-1", "user-1")).toThrow(
      'Factory wiring hook "writerAccess" was invoked before registration',
    );

    const fakeSql = {} as DatabaseTransaction;
    expect(() =>
      hooks.admitTechnical(fakeSql, {
        commandID: "cmd-1",
        projectID: "proj-1",
        ticketID: "tkt-1",
        userID: "user-1",
        sourceCommit: "abc",
      }),
    ).toThrow('Factory wiring hook "admitTechnical" was invoked before registration');
  });

  test("preserves exact unavailable CommandError when stopCoding is called before agent wiring", async () => {
    const hooks = createWiringHooks();
    try {
      await hooks.stopCoding("chg-1");
      throw new Error("Expected stopCoding to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(CommandError);
      expect((error as CommandError).code).toBe("unavailable");
      expect((error as CommandError).message).toBe(
        "Coding Stop is not ready; compute was retained",
      );
    }
  });

  test("rejects duplicate hook registration", () => {
    const hooks = createWiringHooks();
    hooks.registerMonitoringTrigger(() => {});
    expect(() => hooks.registerMonitoringTrigger(() => {})).toThrow(
      'Factory wiring hook "onMonitoringTrigger" is already registered',
    );
  });

  test("runs onRuntimeReady handlers in agent-before-browser order and tolerates early startup calls", async () => {
    const hooks = createWiringHooks();
    const order: string[] = [];

    // Early startup before agent or browser registration must not throw.
    hooks.onRuntimeActivity();
    await hooks.onRuntimeReady("att-early");
    await hooks.dispatchPendingCoding("chg-early");
    expect(await hooks.tryStopCoding("chg-early")).toBeUndefined();

    // Register browser first (as wireRuntime does), then agent (as wireProduct does).
    hooks.registerBuildBrowserReady(async (attemptID) => {
      order.push(`browser:${attemptID}`);
    });
    hooks.registerAgent({
      stopCoding: async (changeID) => {
        order.push(`stop:${changeID}`);
      },
      onRuntimeActivity: () => {
        order.push("activity");
      },
      onRuntimeReady: async (attemptID) => {
        order.push(`agent:${attemptID}`);
      },
      dispatchPendingCoding: async (changeID) => {
        order.push(`dispatch:${changeID}`);
      },
    });

    hooks.onRuntimeActivity();
    await hooks.onRuntimeReady("att-1");
    await hooks.dispatchPendingCoding("chg-1");
    await hooks.stopCoding("chg-1");

    expect(order).toEqual([
      "activity",
      "agent:att-1",
      "browser:att-1",
      "dispatch:chg-1",
      "stop:chg-1",
    ]);
  });

  test("forwards writerAccess calls after registration", async () => {
    const hooks = createWiringHooks();
    const seen: string[] = [];
    const writers: WriterAccess = {
      view: async (changeID, userID) => {
        seen.push(`view:${changeID}:${userID}`);
        return {} as Awaited<ReturnType<WriterAccess["view"]>>;
      },
      takeOver: async () => ({}) as Awaited<ReturnType<WriterAccess["takeOver"]>>,
      activity: async () => {},
      request: async () => ({}) as Awaited<ReturnType<WriterAccess["request"]>>,
      release: async () => ({}) as Awaited<ReturnType<WriterAccess["release"]>>,
      approve: async () => ({}) as Awaited<ReturnType<WriterAccess["approve"]>>,
      takeIdle: async () => ({}) as Awaited<ReturnType<WriterAccess["takeIdle"]>>,
    };

    hooks.registerWriterAccess(writers);
    await hooks.writerAccess.view("chg-42", "usr-7");
    expect(seen).toEqual(["view:chg-42:usr-7"]);
  });
});
