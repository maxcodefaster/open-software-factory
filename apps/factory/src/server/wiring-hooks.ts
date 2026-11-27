import type { DatabaseTransaction } from "#db/client";
import type { createChangeWriterController } from "../access/writer-controller";
import type { PendingWriterHandoff } from "../agent/runtime-api";
import { CommandError } from "../command-error";

export type WriterAccess = Pick<
  ReturnType<typeof createChangeWriterController>,
  "view" | "takeOver" | "activity" | "request" | "release" | "approve" | "takeIdle"
>;

export type AdmitTechnicalInput = {
  commandID: string;
  projectID: string;
  ticketID: string;
  userID: string;
  sourceCommit: string;
  contextID?: string;
};

type LateBinding<T> = {
  bind(value: T): void;
  get(): T;
  peek(): T | undefined;
};

function createLateBinding<T>(name: string): LateBinding<T> {
  let bound: T | undefined;
  return {
    bind(value) {
      if (bound !== undefined) {
        throw new Error(`Factory wiring hook "${name}" is already registered`);
      }
      bound = value;
    },
    get() {
      if (bound === undefined) {
        throw new Error(`Factory wiring hook "${name}" was invoked before registration`);
      }
      return bound;
    },
    peek() {
      return bound;
    },
  };
}

/**
 * Explicit, typed cross-subsystem hook registry for Factory application wiring.
 * Replaces ad-hoc late-bound `let` controller declarations with single-assignment
 * slots that fail loudly if double-registered or invoked before being wired.
 */
