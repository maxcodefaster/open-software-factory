import { createEffect, createSignal } from "solid-js";
import { getInbox, markInboxItem } from "../server-functions/inbox";
import { serverCall } from "../server-functions/result";
import { observeFactoryRead } from "../zero/reads";
import type { InboxItem, InboxView } from "./contracts";

export function createInboxClient() {
  const [view, setView] = createSignal<InboxView>();
  const [loading, setLoading] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  let generation = 0,
    disposed = false;
  async function refresh() {
    const read = ++generation;
    setLoading(true);
    try {
      const next = await serverCall(getInbox({ data: [] }));
      if (!disposed && read === generation) {
        setView(next);
        setError("");
      }
    } catch (cause) {
      if (!disposed && read === generation)
        setError(cause instanceof Error ? cause.message : "Your Inbox could not be refreshed.");
    } finally {
      if (!disposed && read === generation) setLoading(false);
    }
  }
  async function mark(item: InboxItem, action: "read" | "unread" | "archive") {
    if (busy()) return;
    setBusy(true);
    generation++;
    try {
      await serverCall(
        markInboxItem({ data: [{ itemId: item.id, eventId: item.eventId, action }] }),
      );
      await refresh();
    } catch (cause) {
      setError(
        `${cause instanceof Error ? cause.message : "Your Inbox change could not be confirmed."} Refresh the Inbox, then repeat the action if needed.`,
      );
    } finally {
      setBusy(false);
    }
  }
  createEffect(
    () => true,
    () => {
      const wake = () => {
        if (!document.hidden && !busy()) void refresh();
      };
      void refresh();
      window.addEventListener("factory-review-changed", wake);
      return () => {
        disposed = true;
        generation++;
        window.removeEventListener("factory-review-changed", wake);
      };
    },
  );
  observeFactoryRead(
    () => "inbox",
    () => refresh(),
  );
  return { view, loading, busy, error, refresh, mark };
}

export function revealInboxSource(selector: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let observer: MutationObserver | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error) => {
      observer?.disconnect();
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve();
    };
    const aborted = () => finish(new Error("Inbox navigation was cancelled."));
    const inspect = () => {
      const target = document.querySelector<HTMLElement>(selector);
      if (!target || target.closest("[hidden]")) return false;
      const folded = target.closest("details");
      if (folded) folded.open = true;
      if (!target.getClientRects().length) return false;
      target.scrollIntoView({ block: "center", behavior: "instant" });
      target.focus({ preventScroll: true });
      finish();
      return true;
    };
    if (signal.aborted) return aborted();
    signal.addEventListener("abort", aborted, { once: true });
    if (inspect()) return;
    observer = new MutationObserver(inspect);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "open"],
    });
    timer = setTimeout(
      () => finish(new Error("The requested item is no longer visible. Refresh its source.")),
      15_000,
    );
  });
}
