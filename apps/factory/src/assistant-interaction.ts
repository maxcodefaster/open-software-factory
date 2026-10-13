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
  const scroll = () => {
    following = element.scrollHeight - element.scrollTop - element.clientHeight <= 24;
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
    },
  };
}
