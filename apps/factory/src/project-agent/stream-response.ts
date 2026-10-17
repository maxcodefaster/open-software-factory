import type { ConversationStreamEvent } from "../api-contracts";
import { conversationViewSchema } from "../api-contracts";
import { CommandError } from "../command-error";
import type { ProjectResponseObserver } from "./controller";

// Disconnecting the browser detaches this observer, not the admitted paid work.
export function projectResponseStream(
  run: (observer: ProjectResponseObserver) => Promise<unknown>,
) {
  let detached = false;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: ConversationStreamEvent) => {
        if (detached) return;
        // Text snapshots replace one another. A slow reader needs no transcript queue.
        if (event.type === "answer" && (controller.desiredSize ?? 0) <= 0) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
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
          if (!detached) controller.close();
        }
      })();
    },
    cancel() {
      detached = true;
    },
  });
  return new Response(body, {
    status: 201,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
