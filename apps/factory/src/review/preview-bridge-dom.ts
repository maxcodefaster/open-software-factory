import type { BridgePin, BridgeTheme } from "./preview-bridge-state";

export type BridgeDom = ReturnType<typeof createBridgeDom>;

// Self-contained DOM overlay helper serialized into the isolated App origin bridge script.
// Must not reference any outer module bindings.
export function createBridgeDom(scriptSource: string | undefined) {
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
        ? [...current.parentElement.children].filter((item) => item.tagName === current.tagName)
        : [];
      path.unshift(
        `${current.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(current) + 1})`,
      );
    }
    const value = path.join(" > ");
    return value.length <= 1_000 ? value : undefined;
  }

  function loadRendererScript() {
    return new Promise<void>((resolve, reject) => {
      if (!scriptSource) return reject(new Error("Context renderer is unavailable"));
      const script = document.createElement("script");
      script.dataset["factoryReview"] = "";
      script.src = new URL("./review-renderer.js", scriptSource).href;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("App policy did not allow a context image"));
      document.head.append(script);
    });
  }

  return {
    label,
    selector,
    loadRendererScript,
    contains: (node: Node) => decoration.contains(node),
    isPinButton: (node: Element): node is HTMLButtonElement =>
      node instanceof HTMLButtonElement && pinLayer.contains(node),
    isOwned: (node: Node) =>
      decoration.contains(node) ||
      (node instanceof Element && Boolean(node.closest("[data-factory-review]"))),
    ensureAttached() {
      if (!decoration.isConnected) document.documentElement.append(decoration);
    },
    focusDecoration() {
      decoration.focus({ preventScroll: true });
    },
    announce(text: string) {
      announcement.textContent = text;
    },
    applyTheme(theme: BridgeTheme) {
      outline.style.borderColor = theme.accent;
      outline.style.backgroundColor = `color-mix(in srgb, ${theme.accent} 8%, transparent)`;
    },
    showOutline(node: Element) {
      const rect = node.getBoundingClientRect();
      Object.assign(outline.style, {
        display: "block",
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
    },
    hideOutline() {
      outline.style.display = "none";
    },
    clearPins() {
      pinLayer.replaceChildren();
    },
    findPinButton(feedbackId: unknown) {
      return [...pinLayer.querySelectorAll("button")].find(
        (node) => node.dataset["feedbackId"] === feedbackId,
      );
    },
    targets() {
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
    },
    drawPins(pins: readonly BridgePin[], theme: BridgeTheme, onOpen: (id: string) => void) {
      pinLayer.replaceChildren();
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
          border: `2px solid ${theme.foreground}`,
          borderRadius: "50% 50% 50% 3px",
          background: theme.accent,
          color: theme.foreground,
          fontFamily: theme.fontFamily,
          fontSize: theme.fontSize,
          zIndex: "2147483647",
          cursor: "pointer",
        });
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpen(pin.id);
        });
        pinLayer.append(button);
      }
    },
    async renderContextImage(
      node: Element,
      ensureRenderer: () => Promise<void>,
      stillCurrent: () => boolean,
    ): Promise<string | undefined> {
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
        ensureRenderer(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Context image timed out")), 3_000),
        ),
      ]);
      if (!stillCurrent()) return undefined;
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
      try {
        const image = await library.domToJpeg(context);
        if (!stillCurrent()) return undefined;
        if (!image.startsWith("data:image/jpeg;base64,") || image.length > 2_800_000)
          throw new Error("Context image exceeds its bound");
        return image;
      } finally {
        library.destroyContext(context);
        styles.remove();
      }
    },
  };
}
