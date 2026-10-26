// Runs on the isolated App origin, without Factory credentials or decision authority.
export function previewBridge(origin: string) {
  return `(${installPreviewBridge.toString()})(${JSON.stringify(origin)})`;
}

function installPreviewBridge(factoryOrigin: string) {
  let documentId = crypto.randomUUID();
  let currentPage = location.pathname;
  const scriptSource = (document.currentScript as HTMLScriptElement | null)?.src;
  let lastUse = -Infinity;
  const reportUse = () => {
    if (document.hidden || !scriptSource || Date.now() - lastUse < 15_000) return;
    const target = new URL(scriptSource);
    if (
      target.origin !== location.origin ||
      !target.pathname.endsWith("/__factory/review-bridge.js")
    )
      return;
    target.pathname = target.pathname.replace(/review-bridge\.js$/, "activity");
    target.search = "";
    lastUse = Date.now();
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
  let token = "";
  let mode = "";
  let selected: Element | null = null;
  let selectionId = "";
  let renderer: Promise<void> | undefined;
  let pins: Array<{ id: string; selector: string; label: string; element: string }> = [];
  let accent = "Highlight";
  let foreground = "HighlightText";
  let fontFamily = "system-ui";
  let fontSize = "13px";
  const decoration = document.createElement("div");
  decoration.dataset["factoryReview"] = "";
  decoration.tabIndex = -1;
  const outline = document.createElement("div");
  outline.setAttribute("aria-hidden", "true");
  Object.assign(outline.style, {
    position: "fixed",
    pointerEvents: "none",
    border: "2px solid Highlight",
    background: "transparent",
    zIndex: "2147483646",
    display: "none",
    boxSizing: "border-box",
    borderRadius: "4px",
  });
  const announcement = document.createElement("div");
  announcement.setAttribute("role", "status");
  announcement.setAttribute("aria-live", "polite");
  Object.assign(announcement.style, {
    position: "fixed",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    clipPath: "inset(50%)",
  });
  const pinLayer = document.createElement("div");
  decoration.append(outline, announcement, pinLayer);
  function send(data: Record<string, unknown>) {
    parent.postMessage({ ...data, token, documentId }, factoryOrigin);
  }
  function label(node: Element) {
    const referenced = (node.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .slice(0, 5)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    const field =
      node instanceof HTMLInputElement ||
      node instanceof HTMLSelectElement ||
      node instanceof HTMLTextAreaElement;
    const name = (
      node.getAttribute("aria-label") ||
      referenced.trim() ||
      (field ? [...(node.labels ?? [])].map((item) => item.textContent).join(" ") : "") ||
      node.getAttribute("alt") ||
      node.textContent ||
      ""
    )
      .trim()
      .replace(/\s+/g, " ");
    const role = field
      ? node instanceof HTMLInputElement && node.type === "checkbox"
        ? "checkbox"
        : "field"
      : node.matches("button,[role=button]")
        ? "button"
        : node.matches("a[href]")
          ? "link"
          : "";
    return (name ? `${name}${role ? ` ${role}` : ""}` : "Selected area").trim().slice(0, 1_000);
  }
  function selector(node: Element) {
    const path: string[] = [];
    for (
      let current: Element | null = node;
      current && path.length < 12;
      current = current.parentElement
    ) {
      if (current === document.documentElement) {
        path.unshift("html");
        break;
      }
      if (current.id && document.querySelectorAll(`#${CSS.escape(current.id)}`).length === 1) {
        path.unshift(`#${CSS.escape(current.id)}`);
        break;
      }
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter((item) => item.tagName === current!.tagName)
        : [];
      path.unshift(
        `${current.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(current) + 1})`,
      );
    }
    const value = path.join(" > ");
    return value.length <= 1_000 ? value : undefined;
  }
  function targets() {
    return [
      ...document.querySelectorAll(
        "h1,h2,h3,p,label,button,a,input,select,textarea,[role=button],[tabindex]",
      ),
    ]
      .filter(
        (node) =>
          !decoration.contains(node) &&
          node.getBoundingClientRect().width > 0 &&
          node.getBoundingClientRect().height > 0,
      )
      .slice(0, 2_000)
      .concat([...pinLayer.querySelectorAll("button")]);
  }
  function show(node: Element) {
    const rect = node.getBoundingClientRect();
    Object.assign(outline.style, {
      display: "block",
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }
  function drawPins() {
    pinLayer.replaceChildren();
    if (!mode) return;
    if (location.pathname !== currentPage) {
      invalidate();
      return;
    }
    for (const pin of pins) {
      let node: Element | null = null;
      try {
        node = document.querySelector(pin.selector);
      } catch {
        /* No arbitrary script evaluation. */
      }
      if (!node || decoration.contains(node) || label(node) !== pin.element) continue;
      const rect = node.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > innerHeight || !rect.width || !rect.height) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = pin.label;
      button.dataset["feedbackId"] = pin.id;
      button.setAttribute("aria-label", `Open feedback ${pin.label}`);
      Object.assign(button.style, {
        position: "fixed",
        left: `${Math.min(innerWidth - 32, Math.max(0, rect.right - 14))}px`,
        top: `${Math.max(0, rect.top - 14)}px`,
        width: "32px",
        height: "32px",
        border: `2px solid ${foreground}`,
        borderRadius: "50% 50% 50% 3px",
        background: accent,
        color: foreground,
        fontFamily,
        fontSize,
        zIndex: "2147483647",
        cursor: "pointer",
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        send({ type: "factory-review-open-feedback", feedbackId: pin.id });
      });
      pinLayer.append(button);
    }
  }
  function loadRenderer() {
    renderer ??= new Promise<void>((resolve, reject) => {
      if (!scriptSource) return reject(new Error("Context renderer is unavailable"));
      const script = document.createElement("script");
      script.dataset["factoryReview"] = "";
      script.src = new URL("./review-renderer.js", scriptSource).href;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("App policy did not allow a context image"));
      document.head.append(script);
    });
    return renderer;
  }
  async function contextImage(node: Element, id: string, page: string) {
    const requestToken = token;
    try {
      // Supplementary element context, never exact-candidate screenshot proof.
      const target = node.closest("label") ?? node;
      const rect = target.getBoundingClientRect();
      if (
        rect.width > 2560 ||
        rect.height > 1600 ||
        target.querySelectorAll("*").length > 2000 ||
        target.matches('input[type="password"],iframe,canvas,video')
      )
        throw new Error("Element exceeds the context image bound");
      await Promise.race([
        loadRenderer(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Context image timed out")), 3_000),
        ),
      ]);
      if (selectionId !== id || token !== requestToken || location.pathname !== page) return;
      const library = (
        globalThis as unknown as {
          modernScreenshot?: {
            createContext(
              node: Element,
              options: Record<string, unknown>,
            ): Promise<{ sandbox?: HTMLIFrameElement }>;
            domToJpeg(context: { sandbox?: HTMLIFrameElement }): Promise<string>;
            destroyContext(context: { sandbox?: HTMLIFrameElement }): void;
          };
        }
      ).modernScreenshot;
      if (!library) throw new Error("Context renderer unavailable");
      const context = await library.createContext(target, {
        type: "image/jpeg",
        quality: 0.86,
        scale: 1,
        timeout: 2_000,
        maximumCanvasSize: 2560,
        backgroundColor: getComputedStyle(document.body).backgroundColor,
        filter: (child: Node) =>
          !(child instanceof Element) ||
          (!decoration.contains(child) &&
            !child.matches('input[type="password"],script,iframe,video,canvas')),
        onCloneEachNode: (child: Node) => {
          if (child instanceof HTMLInputElement && child.type === "password") child.value = "";
        },
      });
      // The renderer uses a hidden document to compare default styles. Own that
      // node so its insertion/removal cannot masquerade as an App state change.
      const styles = document.createElement("iframe");
      styles.setAttribute("aria-hidden", "true");
      styles.tabIndex = -1;
      Object.assign(styles.style, {
        position: "fixed",
        width: "0",
        height: "0",
        visibility: "hidden",
      });
      decoration.append(styles);
      context.sandbox = styles;
      let image: string;
      try {
        image = await library.domToJpeg(context);
      } finally {
        library.destroyContext(context);
        styles.remove();
      }
      if (selectionId !== id || token !== requestToken || location.pathname !== page) return;
      if (!image.startsWith("data:image/jpeg;base64,") || image.length > 2_800_000)
        throw new Error("Context image exceeds its bound");
      send({ type: "factory-review-context-image", selectionId: id, image });
    } catch {
      if (selectionId === id && token === requestToken)
        send({ type: "factory-review-context-image", selectionId: id, image: null });
    }
  }
  function choose(node: Element) {
    const rect = node.getBoundingClientRect();
    const x = Math.max(0, Math.min(innerWidth - 1, rect.x));
    const y = Math.max(0, Math.min(innerHeight - 1, rect.y));
    selectionId = crypto.randomUUID();
    mode = "selected";
    show(node);
    announcement.textContent = "";
    const page = location.pathname;
    send({
      type: "factory-review-selection",
      selectionId,
      page,
      element: label(node),
      selector: selector(node),
      region: {
        x: x / innerWidth,
        y: y / innerHeight,
        width: Math.max(1, Math.min(rect.width, innerWidth - x)) / innerWidth,
        height: Math.max(1, Math.min(rect.height, innerHeight - y)) / innerHeight,
      },
    });
    void contextImage(node, selectionId, page);
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
      if (event.data.token !== token || event.data.documentId !== documentId) return;
      const button = [...pinLayer.querySelectorAll("button")].find(
        (node) => node.dataset["feedbackId"] === event.data.feedbackId,
      );
      if (button) {
        selected = button;
        button.focus({ preventScroll: true });
      }
      return;
    }
    if (event.data.type === "factory-review-pins") {
      if (
        event.data.token !== token ||
        event.data.documentId !== documentId ||
        !Array.isArray(event.data.pins)
      )
        return;
      pins = event.data.pins
        .slice(0, 100)
        .filter((pin: unknown): pin is (typeof pins)[number] =>
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
              pin.element.length <= 1000,
          ),
        );
      drawPins();
      return;
    }
    if (event.data.type !== "factory-review-select") return;
    token = event.data.token;
    mode = event.data.mode === "element" ? "element" : "";
    const theme = event.data.theme;
    if (theme && typeof theme === "object") {
      const color = (value: unknown) =>
        typeof value === "string" && value.length <= 80 && CSS.supports("color", value);
      if (color(theme.accent)) accent = theme.accent;
      if (color(theme.foreground)) foreground = theme.foreground;
      if (
        typeof theme.fontFamily === "string" &&
        theme.fontFamily.length <= 256 &&
        CSS.supports("font-family", theme.fontFamily)
      )
        fontFamily = theme.fontFamily;
      if (typeof theme.fontSize === "string" && /^(?:1[0-9]|20)px$/.test(theme.fontSize))
        fontSize = theme.fontSize;
      outline.style.borderColor = accent;
      outline.style.backgroundColor = `color-mix(in srgb, ${accent} 8%, transparent)`;
    }
    selectionId = "";
    outline.style.display = "none";
    if (!decoration.isConnected) document.documentElement.append(decoration);
    if (mode) {
      selected = targets()[0] ?? document.body;
      show(selected);
      decoration.focus({ preventScroll: true });
      announcement.textContent = "Comment mode. Tab changes element, Enter selects, Escape exits.";
    } else announcement.textContent = "";
    drawPins();
    send({ type: "factory-review-ready", page: location.pathname });
  });
  window.addEventListener(
    "pointermove",
    (event) => {
      if (
        mode === "element" &&
        event.target instanceof Element &&
        !decoration.contains(event.target)
      ) {
        selected = event.target;
        show(selected);
      }
    },
    true,
  );
  for (const name of ["pointerdown", "pointerup", "click"] as const) {
    window.addEventListener(
      name,
      (event) => {
        if (!mode || decoration.contains(event.target as Node)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (name === "click" && mode === "element" && event.target instanceof Element) {
          selected = event.target;
          choose(selected);
        }
      },
      true,
    );
  }
  window.addEventListener(
    "keydown",
    (event) => {
      if (!mode) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        mode = "";
        selectionId = "";
        outline.style.display = "none";
        drawPins();
        send({ type: "factory-review-cancel" });
      } else if (mode === "element" && event.key === "Tab") {
        const nodes = targets();
        const index = selected ? nodes.indexOf(selected) : -1;
        selected = nodes[(index + (event.shiftKey ? -1 : 1) + nodes.length) % nodes.length] ?? null;
        if (selected) {
          selected.scrollIntoView({ block: "nearest", inline: "nearest" });
          show(selected);
          announcement.textContent = label(selected);
        }
      } else if (mode === "element" && selected && (event.key === "Enter" || event.key === " ")) {
        if (selected instanceof HTMLButtonElement && pinLayer.contains(selected)) selected.click();
        else choose(selected);
      }
    },
    true,
  );
  let scheduled = false;
  const position = () => {
    if (scheduled || !mode) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (selected && mode) show(selected);
      drawPins();
    });
  };
  window.addEventListener("scroll", position, true);
  window.addEventListener("resize", position);
  function invalidate() {
    documentId = crypto.randomUUID();
    currentPage = location.pathname;
    pins = [];
    selectionId = "";
    outline.style.display = "none";
    pinLayer.replaceChildren();
    if (token) send({ type: "factory-review-ready", page: currentPage });
  }
  window.addEventListener("input", invalidate, true);
  window.addEventListener("change", invalidate, true);
  window.addEventListener("popstate", invalidate);
  const navigation = (window as unknown as { navigation?: EventTarget }).navigation;
  navigation?.addEventListener("currententrychange", invalidate);
  const owned = (node: Node) =>
    decoration.contains(node) ||
    (node instanceof Element && Boolean(node.closest("[data-factory-review]")));
  new MutationObserver((records) => {
    if (
      records.some(
        (record) =>
          !owned(record.target) &&
          (record.type !== "childList" ||
            [...record.addedNodes, ...record.removedNodes].some((node) => !owned(node))),
      )
    )
      invalidate();
  }).observe(document.documentElement, {
    childList: true,
    characterData: true,
    attributes: true,
    subtree: true,
  });
  const documentReady = () => {
    if (parent !== window)
      parent.postMessage({ type: "factory-preview-document-ready" }, factoryOrigin);
  };
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", documentReady, { once: true });
  else documentReady();
}
