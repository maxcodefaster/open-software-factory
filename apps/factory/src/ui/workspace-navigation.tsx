import { createEffect, createSignal } from "solid-js";
import { Icon } from "../icon";
import { bindPopoverKeyboard } from "../popover-keyboard";
import "./workspace-navigation.css";

/** The same sidebar stays mounted when it becomes a compact navigation popover. */
export function createWorkspaceNavigation(options: {
  root(): HTMLElement | undefined;
  panel(): HTMLElement | undefined;
  breakpoint: number;
  active?: (() => boolean) | undefined;
}) {
  const id = `workspace-navigation-${crypto.randomUUID()}`;
  const [compact, setCompact] = createSignal(false);
  const [open, setOpen] = createSignal(false);
  let opener: HTMLButtonElement | undefined;
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus)
      requestAnimationFrame(() => {
        const visible = (element: HTMLElement | undefined | null) =>
          element && element.getClientRects().length > 0;
        const target = visible(opener)
          ? opener
          : Array.from(
              options.root()?.querySelectorAll<HTMLButtonElement>(`[aria-controls="${id}"]`) ?? [],
            ).find(visible);
        target?.focus({ preventScroll: true });
      });
  };
  createEffect(
    () => undefined,
    () => {
      const query = matchMedia(`(max-width: ${options.breakpoint}px)`);
      let revealFrame = 0;
      const measure = () => {
        const narrow = query.matches;
        setCompact(narrow);
        if (!narrow) {
          close();
          cancelAnimationFrame(revealFrame);
          revealFrame = requestAnimationFrame(() => {
            options
              .panel()
              ?.querySelector<HTMLElement>('[aria-current="page"]')
              ?.scrollIntoView({ block: "nearest" });
          });
        }
      };
      query.addEventListener("change", measure);
      measure();
      return () => {
        cancelAnimationFrame(revealFrame);
        query.removeEventListener("change", measure);
      };
    },
  );
  createEffect(
    () => ({
      shown: compact() && open(),
      active: options.active?.() ?? true,
    }),
    ({ shown, active }) => {
      if (!active) {
        close();
        return;
      }
      if (!shown) return;
      const panel = options.panel();
      const root = options.root();
      if (!panel || !root || !opener) return;
      const position = () => {
        if (!opener) return;
        const bounds = root.getBoundingClientRect();
        const anchor = opener.getBoundingClientRect();
        const top = anchor.bottom - bounds.top + 4;
        panel.style.setProperty("--navigation-menu-top", `${top}px`);
        panel.style.setProperty(
          "--navigation-menu-left",
          `${Math.max(8, Math.min(anchor.left - bounds.left, bounds.width - panel.offsetWidth - 8))}px`,
        );
        panel.style.setProperty(
          "--navigation-menu-height",
          `${Math.max(44, Math.min(bounds.bottom, innerHeight) - bounds.top - top - 8)}px`,
        );
      };
      position();
      const outside = (event: PointerEvent) => {
        const target = event.target as Node;
        if (!panel.contains(target) && !opener?.contains(target)) close();
      };
      const revealFocus = () => {
        if (panel.contains(document.activeElement))
          document.activeElement?.scrollIntoView({ block: "nearest" });
      };
      document.addEventListener("pointerdown", outside);
      panel.addEventListener("focusin", revealFocus);
      window.addEventListener("resize", position);
      window.addEventListener("scroll", position, true);
      const dispose = bindPopoverKeyboard(panel, opener, () => close());
      let disposed = false;
      queueMicrotask(() => {
        if (!disposed) revealFocus();
      });
      return () => {
        disposed = true;
        document.removeEventListener("pointerdown", outside);
        panel.removeEventListener("focusin", revealFocus);
        window.removeEventListener("resize", position);
        window.removeEventListener("scroll", position, true);
        dispose();
      };
    },
  );
  return {
    id,
    open,
    close,
    toggle(element: HTMLButtonElement) {
      opener = element;
      setOpen((value) => !value);
    },
  };
}

export function WorkspaceNavigationToggle(props: {
  navigation: ReturnType<typeof createWorkspaceNavigation>;
  label: string;
  title: string;
}) {
  return (
    <button
      type="button"
      class="workspace-navigation-trigger"
      aria-label={props.label}
      aria-controls={props.navigation.id}
      aria-expanded={props.navigation.open() ? "true" : "false"}
      onClick={(event) => props.navigation.toggle(event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" && !props.navigation.open()) {
          event.preventDefault();
          props.navigation.toggle(event.currentTarget);
        }
      }}
    >
      <span>{props.title}</span>
      <Icon name="chevron" />
    </button>
  );
}
