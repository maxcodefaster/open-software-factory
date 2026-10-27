import { createSignal, onCleanup, untrack } from "solid-js";

// Interaction stops immediately; the mounted content survives its short exit animation.
export function createWindowPresence() {
  const [visible, updateVisible] = createSignal(false);
  const [present, updatePresent] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  function finishExit() {
    if (visible()) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    updatePresent(false);
  }
  function setVisible(value: boolean | ((previous: boolean) => boolean)) {
    const next = typeof value === "function" ? value(untrack(visible)) : value;
    if (timer) clearTimeout(timer);
    timer = undefined;
    updateVisible(next);
    if (next) {
      updatePresent(true);
    } else if (untrack(present)) {
      const duration = Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--duration-fast"),
      );
      timer = setTimeout(finishExit, (Number.isFinite(duration) ? duration : 140) + 50);
    }
    return next;
  }
  onCleanup(() => {
    if (timer) clearTimeout(timer);
  });
  return { visible, present, setVisible, finishExit, closing: () => present() && !visible() };
}
