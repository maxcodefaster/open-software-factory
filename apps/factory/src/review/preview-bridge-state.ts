export type BridgePin = {
  id: string;
  selector: string;
  label: string;
  element: string;
};

export type BridgeTheme = {
  accent: string;
  foreground: string;
  fontFamily: string;
  fontSize: string;
};

export type BridgePhase =
  | { kind: "disconnected" }
  | { kind: "attached"; token: string }
  | { kind: "waiting"; token: string; selected: Element | null }
  | { kind: "selected"; token: string; selectionId: string; selected: Element | null }
  | { kind: "failed"; token: string; reason: string }
  | { kind: "disposed" };

export type BridgeSession = ReturnType<typeof createBridgeSession>;

// Self-contained factory serialized into the isolated App origin bridge script.
// Must not reference any outer module bindings.
export function createBridgeSession(initialPage: string) {
  const state = {
    phase: { kind: "disconnected" } as BridgePhase,
    documentId: crypto.randomUUID(),
    page: initialPage,
    pins: [] as BridgePin[],
    theme: {
      accent: "Highlight",
      foreground: "HighlightText",
      fontFamily: "system-ui",
      fontSize: "13px",
    } as BridgeTheme,
    lastActivityAt: -Infinity,
    frameScheduled: false,
    renderer: undefined as Promise<void> | undefined,
  };

  const currentToken = () =>
    state.phase.kind === "disconnected" || state.phase.kind === "disposed" ? "" : state.phase.token;

  return {
    phase: () => state.phase,
    documentId: () => state.documentId,
    page: () => state.page,
    pins: () => state.pins,
    theme: () => state.theme,
    token: currentToken,
    isActive: () => state.phase.kind === "waiting" || state.phase.kind === "selected",
    isWaiting: () => state.phase.kind === "waiting",
    selectedElement: () =>
      state.phase.kind === "waiting" || state.phase.kind === "selected"
        ? state.phase.selected
        : null,
    matchesParent(token: unknown, documentId: unknown) {
      const active = currentToken();
      return Boolean(active && token === active && documentId === state.documentId);
    },
    isSelectionCurrent(selectionId: string, requestToken: string, expectedPage?: string) {
      return (
        state.phase.kind === "selected" &&
        state.phase.selectionId === selectionId &&
        state.phase.token === requestToken &&
        (expectedPage === undefined || location.pathname === expectedPage)
      );
    },
    enterSelect(token: string, mode: unknown, initialTarget: Element | null) {
      if (state.phase.kind === "disposed") return state.phase;
      state.phase =
        mode === "element"
          ? { kind: "waiting", token, selected: initialTarget }
          : { kind: "attached", token };
      return state.phase;
    },
    hover(node: Element | null) {
      if (state.phase.kind === "waiting") state.phase = { ...state.phase, selected: node };
    },
    focusElement(node: Element) {
      if (state.phase.kind === "waiting" || state.phase.kind === "selected")
        state.phase = { ...state.phase, selected: node };
    },
    choose(node: Element, selectionId: string) {
      const token = currentToken();
      if (!token) return state.phase;
      state.phase = { kind: "selected", token, selectionId, selected: node };
      return state.phase;
    },
    cancel() {
      const token = currentToken();
      state.phase = token ? { kind: "attached", token } : { kind: "disconnected" };
      return state.phase;
    },
    fail(reason: string) {
      const token = currentToken();
      state.phase = token ? { kind: "failed", token, reason } : { kind: "disconnected" };
      return state.phase;
    },
    dispose() {
      state.phase = { kind: "disposed" };
      state.pins = [];
      return state.phase;
    },
    applyTheme(raw: unknown) {
      if (!raw || typeof raw !== "object") return false;
      const theme = raw as Record<string, unknown>;
      const validColor = (value: unknown): value is string =>
        typeof value === "string" && value.length <= 80 && CSS.supports("color", value);
      if (validColor(theme["accent"])) state.theme.accent = theme["accent"];
      if (validColor(theme["foreground"])) state.theme.foreground = theme["foreground"];
      if (
        typeof theme["fontFamily"] === "string" &&
        theme["fontFamily"].length <= 256 &&
        CSS.supports("font-family", theme["fontFamily"])
      )
        state.theme.fontFamily = theme["fontFamily"];
      if (typeof theme["fontSize"] === "string" && /^(?:1[0-9]|20)px$/.test(theme["fontSize"]))
        state.theme.fontSize = theme["fontSize"];
      return true;
    },
    setPins(raw: unknown[]) {
      state.pins = raw
        .slice(0, 100)
        .filter((pin: unknown): pin is BridgePin =>
          Boolean(
            pin &&
              typeof pin === "object" &&
              "id" in pin &&
              typeof pin.id === "string" &&
              "selector" in pin &&
              typeof pin.selector === "string" &&
              pin.selector.length <= 1_000 &&
              "label" in pin &&
              typeof pin.label === "string" &&
              pin.label.length <= 12 &&
              "element" in pin &&
              typeof pin.element === "string" &&
              pin.element.length <= 1_000,
          ),
        );
    },
    invalidate(nextPage: string) {
      state.documentId = crypto.randomUUID();
      state.page = nextPage;
      state.pins = [];
      if (state.phase.kind === "selected") state.phase = { ...state.phase, selectionId: "" };
      return Boolean(currentToken());
    },
    claimActivity(now: number) {
      if (now - state.lastActivityAt < 15_000) return false;
      state.lastActivityAt = now;
      return true;
    },
    scheduleFrame(run: () => void) {
      if (state.frameScheduled || !this.isActive()) return;
      state.frameScheduled = true;
      requestAnimationFrame(() => {
        state.frameScheduled = false;
        run();
      });
    },
    loadRenderer(loader: () => Promise<void>) {
      state.renderer ??= loader();
      return state.renderer;
    },
  };
}
