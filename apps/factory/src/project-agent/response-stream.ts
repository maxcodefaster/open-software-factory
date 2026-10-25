import type { ConversationStreamEvent } from "../api-contracts";
import { conversationViewSchema } from "../api-contracts";
import { CommandError } from "../command-error";
import type { ProjectResponseObserver } from "./controller";

// Disconnecting the browser detaches this observer, not the admitted paid work.
export function projectResponseStream(
  run: (observer: ProjectResponseObserver) => Promise<unknown>,
  signal: AbortSignal,
) {
  let detached = false;
  let pendingAnswer: Extract<ConversationStreamEvent, { type: "answer" }> | undefined;
  let sink: ReadableStreamDefaultController<ConversationStreamEvent>;
  const detach = (close: boolean) => {
    if (detached) return;
    detached = true;
    pendingAnswer = undefined;
    signal.removeEventListener("abort", abort);
    if (close) sink.close();
  };
  const abort = () => detach(true);
  const flush = (force = false) => {
    if (detached || !pendingAnswer || (!force && (sink.desiredSize ?? 0) <= 0)) return;
    const answer = pendingAnswer;
    pendingAnswer = undefined;
    sink.enqueue(answer);
  };
  return new ReadableStream<ConversationStreamEvent>({
    start(controller) {
      sink = controller;
      // Cancellation releases the observer and its wire, never the admitted
      // controller promise. Native nested-stream cancellation alone is not
      // a reliable substitute for the authenticated request's AbortSignal.
      if (signal.aborted) detach(true);
      else signal.addEventListener("abort", abort, { once: true });
      const send = (event: ConversationStreamEvent) => {
        if (detached) return;
        // Retain one latest answer while the admission or an earlier snapshot
        // fills the queue. Dropping it would lose a short answer completely.
        if (event.type === "answer") {
          pendingAnswer = event;
          flush();
          return;
        }
        if (event.type === "complete") flush(true);
        if (event.type === "error") pendingAnswer = undefined;
        controller.enqueue(event);
      };
      void (async () => {
        try {
          const result = await run({
            admitted: (turnId) => send({ type: "admitted", turnId }),
            answerText: (turnId, text) => send({ type: "answer", turnId, text }),
          });
          send({ type: "complete", conversation: conversationViewSchema.parse(result) });
        } catch (cause) {
          send({
            type: "error",
            error:
              cause instanceof CommandError
                ? cause.message
                : "The Project Agent could not finish its response.",
          });
        } finally {
          detach(true);
        }
      })();
    },
    pull() {
      flush();
    },
    cancel() {
      detach(false);
    },
  });
}
