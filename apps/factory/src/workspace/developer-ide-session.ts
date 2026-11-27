export type AbortSlot = "sourceRecovery" | "sourceObservation" | "editorRecovery" | "frameReload";

export type WaitTimers = {
  pause(signal: AbortSignal): Promise<void>;
  outagePause(signal: AbortSignal): Promise<void>;
};

export type TimerAPI = {
  setTimeout: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
};

export function createWaitTimers(
  timers: TimerAPI = {
    setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
    clearTimeout: (id) => globalThis.clearTimeout(id),
  },
): WaitTimers {
  const { setTimeout: schedule, clearTimeout: cancel } = timers;
  return {
    pause(signal) {
      return new Promise<void>((resolve, reject) => {
        const abort = () => {
          cancel(timer);
          reject(signal.reason);
        };
        const timer = schedule(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, 200);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    },
    // Waits for the browser to report a connection again, or two seconds, whichever comes first.
    outagePause(signal) {
      return new Promise<void>((resolve, reject) => {
        const finish = () => {
          cancel(timer);
          window.removeEventListener("online", finish);
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          cancel(timer);
          window.removeEventListener("online", finish);
          reject(signal.reason);
        };
        const timer = schedule(finish, 2_000);
        window.addEventListener("online", finish, { once: true });
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    },
  };
}

export type DeveloperIDESession = {
  start(slot: AbortSlot): AbortController;
  abort(slot: AbortSlot): void;
  clearIfCurrent(slot: AbortSlot, controller: AbortController): boolean;
  abortIfCurrent(slot: AbortSlot, controller: AbortController): void;
  abortAll(): void;
  syncEditorScope(projectID: string | undefined, allowed: boolean): boolean;
  consumeEditorAdmission(retry: number): boolean;
  syncSourceScope(workspaceID: string | undefined, allowed: boolean): boolean;
  markNavigationSent(id: string): boolean;
  resetNavigation(): void;
};

export function createDeveloperIDESession(): DeveloperIDESession {
  const slots: Record<AbortSlot, AbortController | undefined> = {
    sourceRecovery: undefined,
    sourceObservation: undefined,
    editorRecovery: undefined,
    frameReload: undefined,
  };
  const tracking: {
    sentNavigation: string | undefined;
    admittedEditorRetry: number | undefined;
    lastEditorScope: string | undefined;
    lastSourceScope: string | undefined;
  } = {
    sentNavigation: undefined,
    admittedEditorRetry: undefined,
    lastEditorScope: undefined,
    lastSourceScope: undefined,
  };

  return {
    start(slot) {
      const controller = new AbortController();
      slots[slot] = controller;
      return controller;
    },
    abort(slot) {
      slots[slot]?.abort();
      slots[slot] = undefined;
    },
    clearIfCurrent(slot, controller) {
      if (slots[slot] !== controller) return false;
      slots[slot] = undefined;
      return true;
    },
    abortIfCurrent(slot, controller) {
      controller.abort();
      if (slots[slot] === controller) slots[slot] = undefined;
    },
    abortAll() {
      for (const slot of Object.keys(slots) as AbortSlot[]) {
        slots[slot]?.abort();
        slots[slot] = undefined;
      }
    },
    syncEditorScope(projectID, allowed) {
      const scope = `${projectID ?? ""}:${allowed}`;
      const changed = scope !== tracking.lastEditorScope;
      tracking.lastEditorScope = scope;
      return changed;
    },
    // Mount and explicit Retry admit once. Project/access changes and lost
    // acknowledgements only observe; they cannot reuse demand after Stop.
    consumeEditorAdmission(retry) {
      const shouldAdmit = tracking.admittedEditorRetry !== retry;
      tracking.admittedEditorRetry = retry;
      return shouldAdmit;
    },
    syncSourceScope(workspaceID, allowed) {
      const scope = `${workspaceID ?? ""}:${allowed}`;
      const changed = scope !== tracking.lastSourceScope;
      tracking.lastSourceScope = scope;
      return changed;
    },
    markNavigationSent(id) {
      if (tracking.sentNavigation === id) return false;
      tracking.sentNavigation = id;
      return true;
    },
    resetNavigation() {
      tracking.sentNavigation = undefined;
    },
  };
}

export function postWorkspaceSelection(
  frame: HTMLIFrameElement | undefined,
  origin: string | undefined,
  active: boolean,
  allowed: boolean,
  ready: boolean,
  workspaceID: string | undefined,
  availableSource: string | undefined,
  selectedWorkspaceID?: string | undefined,
) {
  if (
    active &&
    allowed &&
    ready &&
    workspaceID &&
    availableSource === workspaceID &&
    selectedWorkspaceID !== workspaceID &&
    origin
  )
    frame?.contentWindow?.postMessage({ type: "factory:select-workspace", workspaceID }, origin);
}

export function postActivityNavigation<Target extends { id: string; workspaceID: string }>(
  frame: HTMLIFrameElement | undefined,
  origin: string | undefined,
  active: boolean,
  allowed: boolean,
  ready: boolean,
  workspaceID: string | undefined,
  selectedWorkspaceID: string | undefined,
  target: Target | undefined,
  session: DeveloperIDESession,
) {
  if (
    target &&
    allowed &&
    active &&
    ready &&
    target.workspaceID === workspaceID &&
    selectedWorkspaceID === workspaceID &&
    origin &&
    frame?.contentWindow &&
    session.markNavigationSent(target.id)
  )
    frame.contentWindow.postMessage({ ...target, type: "factory:open-activity" }, origin);
}

export function scheduleFrameReload(options: {
  session: DeveloperIDESession;
  timers: WaitTimers;
  onReconnecting: (value: boolean) => void;
  reloadFrame: () => void;
}) {
  const { session, timers, onReconnecting, reloadFrame } = options;
  session.abort("frameReload");
  const cancel = session.start("frameReload");
  onReconnecting(true);
  void timers
    .outagePause(cancel.signal)
    .then(() => {
      session.clearIfCurrent("frameReload", cancel);
      onReconnecting(false);
      reloadFrame();
    })
    .catch(() => {
      session.clearIfCurrent("frameReload", cancel);
    });
}

export function bindEditorWindowMessages<Preview extends { workspaceID: string }>(options: {
  props: {
    readonly workspaceID: string | undefined;
    readonly navigation?: { id: string; workspaceID: string } | undefined;
    readonly onDevelopmentPreview: (preview: Preview) => void;
    readonly onNavigationOutcome?: ((id: string, error?: string) => void) | undefined;
  };
  frame: () => HTMLIFrameElement | undefined;
  origin: () => string | undefined;
  selectedWorkspaceID: () => string | undefined;
  session: DeveloperIDESession;
  parsePreview: (raw: unknown) => Preview | null | undefined;
  onReady: () => void;
  onWorkspaceSelected: (workspaceID: string | undefined) => void;
}) {
  const receive = (event: MessageEvent<unknown>) => {
    if (event.source !== options.frame()?.contentWindow || event.origin !== options.origin())
      return;
    handleEditorFrameMessage(event.data, {
      workspaceID: options.props.workspaceID,
      selectedWorkspaceID: options.selectedWorkspaceID(),
      navigation: options.props.navigation,
      session: options.session,
      parsePreview: options.parsePreview,
      onPreview: (preview) => options.props.onDevelopmentPreview(preview),
      onNavigationOutcome: (id, error) => options.props.onNavigationOutcome?.(id, error),
      onReady: options.onReady,
      onWorkspaceSelected: options.onWorkspaceSelected,
    });
  };
  window.addEventListener("message", receive);
  return () => window.removeEventListener("message", receive);
}

export function handleEditorFrameMessage<Preview extends { workspaceID: string }>(
  message: unknown,
  options: {
    workspaceID: string | undefined;
    selectedWorkspaceID: string | undefined;
    navigation: { id: string; workspaceID: string } | undefined;
    session: DeveloperIDESession;
    parsePreview: (raw: unknown) => Preview | null | undefined;
    onPreview: (preview: Preview) => void;
    onNavigationOutcome: ((id: string, error?: string) => void) | undefined;
    onReady: () => void;
    onWorkspaceSelected: (workspaceID: string | undefined) => void;
  },
) {
  if (!message || typeof message !== "object" || !("type" in message)) return;
  const preview = options.parsePreview(message);
  if (
    preview &&
    preview.workspaceID === options.workspaceID &&
    preview.workspaceID === options.selectedWorkspaceID
  ) {
    options.onPreview(preview);
    return;
  }
  if (message.type === "factory:ide-ready") {
    options.session.resetNavigation();
    options.session.abort("frameReload");
    options.onReady();
  } else if (
    message.type === "factory:workspace-selected" &&
    "workspaceID" in message &&
    message.workspaceID === options.workspaceID
  ) {
    options.onWorkspaceSelected(options.workspaceID);
  } else if (
    message.type === "factory:activity-opened" &&
    "id" in message &&
    "workspaceID" in message &&
    options.navigation &&
    message.id === options.navigation.id &&
    message.workspaceID === options.navigation.workspaceID
  ) {
    options.onNavigationOutcome?.(
      options.navigation.id,
      "error" in message && typeof message.error === "string"
        ? message.error.slice(0, 500)
        : undefined,
    );
  }
}
