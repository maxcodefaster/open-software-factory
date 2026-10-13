/** Non-modal popovers dismiss when focus leaves; only Escape returns focus to the opener. */
export function bindPopoverKeyboard(
  element: HTMLElement,
  opener: HTMLElement | undefined,
  close: () => void,
) {
  let disposed = false;
  const buttons = () =>
    Array.from(element.querySelectorAll<HTMLElement>("button:not(:disabled), a[href]")).filter(
      (button) => button.getClientRects().length > 0,
    );
  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      opener?.focus({ preventScroll: true });
      return;
    }
    const available = buttons();
    const index = event.target instanceof HTMLElement ? available.indexOf(event.target) : -1;
    if (index < 0) {
      if (event.key === "ArrowDown" && event.target instanceof HTMLInputElement) {
        event.preventDefault();
        (
          element.querySelector<HTMLElement>(
            '[aria-current="true"], [data-popover-option]:not(:disabled)',
          ) ?? available[0]
        )?.focus();
      }
      return;
    }
    const next =
      event.key === "ArrowDown"
        ? available[(index + 1) % available.length]
        : event.key === "ArrowUp"
          ? available[(index - 1 + available.length) % available.length]
          : event.key === "Home"
            ? available[0]
            : event.key === "End"
              ? available.at(-1)
              : undefined;
    if (next) {
      event.preventDefault();
      next.focus({ preventScroll: true });
    }
  };
  const focusout = () => {
    // Native pointer focus dispatch can run microtasks between blur and the next focus.
    // Wait for that dispatch to finish before deciding whether focus left the popover.
    requestAnimationFrame(() => {
      if (
        !disposed &&
        !element.contains(document.activeElement) &&
        document.activeElement !== opener
      )
        close();
    });
  };
  element.addEventListener("keydown", keydown);
  element.addEventListener("focusout", focusout);
  queueMicrotask(() => {
    if (disposed || !element.isConnected) return;
    (
      element.querySelector<HTMLElement>("input:not(:disabled)") ??
      element.querySelector<HTMLElement>('[aria-current="true"], [aria-pressed="true"]') ??
      buttons()[0]
    )?.focus({ preventScroll: true });
  });
  return () => {
    disposed = true;
    element.removeEventListener("keydown", keydown);
    element.removeEventListener("focusout", focusout);
  };
}
