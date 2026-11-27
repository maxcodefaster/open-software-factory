import { type BridgeDom, createBridgeDom } from "./preview-bridge-dom";
import { type BridgeSession, createBridgeSession } from "./preview-bridge-state";

// Runs on the isolated App origin, without Factory credentials or decision authority.
export function previewBridge(origin: string) {
  return `(${installPreviewBridge.toString()})(${JSON.stringify(origin)}, ${createBridgeSession.toString()}, ${createBridgeDom.toString()})`;
}

function installPreviewBridge(
  factoryOrigin: string,
  createSession: (initialPage: string) => BridgeSession,
  createDom: (scriptSource: string | undefined) => BridgeDom,
) {
  const scriptSource = (document.currentScript as HTMLScriptElement | null)?.src;
  const session = createSession(location.pathname);
  const dom = createDom(scriptSource);

  const reportUse = () => {
    if (document.hidden || !scriptSource || !session.claimActivity(Date.now())) return;
    const target = new URL(scriptSource);
    if (
      target.origin !== location.origin ||
      !target.pathname.endsWith("/__factory/review-bridge.js")
    )
      return;
    target.pathname = target.pathname.replace(/review-bridge\.js$/, "activity");
    target.search = "";
    void fetch(target, {
      method: "POST",
      credentials: "same-origin",
      signal: AbortSignal.timeout(420_000),
    }).catch(() => {});
  };
  const activity = (event: Event) => {
    if (event.isTrusted) reportUse();
  };
  document.addEventListener("pointerdown", activity, { passive: true });
  document.addEventListener("wheel", activity, { passive: true });
  document.addEventListener("keydown", activity);

  const send = (data: Record<string, unknown>) => {
    parent.postMessage(
      { ...data, token: session.token(), documentId: session.documentId() },
      factoryOrigin,
    );
  };

  function invalidate() {
    dom.hideOutline();
    dom.clearPins();
    if (session.invalidate(location.pathname))
      send({ type: "factory-review-ready", page: session.page() });
  }

  function drawPins() {
    if (!session.isActive()) {
      dom.clearPins();
      return;
    }
    if (location.pathname !== session.page()) {
      invalidate();
      return;
    }
    dom.drawPins(session.pins(), session.theme(), (feedbackId) =>
      send({ type: "factory-review-open-feedback", feedbackId }),
    );
  }

  async function captureContextImage(node: Element, id: string, page: string) {
    const requestToken = session.token();
    try {
      const image = await dom.renderContextImage(
        node,
        () => session.loadRenderer(dom.loadRendererScript),
        () => session.isSelectionCurrent(id, requestToken, page),
      );
      if (image !== undefined)
        send({ type: "factory-review-context-image", selectionId: id, image });
    } catch {
      if (session.isSelectionCurrent(id, requestToken))
        send({ type: "factory-review-context-image", selectionId: id, image: null });
    }
  }

  function choose(node: Element) {
    const rect = node.getBoundingClientRect();
    const x = Math.max(0, Math.min(innerWidth - 1, rect.x));
    const y = Math.max(0, Math.min(innerHeight - 1, rect.y));
    const selectionId = crypto.randomUUID();
    session.choose(node, selectionId);
    dom.showOutline(node);
    dom.announce("");
    const page = location.pathname;
    send({
      type: "factory-review-selection",
      selectionId,
      page,
      element: dom.label(node),
      selector: dom.selector(node),
      region: {
        x: x / innerWidth,
        y: y / innerHeight,
        width: Math.max(1, Math.min(rect.width, innerWidth - x)) / innerWidth,
        height: Math.max(1, Math.min(rect.height, innerHeight - y)) / innerHeight,
      },
    });
    void captureContextImage(node, selectionId, page);
  }

  window.addEventListener("message", (event) => {
    if (
      event.isTrusted &&
      event.source === parent &&
      event.origin === factoryOrigin &&
      event.data?.type === "factory-runtime-use"
    ) {
      reportUse();
      return;
    }
    if (
      event.source !== parent ||
      event.origin !== factoryOrigin ||
      typeof event.data?.token !== "string"
    )
      return;
    if (event.data.type === "factory-review-focus-feedback") {
      if (!session.matchesParent(event.data.token, event.data.documentId)) return;
      const button = dom.findPinButton(event.data.feedbackId);
      if (button) {
        session.focusElement(button);
        button.focus({ preventScroll: true });
      }
      return;
    }
    if (event.data.type === "factory-review-pins") {
      if (
        !session.matchesParent(event.data.token, event.data.documentId) ||
        !Array.isArray(event.data.pins)
      )
        return;
      session.setPins(event.data.pins);
      drawPins();
      return;
    }
    if (event.data.type !== "factory-review-select") return;
    if (session.applyTheme(event.data.theme)) dom.applyTheme(session.theme());
    dom.hideOutline();
    dom.ensureAttached();
    const initial = event.data.mode === "element" ? (dom.targets()[0] ?? document.body) : null;
    const phase = session.enterSelect(event.data.token, event.data.mode, initial);
    if (phase.kind === "waiting" && phase.selected) {
      dom.showOutline(phase.selected);
      dom.focusDecoration();
      dom.announce("Comment mode. Tab changes element, Enter selects, Escape exits.");
    } else {
      dom.announce("");
    }
    drawPins();
    send({ type: "factory-review-ready", page: location.pathname });
  });

  window.addEventListener(
    "pointermove",
    (event) => {
      if (session.isWaiting() && event.target instanceof Element && !dom.contains(event.target)) {
        session.hover(event.target);
        dom.showOutline(event.target);
      }
    },
    true,
  );

  for (const name of ["pointerdown", "pointerup", "click"] as const) {
    window.addEventListener(
      name,
      (event) => {
        if (!session.isActive() || dom.contains(event.target as Node)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (name === "click" && session.isWaiting() && event.target instanceof Element) {
          session.hover(event.target);
          choose(event.target);
        }
      },
      true,
    );
  }

  window.addEventListener(
    "keydown",
    (event) => {
      if (!session.isActive()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        session.cancel();
        dom.hideOutline();
        drawPins();
        send({ type: "factory-review-cancel" });
      } else if (session.isWaiting() && event.key === "Tab") {
        const nodes = dom.targets();
        const current = session.selectedElement();
        const index = current ? nodes.indexOf(current) : -1;
        const next =
          nodes[(index + (event.shiftKey ? -1 : 1) + nodes.length) % nodes.length] ?? null;
        session.hover(next);
        if (next) {
          next.scrollIntoView({ block: "nearest", inline: "nearest" });
          dom.showOutline(next);
          dom.announce(dom.label(next));
        }
      } else if (session.isWaiting() && (event.key === "Enter" || event.key === " ")) {
        const current = session.selectedElement();
        if (!current) return;
        if (dom.isPinButton(current)) current.click();
        else choose(current);
      }
    },
    true,
  );

  const reposition = () =>
    session.scheduleFrame(() => {
      const current = session.selectedElement();
      if (current && session.isActive()) dom.showOutline(current);
      drawPins();
    });
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);
  window.addEventListener("input", invalidate, true);
  window.addEventListener("change", invalidate, true);
  window.addEventListener("popstate", invalidate);
  const navigation = (window as unknown as { navigation?: EventTarget }).navigation;
  navigation?.addEventListener("currententrychange", invalidate);

  new MutationObserver((records) => {
    if (
      records.some(
        (record) =>
          !dom.isOwned(record.target) &&
          (record.type !== "childList" ||
            [...record.addedNodes, ...record.removedNodes].some((node) => !dom.isOwned(node))),
      )
    )
      invalidate();
  }).observe(document.documentElement, {
    childList: true,
    characterData: true,
    attributes: true,
    subtree: true,
  });

  // Factory appends this script after the complete HTML document. Show that
  // delivered content without waiting for deferred App modules to finish.
  // This acknowledges document delivery, not App health or hydration.
  // The status is the App's own HTTP answer for this document, so Factory can
  // tell an App error page from a connection it failed to make.
  const documentTiming = performance.getEntriesByType("navigation")[0] as
    | { responseStatus?: number }
    | undefined;
  if (parent !== window)
    parent.postMessage(
      { type: "factory-preview-document-ready", status: documentTiming?.responseStatus },
      factoryOrigin,
    );
}
