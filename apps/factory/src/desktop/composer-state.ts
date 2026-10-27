import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
import type { createAgentCommandIds } from "../agent-command-ids";
import { readAttachmentContent, restoreAttachmentContent } from "../attachments/composer";
import { resizeComposer } from "../assistant-interaction";
export function createComposerState(input: {
  userID: string;
  commands: ReturnType<typeof createAgentCommandIds>;
  acknowledgements: Accessor<number>;
  onError(message: string): void;
}) {
  const [restoredMessageScope, setRestoredMessageScope] = createSignal<string>();

  const messageDrafts = new Map<string, string>();

  function restoreMessageDraft(element: HTMLTextAreaElement, scope: () => string) {
    let previousScope: string | undefined;
    let restoredCommand: ReturnType<typeof input.commands.latest>;
    const retain = () => {
      const key = previousScope ?? scope();
      if (readAttachmentContent(element)) messageDrafts.set(key, readAttachmentContent(element));
      else messageDrafts.delete(key);
      try {
        const storageKey = `chat-draft:${input.userID}:${key}`;
        if (readAttachmentContent(element))
          sessionStorage.setItem(storageKey, readAttachmentContent(element));
        else sessionStorage.removeItem(storageKey);
      } catch {
        /* Keep the visible draft when browser storage is unavailable. */
      }
    };
    const reset = () => queueMicrotask(retain);
    element.addEventListener("input", retain);
    element.form?.addEventListener("reset", reset);
    onCleanup(() => {
      retain();
      element.removeEventListener("input", retain);
      element.form?.removeEventListener("reset", reset);
    });
    createEffect(
      () => [scope(), input.acknowledgements()] as const,
      ([key]) => {
        try {
          if (previousScope === key) {
            if (
              restoredCommand &&
              input.commands.latest(key)?.commandId !== restoredCommand.commandId
            ) {
              if (readAttachmentContent(element) === restoredCommand.draft) {
                restoreAttachmentContent(element, "");
                messageDrafts.delete(key);
              }
              restoredCommand = undefined;
              setRestoredMessageScope(undefined);
            }
            return;
          }
          if (previousScope) retain();
          previousScope = key;
          restoredCommand = input.commands.latest(key);
          restoreAttachmentContent(
            element,
            messageDrafts.get(key) ??
              sessionStorage.getItem(`chat-draft:${input.userID}:${key}`) ??
              restoredCommand?.draft ??
              "",
          );
          queueMicrotask(() => resizeComposer(element));
          setRestoredMessageScope(restoredCommand?.draft ? key : undefined);
        } catch (cause) {
          input.onError(
            cause instanceof Error ? cause.message : "Browser recovery is unavailable.",
          );
        }
      },
    );
  }
  return {
    drafts: messageDrafts as ReadonlyMap<string, string>,
    restored: restoredMessageScope,
    bind: restoreMessageDraft,
  };
}
