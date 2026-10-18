export function resizeComposer(element: HTMLTextAreaElement) {
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

export function composerKeyDown(event: KeyboardEvent) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  const element = event.currentTarget as HTMLTextAreaElement;
  const submitter = element.form?.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!element.disabled && element.value.trim() && submitter && !submitter.disabled)
    element.form?.requestSubmit(submitter);
}

export function followConversation(element: HTMLDivElement) {
  let following = true;
  let frame = 0;
  let touchY: number | undefined;
  const stopFollowing = () => {
    following = false;
  };
  const scroll = () => {
    // Collapsing an answered question can move the viewport before our next
    // frame. Only user input detaches following; layout scrolls do not.
    if (element.scrollHeight - element.scrollTop - element.clientHeight <= 24) following = true;
  };
  const wheel = (event: WheelEvent) => {
    if (event.deltaY < 0) stopFollowing();
  };
  const key = (event: KeyboardEvent) => {
    if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey))
      stopFollowing();
  };
  const pointer = (event: PointerEvent) => {
    if (event.target === element) stopFollowing();
  };
  const touchStart = (event: TouchEvent) => {
    touchY = event.touches[0]?.clientY;
  };
  const touchMove = (event: TouchEvent) => {
    const next = event.touches[0]?.clientY;
    if (next !== undefined && touchY !== undefined && next > touchY) stopFollowing();
    touchY = next;
  };
  const update = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (following) element.scrollTop = element.scrollHeight;
    });
  };
  const mutations = new MutationObserver(update);
  mutations.observe(element, { childList: true, subtree: true, characterData: true });
  const resize = new ResizeObserver(update);
  resize.observe(element);
  element.addEventListener("scroll", scroll, { passive: true });
  element.addEventListener("wheel", wheel, { passive: true });
  element.addEventListener("keydown", key);
  element.addEventListener("pointerdown", pointer);
  element.addEventListener("touchstart", touchStart, { passive: true });
  element.addEventListener("touchmove", touchMove, { passive: true });
  update();
  return {
    reset() {
      following = true;
      update();
    },
    dispose() {
      cancelAnimationFrame(frame);
      mutations.disconnect();
      resize.disconnect();
      element.removeEventListener("scroll", scroll);
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("keydown", key);
      element.removeEventListener("pointerdown", pointer);
      element.removeEventListener("touchstart", touchStart);
      element.removeEventListener("touchmove", touchMove);
    },
  };
}