export function createWiringHooks() {
  const runtimeStatus =
    createLateBinding<(attemptID: string, phase: string, error?: string) => Promise<void>>(
      "runtimeStatus",
    );
  const supportsInitialSourceRole = createLateBinding<
    (attemptID: string, sql: DatabaseTransaction) => Promise<boolean>
  >("supportsInitialSourceRole");
  const wakeForAccess =
    createLateBinding<
      (workspaceID: string, userID: string, signal?: AbortSignal, write?: boolean) => Promise<void>
    >("wakeForAccess");

  const browserRuntimeReady =
    createLateBinding<(attemptID: string) => Promise<unknown>>("browserRuntimeReady");
  const agentRuntimeReady =
    createLateBinding<(attemptID: string) => Promise<void>>("agentRuntimeReady");
  const runtimeActivity = createLateBinding<() => void>("onRuntimeActivity");
  const stopCoding =
    createLateBinding<(changeID: string, handoff?: PendingWriterHandoff) => Promise<unknown>>(
      "stopCoding",
    );
  const dispatchPendingCoding =
    createLateBinding<(changeID: string) => Promise<void>>("dispatchPendingCoding");

  const writerAccessSlot = createLateBinding<WriterAccess>("writerAccess");
  const admitTechnical =
    createLateBinding<(sql: DatabaseTransaction, input: AdmitTechnicalInput) => Promise<unknown>>(
      "admitTechnical",
    );
  const monitoringTrigger = createLateBinding<(projectID: string) => void>("onMonitoringTrigger");
  const projectRegistered =
    createLateBinding<(projectID: string, userID: string, recovering: boolean) => Promise<void>>(
      "onProjectRegistered",
    );

  const writerAccess: WriterAccess = {
    view: (changeID, userID) => writerAccessSlot.get().view(changeID, userID),
    takeOver: (...args) => writerAccessSlot.get().takeOver(...args),
    activity: (changeID, userID, epoch, kind) =>
      writerAccessSlot.get().activity(changeID, userID, epoch, kind),
    request: (...args) => writerAccessSlot.get().request(...args),
    release: (...args) => writerAccessSlot.get().release(...args),
    approve: (...args) => writerAccessSlot.get().approve(...args),
    takeIdle: (...args) => writerAccessSlot.get().takeIdle(...args),
  };

  return {
    registerRuntime(handlers: {
      runtimeStatus: (attemptID: string, phase: string, error?: string) => Promise<void>;
      supportsInitialSourceRole: (attemptID: string, sql: DatabaseTransaction) => Promise<boolean>;
      wakeForAccess: (
        workspaceID: string,
        userID: string,
        signal?: AbortSignal,
        write?: boolean,
      ) => Promise<void>;
    }) {
      runtimeStatus.bind(handlers.runtimeStatus);
      supportsInitialSourceRole.bind(handlers.supportsInitialSourceRole);
      wakeForAccess.bind(handlers.wakeForAccess);
    },

    registerBuildBrowserReady(handler: (attemptID: string) => Promise<unknown>) {
      browserRuntimeReady.bind(handler);
    },

    registerWriterAccess(writers: WriterAccess) {
      writerAccessSlot.bind(writers);
    },

    registerAgent(handlers: {
      stopCoding: (changeID: string, handoff?: PendingWriterHandoff) => Promise<unknown>;
      onRuntimeActivity: () => void;
      onRuntimeReady: (attemptID: string) => Promise<void>;
      dispatchPendingCoding: (changeID: string) => Promise<void>;
    }) {
      stopCoding.bind(handlers.stopCoding);
      runtimeActivity.bind(handlers.onRuntimeActivity);
      agentRuntimeReady.bind(handlers.onRuntimeReady);
      dispatchPendingCoding.bind(handlers.dispatchPendingCoding);
    },

    registerAdmitTechnical(
      handler: (sql: DatabaseTransaction, input: AdmitTechnicalInput) => Promise<unknown>,
    ) {
      admitTechnical.bind(handler);
    },

    registerMonitoringTrigger(handler: (projectID: string) => void) {
      monitoringTrigger.bind(handler);
    },

    registerProjectRegistered(
      handler: (projectID: string, userID: string, recovering: boolean) => Promise<void>,
    ) {
      projectRegistered.bind(handler);
    },

    runtimeStatus(attemptID: string, phase: string, error?: string) {
      return runtimeStatus.get()(attemptID, phase, error);
    },

    supportsInitialSourceRole(attemptID: string, sql: DatabaseTransaction) {
      return supportsInitialSourceRole.get()(attemptID, sql);
    },

    wakeForAccess(workspaceID: string, userID: string, signal?: AbortSignal, write = true) {
      return wakeForAccess.get()(workspaceID, userID, signal, write);
    },

    onRuntimeActivity() {
      runtimeActivity.peek()?.();
    },

    async onRuntimeReady(attemptID: string) {
      const agentReady = agentRuntimeReady.peek();
      if (agentReady) await agentReady(attemptID);
      const browserReady = browserRuntimeReady.peek();
      if (browserReady) await browserReady(attemptID);
    },

    async stopCoding(changeID: string, handoff?: PendingWriterHandoff) {
      const stop = stopCoding.peek();
      if (!stop) {
        throw new CommandError("unavailable", "Coding Stop is not ready; compute was retained");
      }
      await stop(changeID, handoff);
    },

    stopAgent(changeID: string) {
      return stopCoding.get()(changeID);
    },

    async tryStopCoding(changeID: string) {
      const stop = stopCoding.peek();
      if (!stop) return undefined;
      return stop(changeID);
    },

    async dispatchPendingCoding(changeID: string) {
      await dispatchPendingCoding.peek()?.(changeID);
    },

    writerAccess,

    admitTechnical(sql: DatabaseTransaction, input: AdmitTechnicalInput) {
      return admitTechnical.get()(sql, input);
    },

    onMonitoringTrigger(projectID: string) {
      monitoringTrigger.get()(projectID);
    },

    onProjectRegistered(projectID: string, userID: string, recovering: boolean) {
      return projectRegistered.get()(projectID, userID, recovering);
    },
  };
}

export type WiringHooks = ReturnType<typeof createWiringHooks>;
