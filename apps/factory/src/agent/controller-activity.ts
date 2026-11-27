import { reportFailure } from "../failure-log";
import type { RuntimeHub } from "../runtime/transport-api";
import {
  type AgentActivity,
  type AgentBrowser,
  type AgentTurnStore,
  opencode,
  type RenewExecution,
} from "./controller-types";
import { createOpenCodeEvents } from "./opencode-events";

type ActivityListener = {
  notify(): void;
  attemptID?: string;
  detach?: () => void;
};

export function createAgentActivity(
  hub: RuntimeHub,
  browser: AgentBrowser | undefined,
): AgentActivity {
  const observationController = new AbortController();
  const nativeEvents = createOpenCodeEvents((attemptID) => opencode(hub, attemptID));
  const activityListeners = new Map<string, Set<ActivityListener>>();
  const background = new Set<Promise<void>>();
  let closed = false;

  function notifyActivity(changeID?: string) {
    for (const [id, listeners] of activityListeners)
      if (!changeID || id === changeID) for (const listener of listeners) listener.notify();
  }

  function bindActivity(changeID: string, attemptID?: string) {
    if (closed) return;
    for (const listener of activityListeners.get(changeID) ?? []) {
      if (listener.attemptID === attemptID) continue;
      const detach = attemptID ? nativeEvents.subscribe(attemptID, listener.notify) : undefined;
      listener.detach?.();
      if (attemptID) listener.attemptID = attemptID;
      else delete listener.attemptID;
      if (detach) listener.detach = detach;
      else delete listener.detach;
    }
  }

  function subscribeActivity(changeID: string, notify: () => void) {
    if (closed) return () => {};
    const listeners = activityListeners.get(changeID) ?? new Set<ActivityListener>();
    const listener: ActivityListener = { notify };
    listeners.add(listener);
    activityListeners.set(changeID, listeners);
    return () => {
      listener.detach?.();
      listeners.delete(listener);
      if (!listeners.size) activityListeners.delete(changeID);
    };
  }

  function subscribeAttemptEvents(attemptID: string, listener: (type: string) => void) {
    return nativeEvents.subscribe(attemptID, listener);
  }

  function run(work: Promise<void>) {
    background.add(work);
    void work.catch(reportFailure("Background agent work")).finally(() => {
      background.delete(work);
      notifyActivity();
    });
  }

  // Stop observing and join owned work before its database/transport is
  // disposed. Durable intent remains recoverable; this does not issue Stop.
  async function shutdown() {
    closed = true;
    observationController.abort();
    await nativeEvents.shutdown();
    while (background.size) await Promise.allSettled([...background]);
    await browser?.recover();
  }

  return {
    isClosed: () => closed,
    signal: observationController.signal,
    notifyActivity,
    bindActivity,
    subscribeActivity,
    subscribeAttemptEvents,
    run,
    shutdown,
  };
}

export function createExecutionRenewer(
  turns: AgentTurnStore,
  activity: AgentActivity,
  browser: AgentBrowser | undefined,
): RenewExecution {
  return async function renewExecution(turnID: string, ownerToken: string) {
    const renewed = await turns.renew(turnID, ownerToken);
    // Browser renewal coalesces per turn and can await slow owned cleanup.
    // Join it as background work without occupying the owner keepalive.
    if (renewed && !activity.isClosed() && browser)
      activity.run(browser.renewTurn(turnID, ownerToken));
    return renewed;
  };
}
