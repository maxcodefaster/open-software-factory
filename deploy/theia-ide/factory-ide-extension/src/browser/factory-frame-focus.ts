/** Restore focus inside this IDE document when Factory returns focus to its iframe. */
export function bindFactoryFrameFocus(view: Window) {
  const document = view.document;
  let lastFocused: HTMLElement | undefined;
  const remember = (event: FocusEvent) => {
    if (
      event.target instanceof HTMLElement &&
      event.target !== document.body &&
      event.target !== document.documentElement
    ) {
      lastFocused = event.target;
    }
  };
  const restore = () => {
    if (
      document.activeElement === document.body &&
      document.hasFocus() &&
      lastFocused?.isConnected &&
      lastFocused.getClientRects().length > 0 &&
      !lastFocused.closest("[inert]") &&
      !lastFocused.matches(":disabled")
    ) {
      lastFocused.focus({ preventScroll: true });
    }
  };
  document.addEventListener("focusin", remember);
  view.addEventListener("focus", restore);
  return () => {
    document.removeEventListener("focusin", remember);
    view.removeEventListener("focus", restore);
    lastFocused = undefined;
  };
}
