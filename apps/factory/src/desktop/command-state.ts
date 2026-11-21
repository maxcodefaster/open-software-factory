import { createSignal } from "solid-js";
import { plainErrorMessage } from "../command-error";
import type { DesktopMutation } from "./contracts";

export function createDesktopCommandState(contextKey: () => string) {
  const [error, setError] = createSignal("");
  const [pendingContexts, setPendingContexts] = createSignal<Record<string, number>>({});
  const mutate: DesktopMutation = async (operation, contextIsCurrent, key = contextKey()) => {
    const isCurrent = contextIsCurrent ?? (() => contextKey() === key);
    setPendingContexts((contexts) => ({ ...contexts, [key]: (contexts[key] ?? 0) + 1 }));
    setError("");
    try {
      return { ok: true, value: await operation() };
    } catch (cause) {
      if (isCurrent())
        setError(
          cause instanceof Error ? plainErrorMessage(cause.message) : "Factory command failed",
        );
      return { ok: false };
    } finally {
      setPendingContexts((contexts) => {
        const next = { ...contexts };
        const remaining = (contexts[key] ?? 1) - 1;
        if (remaining > 0) next[key] = remaining;
        else delete next[key];
        return next;
      });
    }
  };
  return { error, setError, pendingContexts, mutate };
}
