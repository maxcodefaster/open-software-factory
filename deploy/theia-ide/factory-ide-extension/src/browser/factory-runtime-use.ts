export function observeFactoryRuntimeUse(target: Document, use: () => void | Promise<void>) {
  const listener = (event: Event) => {
    if (event.isTrusted && !target.hidden) void use();
  };
  // Lumino tabs stop propagation at their widget. Observe genuine use before
  // those handlers, without cancelling the widget's normal interaction.
  const options = { passive: true, capture: true };
  const events = ["pointerdown", "wheel", "keydown"] as const;
  for (const event of events) target.addEventListener(event, listener, options);
  return {
    dispose() {
      for (const event of events) target.removeEventListener(event, listener, options);
    },
  };
}
