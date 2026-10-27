import { type Accessor, createEffect, createSignal } from "solid-js";
import { z } from "zod";

export function createConversationSelection(
  userID: string,
  projectID: Accessor<string | undefined>,
  ticketID: Accessor<string | undefined>,
) {
  const scope = () => `${projectID() ?? "none"}:${ticketID() ?? "none"}`;
  const [selections, setSelections] = createSignal<Record<string, string>>(
    (() => {
      try {
        return z
          .record(z.string(), z.string())
          .parse(JSON.parse(sessionStorage.getItem(`chat-contexts:${userID}`) ?? "{}"));
      } catch {
        return {};
      }
    })(),
  );
  const selected = () => selections()[scope()];
  const key = () => `assistant:${scope()}:${selected() ?? "original"}`;
  const [readyKey, setReadyKey] = createSignal<string>();
  const [paused, setPaused] = createSignal<Record<string, boolean>>({});
  createEffect(selections, (value) => {
    try {
      sessionStorage.setItem(`chat-contexts:${userID}`, JSON.stringify(value));
    } catch {
      /* Selection remains usable in this browser tab. */
    }
  });
  createEffect(key, (current) => {
    try {
      setPaused((all) => ({
        ...all,
        [current]: sessionStorage.getItem(`clarification-paused:${current}`) === "true",
      }));
    } catch {
      /* A missing browser store does not pause clarification. */
    }
  });
  return {
    scope,
    selected,
    key,
    readyKey,
    setReadyKey,
    setSelections,
    paused: () => paused()[key()] ?? false,
    pause(value: boolean) {
      const current = key();
      setPaused((all) => ({ ...all, [current]: value }));
      try {
        sessionStorage.setItem(`clarification-paused:${current}`, String(value));
      } catch {
        /* Visible state remains usable. */
      }
    },
  };
}
