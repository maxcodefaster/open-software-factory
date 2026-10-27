import { type Accessor, createSignal, onCleanup } from "solid-js";
import type { ConversationView } from "../api-contracts";
import type { createConversationSelection } from "../project-agent/selection";

type Selection = Pick<
  ReturnType<typeof createConversationSelection>,
  "selected" | "scope" | "key" | "setSelections" | "setReadyKey"
>;

export function createConversationState(input: {
  projectID: Accessor<string | undefined>;
  ticketID: Accessor<string | undefined>;
  selection: Selection;
  onEntry(entry: ConversationView["entries"][number]): void;
}) {
  const [stored, setStored] = createSignal<ConversationView>();
  const [answers, setAnswers] = createSignal<Record<string, { turnId: string; text: string }>>({});
  const streams = new Set<AbortController>();
  let generation = 0;
  let disposed = false;
  const current = () => {
    if (disposed) return undefined;
    const value = stored();
    return value &&
      value.projectId === input.projectID() &&
      (value.ticketId ?? undefined) === input.ticketID() &&
      (!input.selection.selected() ||
        (value.contextId ?? "original") === input.selection.selected())
      ? value
      : undefined;
  };
  function replace(value: ConversationView | undefined) {
    if (disposed) return;
    generation++;
    setStored(value);
  }
  function publish(value: ConversationView | undefined) {
    if (disposed) return;
    replace(value);
    if (value && !input.selection.selected())
      input.selection.setSelections((previous) => ({
        ...previous,
        [input.selection.scope()]: value.contextId ?? "original",
      }));
    input.selection.setReadyKey(
      `assistant:${input.selection.scope()}:${value?.contextId ?? input.selection.selected() ?? "original"}`,
    );
    for (const entry of value?.entries ?? []) input.onEntry(entry);
  }
  onCleanup(() => {
    disposed = true;
    for (const controller of streams) controller.abort();
    streams.clear();
  });
  return {
    current,
    replace,
    publish,
    invalidate() {
      generation++;
    },
    beginRead() {
      return ++generation;
    },
    currentRead(token: number) {
      return !disposed && token === generation;
    },
    provisional() {
      if (disposed) return undefined;
      const answer = answers()[input.selection.key()];
      if (!answer?.text) return undefined;
      const turn = current()?.turn;
      return turn?.id === answer.turnId &&
        !["pending", "dispatching", "running"].includes(turn.state)
        ? undefined
        : answer;
    },
    publishProvisional(scope: string, turnId: string, text: string) {
      if (!disposed) setAnswers((previous) => ({ ...previous, [scope]: { turnId, text } }));
    },
    clearProvisional(scope: string, turnId: string | undefined) {
      if (disposed) return;
      setAnswers((previous) => {
        if (previous[scope]?.turnId !== turnId) return previous;
        const next = { ...previous };
        delete next[scope];
        return next;
      });
    },
    trackStream(controller: AbortController) {
      if (disposed) controller.abort();
      else streams.add(controller);
      return () => {
        streams.delete(controller);
      };
    },
  };
}
