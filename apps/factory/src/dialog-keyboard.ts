export function bindDialogKeyboard(
  element: HTMLElement,
  close: () => void,
  opener?: HTMLElement,
  restoreFocus: () => boolean = () => true,
) {
  const previous =
    opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
  const controls = () =>
    [
      ...element.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]',
      ),
    ].filter((control) => control.getClientRects().length > 0);
  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const available = controls();
    const first = available[0];
    const last = available.at(-1);
    if (!element.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus({ preventScroll: true });
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus({ preventScroll: true });
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus({ preventScroll: true });
    }
  };
  document.addEventListener("keydown", keydown);
  queueMicrotask(() => {
    if (!element.isConnected || element.contains(document.activeElement)) return;
    const available = controls();
    (
      available.find((control) =>
        control.matches('textarea, input:not([type="file"]):not([type="hidden"])'),
      ) ?? available[0]
    )?.focus({ preventScroll: true });
  });
  return () => {
    document.removeEventListener("keydown", keydown);
    requestAnimationFrame(() => {
      if (restoreFocus() && previous?.isConnected) previous.focus({ preventScroll: true });
    });
  };
}
