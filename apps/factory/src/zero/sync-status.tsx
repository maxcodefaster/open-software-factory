import type { ErroredQuery, ResultType } from "@rocicorp/zero";
import { createSignal, Show } from "solid-js";
import { useZeroConnection } from "../../../../packages/zero-solid/src";
import { useFactoryReadStatus } from "./reads";

type QueryStatus = {
  completeness(): ResultType;
  error(): ErroredQuery | undefined;
  retry(): void;
};

export function PlanningSyncStatus(props: {
  queries: readonly QueryStatus[];
  readError: string;
  onRetry(): Promise<void>;
}) {
  const connection = useZeroConnection();
  const reads = useFactoryReadStatus();
  const [retrying, setRetrying] = createSignal(false);
  const [retryError, setRetryError] = createSignal("");
  const message = () => {
    const state = connection.state()?.name;
    if (state === "needs-auth")
      return "Your session expired. Your drafts are retained. Sign in again to sync shared work.";
    if (state === "error" || state === "closed")
      return "Shared updates stopped. Showing the last known state.";
    if (state === "disconnected")
      return "You're offline. Showing cached work. Reconnect before saving shared changes.";
    if (props.queries.some((query) => query.error()) || reads?.errors().length)
      return "Some shared work could not load. Your drafts are retained.";
    if (props.readError || retryError()) return "Updates paused. Showing the last known state.";
    if (state === "connecting") return "Connecting to shared updates. Showing cached work.";
    if (props.queries.some((query) => query.completeness() === "unknown"))
      return "Loading shared work…";
    return "";
  };
  const canRetry = () =>
    ["error", "closed", "disconnected", "needs-auth"].includes(connection.state()?.name ?? "") ||
    Boolean(
      props.readError ||
        retryError() ||
        props.queries.some((query) => query.error()) ||
        reads?.errors().length,
    );
  async function retry() {
    if (connection.state()?.name === "needs-auth" || connection.state()?.name === "closed") {
      location.reload();
      return;
    }
    setRetrying(true);
    setRetryError("");
    try {
      await connection.reconnect();
      for (const query of props.queries) query.retry();
      reads?.retry();
      await props.onRetry();
    } catch (cause) {
      setRetryError(cause instanceof Error ? cause.message : "Shared updates could not reconnect.");
    } finally {
      setRetrying(false);
    }
  }
  return (
    <Show when={message()}>
      <div class="sync-notice" role="status" aria-label="Shared work sync">
        <span>{message()}</span>
        <Show when={canRetry() || connection.state()?.name === "needs-auth"}>
          <button
            type="button"
            class="quiet-button"
            disabled={
              retrying() && !["needs-auth", "closed"].includes(connection.state()?.name ?? "")
            }
            onClick={() => void retry()}
          >
            {connection.state()?.name === "needs-auth"
              ? "Sign in again"
              : retrying()
                ? "Retrying…"
                : "Retry sync"}
          </button>
        </Show>
      </div>
    </Show>
  );
}
